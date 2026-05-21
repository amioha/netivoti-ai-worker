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
const DOC_TIMEOUT_MS = parseInt(process.env.DOC_TIMEOUT_MS) || 8 * 60 * 1000;

// שגיאות שלא כדאי לנסות שוב
const NO_RETRY = [
  'corrupted', 'truncated', 'read image', 'findFileFormatStream',
  'bad pdf', 'invalid pdf', 'No text', 'ocr_required',
  'file_url is empty', 'Download failed', 'unreadable',
];

export async function processDocument(queueItem) {
  const { id: queueId, document_id, attempts } = queueItem;
  const doc = queueItem.nv_documents;

  if (!doc) {
    await updateQueueStatus(queueId, 'error', 'Document not found');
    return;
  }

  const docId = doc.id;

  if (attempts >= MAX_RETRIES) {
    logger.error(`Max retries for doc ${docId}`, { docId });
    await updateQueueStatus(queueId, 'error', 'Max retries exceeded');
    await updateDocument(docId, { status: 'error' });
    return;
  }

  logger.info(`Processing: "${doc.title}" (attempt ${attempts+1}/${MAX_RETRIES})`, { docId });
  await incrementAttempt(queueId, attempts);
  await updateDocument(docId, { status: 'processing' });

  try {
    await withTimeout(_processDoc(queueId, docId, doc), DOC_TIMEOUT_MS);
  } catch (err) {
    await _handleError(err, queueId, docId, doc.title, attempts);
  }
}

async function _processDoc(queueId, docId, doc) {
  const start = Date.now();

  // 1. הורדה
  logger.info(`[1/5] Downloading...`, { docId });
  if (!doc.file_url) throw new Error('file_url is empty');
  const buffer = await downloadFile(doc.file_url).catch(err => {
    throw new Error(`Download failed: ${err.message}`);
  });
  logger.info(`[1/5] ${(buffer.length/1024).toFixed(1)}KB`, { docId });

  // 2. חילוץ טקסט
  logger.info(`[2/5] Extracting...`, { docId });
  const { pages, fullText, method, pageCount } = await extractText(buffer, doc.file_type, docId);

  if (!fullText || fullText.trim().length < 10) {
    throw new Error(`No text extracted (${method})`);
  }
  logger.info(`[2/5] ${fullText.length} chars, ${pageCount} pages (${method})`, { docId });

  // 3. מטא-דאטה
  logger.info(`[3/5] Metadata...`, { docId });
  const meta = safeExtractMetadata(fullText);

  // 4. קטעים
  logger.info(`[4/5] Chunking...`, { docId });
  const rawChunks = splitToChunks(pages, {
    id: docId, title: doc.title, file_url: doc.file_url,
    year: meta.year, contractor: meta.contractor,
    doc_type: meta.doc_type, tender_num: meta.tender_num,
  });
  if (!rawChunks.length) throw new Error('No chunks created');
  logger.info(`[4/5] ${rawChunks.length} chunks`, { docId });

  // 5. Embeddings
  logger.info(`[5/5] Embeddings...`, { docId });
  const chunks = await addEmbeddingsToChunks(rawChunks);
  if (!chunks.length) throw new Error('No embeddings created');
  logger.info(`[5/5] ${chunks.length}/${rawChunks.length}`, { docId });

  // שמירה
  await deleteOldChunks(docId);
  await saveChunks(chunks);
  await updateDocument(docId, {
    status: 'done', ocr_done: method.includes('ocr'),
    page_count: pageCount, doc_type: meta.doc_type,
    year: meta.year, contractor: meta.contractor,
    tender_num: meta.tender_num, neighborhood: meta.neighborhood,
    chunk_count: chunks.length, char_count: fullText.length,
    last_error: null,
    metadata: { extraction_method: method, processed_at: new Date().toISOString() },
  });
  await updateQueueStatus(queueId, 'done');

  const secs = ((Date.now()-start)/1000).toFixed(1);
  logger.info(`✅ Done: "${doc.title}" in ${secs}s`, { docId });
}

import { extractMetadata } from './chunker.js';

function safeExtractMetadata(text) {
  try {
    return extractMetadata(text);
  } catch {
    return { doc_type:'other', year:null, contractor:null, tender_num:null, neighborhood:null, amounts:[] };
  }
}

async function _handleError(err, queueId, docId, title, attempts) {
  const msg = err.message || 'Unknown error';
  logger.error(`❌ "${title}": ${msg}`, { docId });

  const isNoRetry = NO_RETRY.some(p => msg.toLowerCase().includes(p.toLowerCase()));

  if (isNoRetry) {
    logger.warn(`Permanent failure — skip retries`, { docId });
    await updateQueueStatus(queueId, 'error', msg);
    await updateDocument(docId, { status: 'error', last_error: msg });
    return;
  }

  const willRetry = attempts + 1 < MAX_RETRIES;
  await updateQueueStatus(queueId, willRetry ? 'pending' : 'error', msg);
  await updateDocument(docId, { status: willRetry ? 'pending' : 'error', last_error: msg });
  if (willRetry) logger.info(`Retry ${attempts+1}/${MAX_RETRIES}`, { docId });

  try { await logError(docId, queueId, err); } catch {}
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Doc timeout after ${ms/1000}s`)), ms)
    ),
  ]);
}
