import logger                              from './logger.js';
import { downloadFile, extractText }       from './extractor.js';
import { splitToChunks, extractMetadata } from './chunker.js';
import { addEmbeddingsToChunks }          from './embedder.js';
import {
  updateQueueStatus,
  incrementAttempt,
  updateDocument,
  saveChunks,
  deleteOldChunks,
  logError,
} from './supabase.js';

const MAX_RETRIES       = parseInt(process.env.MAX_RETRIES) || 3;
const DOC_TIMEOUT_MS    = parseInt(process.env.DOC_TIMEOUT_MS) || 8 * 60 * 1000; // 8 דקות

/* ============================================
   עיבוד מסמך עם timeout מחייב
============================================ */
export async function processDocument(queueItem) {
  const { id: queueId, document_id, attempts } = queueItem;
  const doc = queueItem.nv_documents;

  if (!doc) {
    logger.error(`Queue ${queueId}: document not found`);
    await updateQueueStatus(queueId, 'error', 'Document not found');
    return;
  }

  const docId = doc.id;

  // בדיקת ניסיונות — אל תנסה יותר מדי
  if (attempts >= MAX_RETRIES) {
    logger.error(`Max retries (${MAX_RETRIES}) reached for doc ${docId}`, { docId });
    await updateQueueStatus(queueId, 'error', `Max retries exceeded`);
    await updateDocument(docId, { status: 'error', last_error: 'Max retries exceeded' });
    return;
  }

  logger.info(`Starting: "${doc.title}" (attempt ${attempts + 1}/${MAX_RETRIES})`, { docId });
  await incrementAttempt(queueId, attempts);
  await updateDocument(docId, { status: 'processing' });

  try {
    // timeout מחייב — אם המסמך לא מסתיים תוך 8 דקות סמן כשגיאה
    await Promise.race([
      _processDoc(queueId, docId, doc),
      _timeout(DOC_TIMEOUT_MS, docId),
    ]);
  } catch (err) {
    await _handleError(err, queueId, docId, doc.title, attempts);
  }
}

