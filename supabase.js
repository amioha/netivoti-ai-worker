import axios from 'axios';
import logger from './logger.js';

const BASE = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY  = process.env.SUPABASE_KEY;

const headers = {
  apikey:         KEY,
  Authorization:  `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  Prefer:         'return=representation',
};

async function req(method, path, params = {}, body = null) {
  const url = `${BASE}/rest/v1/${path}`;
  try {
    const res = await axios({ method, url, headers, params, data: body, timeout: 20_000 });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error(`Supabase ${method} ${path} failed: ${msg}`);
    throw err;
  }
}

/* ---- ניקוי טקסט לפני שמירה ---- */
function cleanText(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\u0000/g, '')                          // null bytes
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // control chars
    .replace(/\\u[0-9a-fA-F]{0,3}(?![0-9a-fA-F])/g, '') // broken unicode escapes
    .trim();
}

function cleanChunk(chunk) {
  return {
    ...chunk,
    content:   cleanText(chunk.content   || ''),
    doc_title: cleanText(chunk.doc_title || ''),
    doc_url:   cleanText(chunk.doc_url   || ''),
  };
}

export async function getPendingDocs(limit = 5) {
  return req('GET', 'nv_processing_queue', {
    select: 'id,document_id,attempts,nv_documents(id,title,file_url,file_type)',
    status: 'eq.pending',
    order:  'id.asc',
    limit,
  });
}

export async function updateQueueStatus(queueId, status, errorMsg = null) {
  const body = {
    status,
    processed_at: new Date().toISOString(),
    ...(errorMsg ? { error_msg: errorMsg?.slice(0, 500) } : {}),
  };
  return req('PATCH', 'nv_processing_queue', { id: `eq.${queueId}` }, body);
}

export async function incrementAttempt(queueId, currentAttempts) {
  return req('PATCH', 'nv_processing_queue',
    { id: `eq.${queueId}` },
    { attempts: currentAttempts + 1, status: 'processing' }
  );
}

export async function updateDocument(docId, data) {
  return req('PATCH', 'nv_documents', { id: `eq.${docId}` }, data);
}

export async function saveChunks(chunks) {
  if (!chunks.length) return;
  const BATCH = 50;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH).map(cleanChunk);
    try {
      await req('POST', 'nv_chunks', {}, batch);
      logger.debug(`Saved chunks batch ${i}–${i + batch.length}`);
    } catch (err) {
      // נסה אחד-אחד אם ה-batch נכשל
      logger.warn(`Batch failed — trying one by one: ${err.message}`);
      for (const chunk of batch) {
        try {
          await req('POST', 'nv_chunks', {}, [chunk]);
        } catch (e) {
          logger.error(`Single chunk failed (doc:${chunk.document_id}): ${e.message}`);
        }
      }
    }
  }
}

export async function deleteOldChunks(docId) {
  return req('DELETE', 'nv_chunks', { document_id: `eq.${docId}` });
}

export async function logError(docId, queueId, error) {
  try {
    await updateDocument(docId, {
      last_error: error.message?.slice(0, 500) || 'Unknown error',
    });
  } catch { /* ignore */ }
}

export async function getQueueStats() {
  try {
    const data = await req('GET', 'nv_processing_queue', {
      select: 'status',
      status: 'in.(pending,processing,done,error)',
    });
    const counts = { pending:0, processing:0, done:0, error:0 };
    (data||[]).forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
    return counts;
  } catch {
    return { pending:0, processing:0, done:0, error:0 };
  }
}

export default { getPendingDocs, updateQueueStatus, incrementAttempt, updateDocument, saveChunks, deleteOldChunks, logError, getQueueStats };
