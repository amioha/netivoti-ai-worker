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
const DOC_TIMEOUT_MS = parseInt(process.env.DOC_TIMEOUT_MS) || 25 * 60 * 1000; // 25 דקות

// שגיאות שלא כדאי לנסות שוב
const NO_RETRY = [
  'corrupted', 'truncated', 'bad pdf', 'invalid pdf',
  'file_url is empty', 'No text', 'unreadable',
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

  if (attempts >= MAX_RETRIES) {
    logger.error(`Max retries (${MAX_RETRIES}) for doc ${docId}`, { docId });
    await updateQueueStatus(queueId, 'error', 'Max retries exceeded');
    await updateDocument(docId, { status: 'error', last_error: 'Max retries exceeded' });
    return;
  }

  logger.info(`━━━ Starting: "${doc.title}" (attempt ${attempts+1}/${MAX_RETRIES}) ━━━`, { docId });
  await incrementAttempt(queueId, attempts);
  await updateDocument(docId, { status: 'processing' });

  const startTime = Date.now();

  try {
    await withTimeout(_processDoc(queueId, docId, doc), DOC_TIMEOUT_MS);
    const secs = ((Date.now()-startTime)/1000).toFixed(1);
    logger.info(`━━━ ✅ Completed in ${secs}s ━━━`, { docId });
  } catch (err) {
    const secs = ((Date.now()-startTime)/1000).toFixed(1);
    logger.error(`━━━ ❌ Failed after ${secs}s: ${err.message} ━━━`, { docId });
    await _handleError(err, queueId, docId, doc.title, attempts);
  }
}

async function _processDoc(queueId, docId, doc) {

  /* 1. הורדה */
  logger.info(`[1/5] Downloading: ${doc.file_url}`, { docId });
  if (!doc.file_url) throw new Error('file_url is empty');
  const buffer = await downloadFile(doc.file_url).catch(err => {
    throw new Error(`Download failed: ${err.message}`);
  });
  logger.info(`[1/5] ✓ Downloaded ${(buffer.length/1024).toFixed(1)}KB`, { docId });

  /* 2. חילוץ טקסט */
  logger.info(`[2/5] Extracting text (type: ${doc.file_type})...`, { docId });
  const { pages, fullText, method, pageCount } = await extractText(buffer, doc.file_type, docId);

  if (!fullText || fullText.trim().length < 10) {
    throw new Error(`No text extracted (method: ${method})`);
  }
  logger.info(`[2/5] ✓ ${fullText.length} chars, ${pageCount} pages, method: ${method}`, { docId });

  /* 3. מטא-דאטה */
  logger.info(`[3/5] Extracting metadata...`, { docId });
  let meta = { doc_type:'other', year:null, contractor:null, tender_num:null, neighborhood:null, amounts:[] };
  try { meta = extractMetadata(fullText); } catch (e) { logger.warn(`Metadata error: ${e.message}`, { docId }); }
  logger.info(`[3/5] ✓ type:${meta.doc_type} year:${meta.year}`, { docId });

  /* 4. חלוקה לקטעים */
  logger.info(`[4/5] Chunking...`, { docId });
  const rawChunks = splitToChunks(pages, {
    id: docId, title: doc.title, file_url: doc.file_url,
    year: meta.year, contractor: meta.contractor,
    doc_type: meta.doc_type, tender_num: meta.tender_num,
  });
  if (!rawChunks.length) throw new Error('No chunks created');
  logger.info(`[4/5] ✓ ${rawChunks.length} chunks`, { docId });

  /* 5. Embeddings */
  logger.info(`[5/5] Creating embeddings for ${rawChunks.length} chunks...`, { docId });
  const chunks = await addEmbeddingsToChunks(rawChunks);
  if (!chunks.length) throw new Error('No embeddings created');
  logger.info(`[5/5] ✓ ${chunks.length}/${rawChunks.length} embeddings`, { docId });

  /* שמירה */
  logger.info(`Saving ${chunks.length} chunks to DB...`, { docId });
  await deleteOldChunks(docId);
  await saveChunks(chunks);
  await updateDocument(docId, {
    status:       'done',
    ocr_done:     method === 'ocr',
    page_count:   pageCount,
    doc_type:     meta.doc_type,
    year:         meta.year,
    contractor:   meta.contractor,
    tender_num:   meta.tender_num,
    neighborhood: meta.neighborhood,
    chunk_count:  chunks.length,
    char_count:   fullText.length,
    last_error:   null,
    metadata: {
      extraction_method: method,
      chunk_count:       chunks.length,
      processed_at:      new Date().toISOString(),
    },
  });
  await updateQueueStatus(queueId, 'done');
  logger.info(`✅ Saved: ${chunks.length} chunks, method: ${method}`, { docId });
}

async function _handleError(err, queueId, docId, title, attempts) {
  const msg = err.message || 'Unknown error';

  const isNoRetry = NO_RETRY.some(p => msg.toLowerCase().includes(p.toLowerCase()));

  if (isNoRetry) {
    logger.warn(`Permanent failure — no retry: ${msg}`, { docId });
    await updateQueueStatus(queueId, 'error', msg);
    await updateDocument(docId, { status: 'error', last_error: msg });
    return;
  }

  const willRetry = attempts + 1 < MAX_RETRIES;
  const nextStatus = willRetry ? 'pending' : 'error';
  await updateQueueStatus(queueId, nextStatus, msg);
  await updateDocument(docId, { status: willRetry ? 'pending' : 'error', last_error: msg });

  if (willRetry) {
    logger.info(`Will retry (${attempts+1}/${MAX_RETRIES})`, { docId });
  } else {
    logger.error(`Giving up after ${MAX_RETRIES} attempts`, { docId });
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
