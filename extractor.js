import axios    from 'axios';
import pdfParse from 'pdf-parse';
import mammoth  from 'mammoth';
import * as XLSX from 'xlsx';
import Tesseract from 'tesseract.js';
import { createWorker } from 'tesseract.js';
import logger   from './logger.js';

const OCR_LANG = process.env.OCR_LANGUAGE || 'heb+eng';

export async function downloadFile(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    headers: { 'User-Agent': 'shkifut-worker/1.0' },
  });
  return Buffer.from(res.data);
}

export async function extractText(buffer, fileType, docId) {
  const type = (fileType || '').toLowerCase();
  if (type.includes('pdf'))    return extractFromPDF(buffer, docId);
  if (type.includes('word') || type.includes('docx') || type.includes('doc')) return extractFromWord(buffer, docId);
  if (type.includes('excel') || type.includes('xlsx') || type.includes('xls')) return extractFromExcel(buffer, docId);
  return { pages: [], fullText: '', method: 'unknown', pageCount: 0 };
}

/* ============================================
   PDF — ללא pdf2pic לחלוטין
   משתמש רק ב-pdfParse לטקסט ישיר
   OCR דרך Tesseract עם buffer ישיר (אם יש תמיכה)
============================================ */
async function extractFromPDF(buffer, docId) {

  // שלב 1 — נסה חילוץ טקסט ישיר
  try {
    const data = await withTimeout(
      pdfParse(buffer, { max: 0 }),
      30_000
    );
    const text = data.text?.trim() || '';
    if (text.length > 50) {
      logger.info(`PDF direct: ${text.length} chars, ${data.numpages} pages`, { docId });
      return {
        pages:     splitIntoPages(text, data.numpages),
        fullText:  text,
        method:    'direct',
        pageCount: data.numpages || 1,
      };
    }
    logger.info(`PDF direct: text too short (${text.length}) — trying page-by-page`, { docId });
  } catch (err) {
    logger.warn(`PDF direct failed: ${err.message}`, { docId });
  }

  // שלב 2 — נסה עמוד אחד עמוד (max:1) כדי לקבל לפחות חלק
  try {
    const pages    = [];
    let   fullText = '';
    let   pageCount = 1;

    try {
      const info = await withTimeout(pdfParse(buffer, { max: 1 }), 10_000);
      pageCount  = info.numpages || 1;
    } catch { pageCount = 1; }

    // עבד עמוד-עמוד דרך pdfParse עם max:1 ו-pagerender callback
    // זה בטוח כי לא משתמש ב-pdf2pic שגורם לcrash
    for (let p = 1; p <= Math.min(pageCount, 100); p++) {
      try {
        const pageData = await withTimeout(
          pdfParse(buffer, {
            max: 1,
            // pagerender callback — מחלץ רק את העמוד הספציפי
            pagerender: (pageData) => {
              return pageData.getTextContent().then(tc =>
                tc.items.map(item => item.str).join(' ')
              ).catch(() => '');
            },
            // דלג לעמוד הנכון
            firstPage: p,
          }),
          15_000
        );
        const text = pageData.text?.trim() || '';
        if (text.length > 10) {
          pages.push({ page: p, text });
          fullText += text + '\n';
        }
      } catch (pageErr) {
        logger.debug(`Page ${p} failed: ${pageErr.message} — skipping`, { docId });
      }
    }

    if (fullText.trim().length > 50) {
      logger.info(`PDF page-by-page: ${pages.length}/${pageCount} pages, ${fullText.length} chars`, { docId });
      return { pages, fullText, method: 'direct_pages', pageCount };
    }
  } catch (err) {
    logger.warn(`PDF page-by-page failed: ${err.message}`, { docId });
  }

  // שלב 3 — קובץ סרוק ללא טקסט
  // pdf2pic גורם לcrash — לא משתמשים בו
  // מסמנים כ-ocr_required וממשיכים
  logger.warn(`PDF has no extractable text — marking as ocr_required`, { docId });
  throw new Error('PDF requires OCR but pdf2pic is disabled due to stability issues. Mark as ocr_required.');
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
      if (csv) {
        text += `\n--- ${name} ---\n${csv}\n`;
        pages.push({ page: i + 1, text: `${name}\n${csv}` });
      }
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
    text: text.slice(i * cpp, (i + 1) * cpp).trim(),
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
