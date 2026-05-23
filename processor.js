import logger                              from './logger.js';
import { downloadFile, extractText }       from './extractor.js';
import { splitToChunks, extractMetadata } from './chunker.js';
import { addEmbeddingsToChunks }          from './embedder.js';
import {
  updateQueueStatus, incrementAttempt,
  updateDocument, saveChunks,
  deleteOldChunks, logError,
} from './supabase.js';

const MAX_RETRIES    = parseInt(process.env.MAX_RETRIES)    || 3;
const DOC_TIMEOUT_MS = parseInt(process.env.DOC_TIMEOUT_MS) || 25 * 60 * 1000;

// שגיאות שלא כדאי לנסות שוב — מסמן error מיד
const NO_RETRY_PATTERNS = [
  'corrupted', 'truncated', 'bad pdf', 'invalid pdf',
  'file_url is empty',
  'ocr_required',           // PDF סרוק — אין OCR זמין
  'No text',
  'has no extractable text',
  'unreadable',
];

export async function processDocument(queueItem) {
  const { id: queueId, document_id, attempts } = queueItem;
  const doc = queueItem.nv_documents;

  if (!doc) {
    logger.error(`Queue ${queueId}: document not found`);
    await updateQueueStatus(queueId, 'error', 'Document not found');
    return;
  }

  const docId = doc.id;

  // הגעה למקסימום ניסיונות — סמן error ועבור הלאה
  if (attempts >= MAX_RETRIES) {
    logger.error(`[doc:${docId}] Max retries (${MAX_RETRIES}) reached — marking error and moving on`);
    await updateQueueStatus(queueId, 'error', 'Max retries exceeded');
    await updateDocument(docId, { status: 'error', last_error: 'Max retries exceeded' });
    return;
  }

  logger.info(`[doc:${docId}] ━━ START "${doc.title}" attempt ${attempts+1}/${MAX_RETRIES} ━━`);
  await incrementAttempt(queueId, attempts);
  await updateDocument(docId, { status: 'processing' });

  const t0 = Date.now();

  try {
    await withTimeout(_processDoc(queueId, docId, doc), DOC_TIMEOUT_MS);
    logger.info(`[doc:${docId}] ✅ DONE in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  } catch (err) {
    logger.error(`[doc:${docId}] ❌ FAILED in ${((Date.now()-t0)/1000).toFixed(1)}s: ${err.message}`);
    await _handleError(err, queueId, docId, attempts);
  }
}

async function _processDoc(queueId, docId, doc) {
  /* 1. הורדה */
  if (!doc.file_url) throw new Error('file_url is empty');
  logger.info(`[doc:${docId}] [1/5] Downloading...`);
  const buffer = await downloadFile(doc.file_url).catch(e => {
    throw new Error(`Download failed: ${e.message}`);
  });
  logger.info(`[doc:${docId}] [1/5] Downloaded ${(buffer.length/1024).toFixed(1)}KB`);

  /* 2. חילוץ טקסט */
  logger.info(`[doc:${docId}] [2/5] Extracting (${doc.file_type})...`);
  const { pages, fullText, method, pageCount } = await extractText(buffer, doc.file_type, docId);
  if (!fullText || fullText.trim().length < 10)
    throw new Error(`No text extracted (method: ${method})`);
  logger.info(`[doc:${docId}] [2/5] ${fullText.length} chars, ${pageCount} pages, method: ${method}`);

  /* 3. מטא-דאטה */
  logger.info(`[doc:${docId}] [3/5] Metadata...`);
  let meta = { doc_type:'other', year:null, contractor:null, tender_num:null, neighborhood:null, amounts:[] };
  try { meta = extractMetadata(fullText); } catch {}
  logger.info(`[doc:${docId}] [3/5] type:${meta.doc_type} year:${meta.year}`);

  /* 4. chunks */
  logger.info(`[doc:${docId}] [4/5] Chunking...`);
  const rawChunks = splitToChunks(pages, {
    id: docId, title: doc.title, file_url: doc.file_url,
    year: meta.year, contractor: meta.contractor,
    doc_type: meta.doc_type, tender_num: meta.tender_num,
  });
  if (!rawChunks.length) throw new Error('No chunks created');
  logger.info(`[doc:${docId}] [4/5] ${rawChunks.length} chunks`);

  /* 5. embeddings */
  logger.info(`[doc:${docId}] [5/5] Embeddings for ${rawChunks.length} chunks...`);
  const chunks = await addEmbeddingsToChunks(rawChunks);
  if (!chunks.length) throw new Error('No embeddings created');
  logger.info(`[doc:${docId}] [5/5] ${chunks.length}/${rawChunks.length} embeddings`);

  /* שמירה */
  await deleteOldChunks(docId);
  await saveChunks(chunks);
  await updateDocument(docId, {
    status: 'done', ocr_done: method.includes('ocr'),
    page_count: pageCount, doc_type: meta.doc_type,
    year: meta.year, contractor: meta.contractor,
    tender_num: meta.tender_num, neighborhood: meta.neighborhood,
    chunk_count: chunks.length, char_count: fullText.length,
    last_error: null,
    metadata: { extraction_method: method, chunk_count: chunks.length, processed_at: new Date().toISOString() },
  });
  await updateQueueStatus(queueId, 'done');
  logger.info(`[doc:${docId}] Saved ${chunks.length} chunks — status: done`);
}

async function _handleError(err, queueId, docId, attempts) {
  const msg = err.message || 'Unknown error';

  // בדוק אם לא כדאי לנסות שוב
  const isNoRetry = NO_RETRY_PATTERNS.some(p => msg.toLowerCase().includes(p.toLowerCase()));

  if (isNoRetry) {
    // כישלון קבוע — סמן error מיד, המשך למסמך הבא
    logger.warn(`[doc:${docId}] Permanent failure (no retry): ${msg}`);
    await updateQueueStatus(queueId, 'error', msg);
    await updateDocument(docId, { status: 'error', last_error: msg });
    return;
  }

  // שגיאה זמנית — בדוק אם נשארו ניסיונות
  const nextAttempt = attempts + 1;
  const willRetry   = nextAttempt < MAX_RETRIES;

  await updateQueueStatus(queueId, willRetry ? 'pending' : 'error', msg);
  await updateDocument(docId, {
    status:     willRetry ? 'pending' : 'error',
    last_error: msg,
  });

  if (willRetry) {
    logger.info(`[doc:${docId}] Will retry — attempt ${nextAttempt+1}/${MAX_RETRIES}`);
  } else {
    logger.error(`[doc:${docId}] Giving up after ${MAX_RETRIES} attempts — moving to next`);
  }

  try { await logError(docId, queueId, err); } catch {}
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Doc timeout after ${Math.round(ms/60000)} minutes`)), ms)
    ),
  ]);
}
