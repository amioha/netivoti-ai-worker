import axios       from 'axios';
import pdfParse    from 'pdf-parse';
import mammoth     from 'mammoth';
import * as XLSX   from 'xlsx';
import Tesseract   from 'tesseract.js';
import { fromBuffer } from 'pdf2pic';
import logger      from './logger.js';

const OCR_LANG      = process.env.OCR_LANGUAGE   || 'heb+eng';
const OCR_TIMEOUT   = parseInt(process.env.OCR_TIMEOUT_MS) || 3 * 60 * 1000; // 3 דקות לעמוד

export async function downloadFile(url) {
  logger.debug(`Downloading: ${url}`);
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    headers: { 'User-Agent': 'shkifut-worker/1.0' },
  });
  return Buffer.from(res.data);
}

export async function extractText(buffer, fileType, docId) {
  const type = (fileType || '').toLowerCase();
  try {
    if (type.includes('pdf'))                                              return await extractFromPDF(buffer, docId);
    if (type.includes('word') || type.includes('docx') || type.includes('doc')) return await extractFromWord(buffer, docId);
    if (type.includes('excel') || type.includes('xlsx') || type.includes('xls') || type.includes('spreadsheet')) return await extractFromExcel(buffer, docId);
    logger.warn(`Unknown file type: ${fileType}`, { docId });
    return { pages: [], fullText: '', method: 'unknown', pageCount: 0 };
  } catch (err) {
    // תפוס כל שגיאה ברמה הגבוהה ביותר
    logger.error(`extractText failed: ${err.message}`, { docId });
    throw err; // העבר למעלה — processor יטפל
  }
}

async function extractFromPDF(buffer, docId) {
  // נסה חילוץ ישיר
  try {
    const data = await Promise.race([
      pdfParse(buffer, { max: 0 }),
      _timeout(30_000, 'pdf-parse timeout'),
    ]);
    const text = data.text?.trim();
    if (text && text.length > 100) {
      logger.info(`PDF direct: ${text.length} chars`, { docId });
      return {
        pages:     splitIntoPages(text, data.numpages),
        fullText:  text,
        method:    'direct',
        pageCount: data.numpages,
      };
    }
  } catch (err) {
    // אל תקרוס — נסה OCR
    logger.warn(`PDF direct failed: ${err.message} — trying OCR`, { docId });
  }

  // OCR
  return ocrPDF(buffer, docId);
}

async function ocrPDF(buffer, docId) {
  const pages    = [];
  let   fullText = '';
  let   pageCount = 1;

  try {
    try {
      const info = await Promise.race([
        pdfParse(buffer, { max: 1 }),
        _timeout(15_000, 'page count timeout'),
      ]);
      pageCount = info.numpages || 1;
    } catch { pageCount = 1; }

    logger.info(`OCR: ${pageCount} pages`, { docId });

    const converter = fromBuffer(buffer, {
      density: 150, // נמוך יותר — מהיר יותר, פחות זיכרון
      format:  'png',
      width:   1400,
      height:  1980,
    });

    for (let p = 1; p <= pageCount; p++) {
      try {
        logger.debug(`OCR page ${p}/${pageCount}`, { docId });

        const image = await Promise.race([
          converter(p, { responseType: 'buffer' }),
          _timeout(OCR_TIMEOUT, `OCR page ${p} timeout`),
        ]);

        if (!image?.buffer) continue;

        const { data: { text } } = await Promise.race([
          Tesseract.recognize(image.buffer, OCR_LANG, { logger: () => {} }),
          _timeout(OCR_TIMEOUT, `Tesseract page ${p} timeout`),
        ]);

        const cleaned = text?.trim() || '';
        if (cleaned) {
          pages.push({ page: p, text: cleaned });
          fullText += cleaned + '\n';
        }

      } catch (pageErr) {
        // עמוד בודד נכשל — דלג וממשיך
        logger.warn(`OCR page ${p} failed: ${pageErr.message} — skipping`, { docId });
      }
    }

    if (!fullText.trim()) {
      throw new Error('OCR produced no text — file may be corrupted or unreadable');
    }

    logger.info(`OCR done: ${pages.length} pages, ${fullText.length} chars`, { docId });
    return { pages, fullText, method: 'ocr', pageCount };

  } catch (err) {
    logger.error(`OCR failed: ${err.message}`, { docId });
    throw err;
  }
}

async function extractFromWord(buffer, docId) {
  try {
    const result = await Promise.race([
      mammoth.extractRawText({ buffer }),
      _timeout(60_000, 'Word extraction timeout'),
    ]);
    const text = result.value?.trim() || '';
    if (!text) throw new Error('Word file produced no text');
    logger.info(`Word: ${text.length} chars`, { docId });
    return { pages: [{ page: 1, text }], fullText: text, method: 'word', pageCount: 1 };
  } catch (err) {
    logger.error(`Word failed: ${err.message}`, { docId });
    throw err;
  }
}

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
    if (!text.trim()) throw new Error('Excel file produced no text');
    logger.info(`Excel: ${wb.SheetNames.length} sheets`, { docId });
    return { pages, fullText: text.trim(), method: 'excel', pageCount: wb.SheetNames.length };
  } catch (err) {
    logger.error(`Excel failed: ${err.message}`, { docId });
    throw err;
  }
}

function splitIntoPages(text, numPages) {
  if (numPages <= 1) return [{ page: 1, text }];
  const cpp   = Math.ceil(text.length / numPages);
  const pages = [];
  for (let p = 0; p < numPages; p++) {
    const content = text.slice(p * cpp, (p + 1) * cpp).trim();
    if (content) pages.push({ page: p + 1, text: content });
  }
  return pages;
}

const _timeout = (ms, msg) =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
