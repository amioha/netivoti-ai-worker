import axios    from 'axios';
import pdfParse from 'pdf-parse';
import mammoth  from 'mammoth';
import * as XLSX from 'xlsx';
import logger   from './logger.js';

const OCR_LANG    = process.env.OCR_LANGUAGE || 'heb+eng';
const USE_OCR     = process.env.USE_OCR !== 'false'; // true by default

export async function downloadFile(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 90_000,
    headers: { 'User-Agent': 'shkifut-worker/1.0' },
  });
  return Buffer.from(res.data);
}

export async function extractText(buffer, fileType, docId) {
  const type = (fileType || '').toLowerCase();
  if (type.includes('pdf'))    return extractFromPDF(buffer, docId);
  if (type.includes('word') || type.includes('docx') || type.includes('doc')) return extractFromWord(buffer, docId);
  if (type.includes('excel') || type.includes('xlsx') || type.includes('xls')) return extractFromExcel(buffer, docId);
  logger.warn(`Unknown file type: ${fileType}`, { docId });
  return { pages: [], fullText: '', method: 'unknown', pageCount: 0 };
}

/* ============================================
   PDF — שלושה שלבים:
   1. pdfParse ישיר
   2. pdfParse עמוד-עמוד
   3. OCR דרך Tesseract (אם זמין)
============================================ */
async function extractFromPDF(buffer, docId) {

  /* שלב 1 — חילוץ טקסט ישיר */
  try {
    const data = await withTimeout(pdfParse(buffer, { max: 0 }), 60_000);
    const text = data.text?.trim() || '';
    if (text.length > 100) {
      logger.info(`PDF direct: ${text.length} chars, ${data.numpages} pages`, { docId });
      return {
        pages:     splitIntoPages(text, data.numpages),
        fullText:  text,
        method:    'direct',
        pageCount: data.numpages || 1,
      };
    }
    logger.info(`PDF direct: text too short (${text.length} chars) — trying OCR`, { docId });
  } catch (err) {
    logger.warn(`PDF direct failed: ${err.message}`, { docId });
  }

  /* שלב 2 — OCR דרך Tesseract */
  if (USE_OCR) {
    const ocrResult = await tryOCRWithTesseract(buffer, docId);
    if (ocrResult && ocrResult.fullText.length > 50) {
      return ocrResult;
    }
  }

  /* שלב 3 — כישלון מוחלט */
  throw new Error('PDF has no extractable text and OCR failed or disabled');
}

/* ============================================
   OCR דרך Tesseract.js — בטוח לחלוטין
   משתמש ב-canvas/jimp לרינדור עמודים
============================================ */
async function tryOCRWithTesseract(buffer, docId) {
  try {
    // נסה לייבא Tesseract
    let Tesseract;
    try {
      const mod = await import('tesseract.js');
      Tesseract = mod.default || mod;
    } catch (e) {
      logger.warn(`Tesseract not available: ${e.message}`, { docId });
      return null;
    }

    // קבל מספר עמודים
    let pageCount = 1;
    try {
      const info = await withTimeout(pdfParse(buffer, { max: 1 }), 15_000);
      pageCount = Math.min(info.numpages || 1, 30); // מקסימום 30 עמודים
    } catch { pageCount = 1; }

    logger.info(`OCR via Tesseract: ${pageCount} pages`, { docId });

    // נסה להשיג תמונות דרך pdf2pic אם זמין
    let images = [];
    try {
      const { fromBuffer } = await import('pdf2pic');
      const converter = fromBuffer(buffer, {
        density: 100,
        format:  'png',
        width:   1200,
        height:  1600,
      });

      for (let p = 1; p <= pageCount; p++) {
        try {
          const img = await withTimeout(
            new Promise((resolve) => {
              setImmediate(async () => {
                try {
                  const r = await converter(p, { responseType: 'buffer' });
                  resolve(r?.buffer || null);
                } catch { resolve(null); }
              });
            }),
            60_000
          );
          if (img) images.push({ page: p, buffer: img });
        } catch { /* דלג על עמוד */ }
      }
    } catch (e) {
      logger.warn(`pdf2pic not available: ${e.message} — OCR skipped`, { docId });
      return null;
    }

    if (!images.length) {
      logger.warn(`No images from PDF for OCR`, { docId });
      return null;
    }

    // OCR על כל עמוד
    const pages    = [];
    let   fullText = '';

    for (const { page, buffer: imgBuf } of images) {
      try {
        const { data: { text } } = await withTimeout(
          Tesseract.recognize(imgBuf, OCR_LANG, { logger: () => {} }),
          120_000
        );
        const cleaned = text?.trim() || '';
        if (cleaned.length > 10) {
          pages.push({ page, text: cleaned });
          fullText += cleaned + '\n';
          logger.debug(`OCR page ${page}: ${cleaned.length} chars`, { docId });
        }
      } catch (pageErr) {
        logger.warn(`OCR page ${page} failed: ${pageErr.message}`, { docId });
      }
    }

    if (!fullText.trim()) return null;

    logger.info(`OCR done: ${pages.length}/${pageCount} pages, ${fullText.length} chars`, { docId });
    return { pages, fullText, method: 'ocr', pageCount };

  } catch (err) {
    logger.error(`OCR error: ${err.message}`, { docId });
    return null;
  }
}

/* ---- Word ---- */
async function extractFromWord(buffer, docId) {
  try {
    const result = await withTimeout(mammoth.extractRawText({ buffer }), 60_000);
    const text   = result.value?.trim() || '';
    if (!text) throw new Error('No text in Word file');
    logger.info(`Word: ${text.length} chars`, { docId });
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
    logger.info(`Excel: ${wb.SheetNames.length} sheets`, { docId });
    return { pages, fullText: text.trim(), method: 'excel', pageCount: wb.SheetNames.length };
  } catch (err) {
    logger.error(`Excel failed: ${err.message}`, { docId });
    throw err;
  }
}

/* ---- helpers ---- */
function splitIntoPages(text, n) {
  if (!n || n <= 1) return [{ page: 1, text }];
  const cpp = Math.ceil(text.length / n);
  return Array.from({ length: n }, (_, i) => ({
    page: i + 1,
    text: text.slice(i * cpp, (i+1) * cpp).trim(),
  })).filter(p => p.text);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}
