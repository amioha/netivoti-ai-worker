import axios       from 'axios';
import pdfParse    from 'pdf-parse';
import mammoth     from 'mammoth';
import * as XLSX   from 'xlsx';
import Tesseract   from 'tesseract.js';
import { fromBuffer } from 'pdf2pic';
import logger      from './logger.js';

const OCR_LANG = process.env.OCR_LANGUAGE || 'heb+eng';

/* ============================================
   הורדת קובץ מ-URL
============================================ */
export async function downloadFile(url) {
  logger.debug(`Downloading: ${url}`);
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    headers: { 'User-Agent': 'shkifut-worker/1.0' },
  });
  return Buffer.from(res.data);
}

/* ============================================
   חילוץ טקסט ראשי — לפי סוג קובץ
============================================ */
export async function extractText(buffer, fileType, docId) {
  const type = (fileType || '').toLowerCase();

  if (type.includes('pdf')) {
    return extractFromPDF(buffer, docId);
  }
  if (type.includes('word') || type.includes('docx') || type.includes('doc')) {
    return extractFromWord(buffer, docId);
  }
  if (type.includes('excel') || type.includes('xlsx') || type.includes('xls') || type.includes('spreadsheet')) {
    return extractFromExcel(buffer, docId);
  }

  logger.warn(`Unknown file type: ${fileType}`, { docId });
  return { pages: [], fullText: '', method: 'unknown' };
}

/* ============================================
   PDF — חילוץ טקסט + OCR fallback
============================================ */
async function extractFromPDF(buffer, docId) {
  // נסה חילוץ טקסט רגיל קודם
  try {
    const data = await pdfParse(buffer, { max: 0 });
    const text = data.text?.trim();

    if (text && text.length > 100) {
      logger.info(`PDF text extracted directly (${text.length} chars)`, { docId });
      const pages = splitIntoPages(text, data.numpages);
      return { pages, fullText: text, method: 'direct', pageCount: data.numpages };
    }
  } catch (err) {
    logger.warn(`PDF direct extract failed: ${err.message}`, { docId });
  }

  // Fallback — OCR
  logger.info('PDF appears scanned, running OCR...', { docId });
  return ocrPDF(buffer, docId);
}

/* ============================================
   OCR — המרת PDF לתמונות + Tesseract
============================================ */
async function ocrPDF(buffer, docId) {
  const pages    = [];
  let   fullText = '';

  try {
    // המרה לתמונות — עמוד אחד בכל פעם
    const converter = fromBuffer(buffer, {
      density:  200,
      format:   'png',
      width:    1700,
      height:   2200,
    });

    // גלה כמה עמודים יש
    let pageCount = 1;
    try {
      const info = await pdfParse(buffer, { max: 1 });
      pageCount  = info.numpages || 1;
    } catch {}

    logger.info(`OCR: processing ${pageCount} pages`, { docId });

    for (let p = 1; p <= pageCount; p++) {
      try {
        logger.debug(`OCR page ${p}/${pageCount}`, { docId });

        const image = await converter(p, { responseType: 'buffer' });
        if (!image?.buffer) continue;

        const { data: { text } } = await Tesseract.recognize(
          image.buffer,
          OCR_LANG,
          { logger: () => {} }  // suppress verbose output
        );

        const cleaned = text?.trim() || '';
        if (cleaned) {
          pages.push({ page: p, text: cleaned });
          fullText += cleaned + '\n';
        }
      } catch (pageErr) {
        logger.warn(`OCR page ${p} failed: ${pageErr.message}`, { docId });
      }
    }

    logger.info(`OCR complete: ${pages.length} pages, ${fullText.length} chars`, { docId });
    return { pages, fullText, method: 'ocr', pageCount };

  } catch (err) {
    logger.error(`OCR failed: ${err.message}`, { docId });
    return { pages: [], fullText: '', method: 'ocr_failed', pageCount: 0 };
  }
}

/* ============================================
   Word (DOCX)
============================================ */
async function extractFromWord(buffer, docId) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text   = result.value?.trim() || '';
    logger.info(`Word extracted: ${text.length} chars`, { docId });
    return {
      pages:     [{ page: 1, text }],
      fullText:  text,
      method:    'word',
      pageCount: 1,
    };
  } catch (err) {
    logger.error(`Word extraction failed: ${err.message}`, { docId });
    return { pages: [], fullText: '', method: 'word_failed', pageCount: 0 };
  }
}

/* ============================================
   Excel (XLSX/XLS)
============================================ */
async function extractFromExcel(buffer, docId) {
  try {
    const wb   = XLSX.read(buffer, { type: 'buffer' });
    let   text = '';
    const pages = [];

    wb.SheetNames.forEach((name, i) => {
      const sheet   = wb.Sheets[name];
      const csv     = XLSX.utils.sheet_to_csv(sheet);
      const cleaned = csv.trim();
      if (cleaned) {
        text += `\n--- גיליון: ${name} ---\n${cleaned}\n`;
        pages.push({ page: i + 1, text: `גיליון: ${name}\n${cleaned}` });
      }
    });

    logger.info(`Excel extracted: ${wb.SheetNames.length} sheets, ${text.length} chars`, { docId });
    return { pages, fullText: text.trim(), method: 'excel', pageCount: wb.SheetNames.length };

  } catch (err) {
    logger.error(`Excel extraction failed: ${err.message}`, { docId });
    return { pages: [], fullText: '', method: 'excel_failed', pageCount: 0 };
  }
}

/* ============================================
   עזר — חלוקת טקסט לעמודים לפי מספר עמודים
============================================ */
function splitIntoPages(text, numPages) {
  if (numPages <= 1) return [{ page: 1, text }];

  const charsPerPage = Math.ceil(text.length / numPages);
  const pages        = [];

  for (let p = 0; p < numPages; p++) {
    const start   = p * charsPerPage;
    const end     = Math.min(start + charsPerPage, text.length);
    const content = text.slice(start, end).trim();
    if (content) pages.push({ page: p + 1, text: content });
  }

  return pages;
}