/* ============================================
   Pipeline עיבוד פנימי
============================================ */
async function _processDoc(queueId, docId, doc) {
  const start = Date.now();

  /* 1. הורדה */
  logger.info(`[1/5] Downloading...`, { docId });
  if (!doc.file_url) throw new Error('file_url is empty');

  let buffer;
  try {
    buffer = await downloadFile(doc.file_url);
  } catch (err) {
    throw new Error(`Download failed: ${err.message}`);
  }
  logger.info(`[1/5] Downloaded ${(buffer.length/1024).toFixed(1)}KB`, { docId });

  /* 2. חילוץ טקסט — עם try/catch נפרד */
  logger.info(`[2/5] Extracting text (${doc.file_type})...`, { docId });
  let extracted;
  try {
    extracted = await extractText(buffer, doc.file_type, docId);
  } catch (err) {
    // קובץ פגום — סמן וצא
    throw new Error(`Text extraction failed (corrupted file?): ${err.message}`);
  }

  const { pages, fullText, method, pageCount } = extracted;

  if (!fullText || fullText.trim().length < 10) {
    throw new Error(`No text extracted (method: ${method}) — file may be corrupted or empty`);
  }
  logger.info(`[2/5] ${fullText.length} chars, ${pageCount} pages (${method})`, { docId });

  /* 3. מטא-דאטה */
  logger.info(`[3/5] Extracting metadata...`, { docId });
  let meta;
  try {
    meta = extractMetadata(fullText);
  } catch (err) {
    meta = { doc_type: 'other', year: null, contractor: null, tender_num: null, neighborhood: null, amounts: [] };
    logger.warn(`Metadata extraction failed: ${err.message}`, { docId });
  }

  /* 4. חלוקה לקטעים */
  logger.info(`[4/5] Chunking...`, { docId });
  let rawChunks;
  try {
    rawChunks = splitToChunks(pages, {
      id: docId, title: doc.title, file_url: doc.file_url,
      year: meta.year, contractor: meta.contractor,
      doc_type: meta.doc_type, tender_num: meta.tender_num,
    });
  } catch (err) {
    throw new Error(`Chunking failed: ${err.message}`);
  }

  if (!rawChunks.length) {
    throw new Error('No chunks created — text may be too short');
  }
  logger.info(`[4/5] ${rawChunks.length} chunks`, { docId });

  /* 5. Embeddings */
  logger.info(`[5/5] Creating embeddings...`, { docId });
  let chunksWithEmb;
  try {
    chunksWithEmb = await addEmbeddingsToChunks(rawChunks);
  } catch (err) {
    throw new Error(`Embeddings failed: ${err.message}`);
  }

  if (!chunksWithEmb.length) {
    throw new Error('No embeddings created');
  }
  logger.info(`[5/5] ${chunksWithEmb.length}/${rawChunks.length} embeddings`, { docId });

  /* שמירה */
  await deleteOldChunks(docId);
  await saveChunks(chunksWithEmb);
  await updateDocument(docId, {
    status:       'done',
    ocr_done:     method === 'ocr',
    page_count:   pageCount,
    doc_type:     meta.doc_type,
    year:         meta.year,
    contractor:   meta.contractor,
    tender_num:   meta.tender_num,
    neighborhood: meta.neighborhood,
    chunk_count:  chunksWithEmb.length,
    char_count:   fullText.length,
    last_error:   null,
    metadata: {
      extraction_method: method,
      chunk_count:       chunksWithEmb.length,
      processed_at:      new Date().toISOString(),
      amounts:           meta.amounts,
    },
  });
  await updateQueueStatus(queueId, 'done');

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  logger.info(`✅ Done: "${doc.title}" — ${chunksWithEmb.length} chunks in ${secs}s`, { docId });
}

/* ============================================
   Timeout — זורק שגיאה אחרי X מילישניות
============================================ */
function _timeout(ms, docId) {
  return new Promise((_, reject) =>
    setTimeout(() => {
      reject(new Error(`Timeout after ${ms/1000/60} minutes`));
    }, ms)
  );
}

/* ============================================
   טיפול בשגיאות — מחליט אם לנסות שוב
============================================ */
async function _handleError(err, queueId, docId, title, attempts) {
  const msg = err.message || 'Unknown error';
  logger.error(`❌ Failed "${title}": ${msg}`, { docId });

  // שגיאות שלא כדאי לנסות שוב
  const noRetryPatterns = [
    'corrupted', 'truncated', 'read image', 'findFileFormatStream',
    'Cannot read', 'invalid pdf', 'bad pdf', 'empty', 'No text extracted',
    'file_url is empty', 'Download failed',
  ];
  const isCorrupted = noRetryPatterns.some(p =>
    msg.toLowerCase().includes(p.toLowerCase())
  );

  if (isCorrupted) {
    // קובץ פגום — אל תנסה שוב, סמן כשגיאה מיד
    logger.warn(`Corrupted/bad file — marking as failed immediately`, { docId });
    await updateQueueStatus(queueId, 'error', msg);
    await updateDocument(docId, { status: 'error', last_error: msg });
    return;
  }

  // שגיאות אחרות — נסה שוב אם לא הגענו למקסימום
  const willRetry = attempts + 1 < MAX_RETRIES;
  await updateQueueStatus(queueId, willRetry ? 'pending' : 'error', msg);
  await updateDocument(docId, {
    status:     willRetry ? 'pending' : 'error',
    last_error: msg,
  });

  if (willRetry) {
    logger.info(`Will retry (${attempts + 1}/${MAX_RETRIES})`, { docId });
  } else {
    logger.error(`Giving up after ${MAX_RETRIES} attempts`, { docId });
  }

  try { await logError(docId, queueId, err); } catch {}
}
