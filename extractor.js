import axios       from 'axios';
import pdfParse    from 'pdf-parse';
import mammoth     from 'mammoth';
import * as XLSX   from 'xlsx';
import Tesseract   from 'tesseract.js';
import logger      from './logger.js';

const OCR_LANG = process.env.OCR_LANGUAGE || 'heb+eng';

/* ---- download ---- */
export async function downloadFile(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    headers: { 'User-Agent': 'shkifut-worker/1.0' },
  });
  return Buffer.from(res.data);
}

/* ---- main entry ---- */
export async function extractText(buffer, fileType, docId) {
  const type = (fileType || '').toLowerCase();
  if (type.includes('pdf'))                                                    return extractFromPDF(buffer, docId);
  if (type.includes('word') || type.includes('docx') || type.includes('doc')) return extractFromWord(buffer, docId);
  if (type.includes('excel') || type.includes('xlsx') || type.includes('xls') || type.includes('spreadsheet')) return extractFromExcel(buffer, docId);
  return { pages: [], fullText: '', method: 'unknown', pageCount: 0 };
}

/* ---- PDF ---- */
async function extractFromPDF(buffer, docId) {
  // נסה חילוץ ישיר קודם
  try {
    const data = await withTimeout(pdfParse(buffer, { max: 0 }), 30_000);
    const text = data.text?.trim();
    if (text && text.length > 100) {
      logger.info(`PDF direct: ${text.length} chars`, { docId });
      return { pages: splitIntoPages(text, data.numpages), fullText: text, method: 'direct', pageCount: data.numpages };
    }
  } catch (err) {
    logger.warn(`PDF direct failed: ${err.message}`, { docId });
  }

  // OCR — אם גם זה נכשל, החזר תוצאה ריקה עם שגיאה
  return ocrPDF(buffer, docId);
}

/* ---- OCR ---- */
async function ocrPDF(buffer, docId) {
  let pageCount = 1;

  // קבל מספר עמודים בלבד
  try {
    const info = await withTimeout(pdfParse(buffer, { max: 1 }), 10_000);
    pageCount = Math.min(info.numpages || 1, 50); // מקסימום 50 עמודים
  } catch { pageCount = 1; }

  logger.info(`OCR: attempting ${pageCount} pages`, { docId });

  // ייבוא דינמי של pdf2pic — כדי שאפשר לתפוס שגיאות ייבוא
  let fromBuffer;
  try {
    const mod = await import('pdf2pic');
    fromBuffer = mod.fromBuffer;
  } catch (err) {
    throw new Error(`pdf2pic import failed: ${err.message}`);
  }

  // בנה converter בתוך try/catch
  let converter;
  try {
    converter = fromBuffer(buffer, {
      density: 120,
      format:  'png',
      width:   1200,
      height:  1700,
    });
  } catch (err) {
    throw new Error(`PDF converter failed (corrupted file?): ${err.message}`);
  }

  const pages    = [];
  let   fullText = '';

  for (let p = 1; p <= pageCount; p++) {
    // כל עמוד עטוף לחלוטין
    try {
      const image = await withTimeout(
        safeConvertPage(converter, p),
        90_000 // 90 שניות לעמוד
      );

      if (!image) {
        logger.debug(`Page ${p}: no image, skipping`, { docId });
        continue;
      }

      const text = await withTimeout(
        safeOCR(image, OCR_LANG),
        90_000
      );

      if (text) {
        pages.push({ page: p, text });
        fullText += text + '\n';
        logger.debug(`Page ${p}: ${text.length} chars`, { docId });
      }

    } catch (pageErr) {
      // עמוד נכשל — דלג וממשיך
      logger.warn(`Page ${p} failed: ${pageErr.message} — skipping`, { docId });
    }
  }

  if (!fullText.trim()) {
    throw new Error('OCR produced no text — file is corrupted or unreadable');
  }

  logger.info(`OCR done: ${pages.length}/${pageCount} pages, ${fullText.length} chars`, { docId });
  return { pages, fullText, method: 'ocr', pageCount };
}

/* ---- המרת עמוד בודד — בטוחה ---- */
async function safeConvertPage(converter, pageNum) {
  return new Promise((resolve) => {
    // setTimeout כדי לתפוס שגיאות sync שנזרקות מחוץ ל-promise
    setImmediate(async () => {
      try {
        const result = await converter(pageNum, { responseType: 'buffer' });
        resolve(result?.buffer || null);
      } catch (err) {
        // לא reject — resolve עם null כדי שהלולאה תמשיך
        resolve(null);
      }
    });
  });
}

/* ---- OCR בודד — בטוח ---- */
async function safeOCR(imageBuffer, lang) {
  return new Promise((resolve) => {
    setImmediate(async () => {
      try {
        const { data: { text } } = await Tesseract.recognize(
          imageBuffer, lang, { logger: () => {} }
        );
        resolve(text?.trim() || '');
      } catch (err) {
        resolve('');
      }
    });
  });
}

/* ---- Word ---- */
async function extractFromWord(buffer, docId) {
  try {
    const result = await withTimeout(mammoth.extractRawText({ buffer }), 60_000);
    const text   = result.value?.trim() || '';
    if (!text) throw new Error('No text in Word file');
    return { pages: [{ page: 1, text }], fullText: text, method: 'word', pageCount: 1 };
  } catch (err) {
    logger.error(`Word failed: ${err.message}`, { docId });
    throw err;
  }
}

/* ---- Excel ---- */
async function extractFromExcel(buffer, docId) {
  try {
    const wb    = XLSX.read(buffer, { type: 'buffer' });
    let   text  = '';
    const pages = [];
    wb.SheetNames.forEach((name, i) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]).trim();
      if (csv) { text += `\n--- ${name} ---\n${csv}\n`; pages.push({ page: i+1, text: `${name}\n${csv}` }); }
    });
    if (!text.trim()) throw new Error('No text in Excel file');
    return { pages, fullText: text.trim(), method: 'excel', pageCount: wb.SheetNames.length };
  } catch (err) {
    logger.error(`Excel failed: ${err.message}`, { docId });
    throw err;
  }
}

/* ---- עזרים ---- */
function splitIntoPages(text, n) {
  if (n <= 1) return [{ page: 1, text }];
  const cpp   = Math.ceil(text.length / n);
  return Array.from({ length: n }, (_, i) => ({
    page: i + 1,
    text: text.slice(i * cpp, (i+1) * cpp).trim(),
  })).filter(p => p.text);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms)),
  ]);
}
