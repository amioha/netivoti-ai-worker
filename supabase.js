import axios from 'axios';
import logger from './logger.js';

const BASE  = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY   = process.env.SUPABASE_KEY;

const headers = {
  apikey:        KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
  Prefer:        'return=representation',
};

/* ---- generic request ---- */
async function req(method, path, params = {}, body = null) {
  const url = `${BASE}/rest/v1/${path}`;
  try {
    const res = await axios({
      method,
      url,
      headers,
      params,
      data: body,
      timeout: 20_000,
    });
    return res.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error(`Supabase ${method} ${path} failed: ${msg}`);
    throw err;
  }
}

/* ---- שליפת מסמכים בתור ---- */
export async function getPendingDocs(limit = 5) {
  return req('GET', 'nv_processing_queue', {
    select: 'id,document_id,attempts,nv_documents(id,title,file_url,file_type)',
    status: 'eq.pending',
    order:  'id.asc',
    limit,
  });
}

/* ---- עדכון סטטוס בתור ---- */
export async function updateQueueStatus(queueId, status, errorMsg = null) {
  const body = {
    status,
    processed_at: new Date().toISOString(),
    ...(errorMsg ? { error_msg: errorMsg } : {}),
  };
  return req('PATCH', 'nv_processing_queue', { id: `eq.${queueId}` }, body);
}

/* ---- עדכון ניסיון ---- */
export async function incrementAttempt(queueId, currentAttempts) {
  return req('PATCH', 'nv_processing_queue',
    { id: `eq.${queueId}` },
    { attempts: currentAttempts + 1, status: 'processing' }
  );
}

/* ---- עדכון מסמך ---- */
export async function updateDocument(docId, data) {
  return req('PATCH', 'nv_documents', { id: `eq.${docId}` }, data);
}

/* ---- שמירת קטעים עם embeddings ---- */
export async function saveChunks(chunks) {
  if (!chunks.length) return;
  // שמור ב-batches של 50 כדי לא לעבור מגבלות
  const BATCH = 50;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    await req('POST', 'nv_chunks', {}, batch);
    logger.debug(`Saved chunks batch ${i}–${i + batch.length}`);
  }
}

/* ---- מחיקת קטעים ישנים למסמך ---- */
export async function deleteOldChunks(docId) {
  return req('DELETE', 'nv_chunks', { document_id: `eq.${docId}` });
}

/* ---- שמירת לוג שגיאה מפורטת ---- */
export async function logError(docId, queueId, error) {
  try {
    await req('POST', 'nv_error_log', {}, {
      document_id: docId,
      queue_id:    queueId,
      error_msg:   error.message,
      stack_trace: error.stack,
      created_at:  new Date().toISOString(),
    });
  } catch {
    // אל תיכשל בגלל לוג כושל
  }
}

export default { getPendingDocs, updateQueueStatus, incrementAttempt, updateDocument, saveChunks, deleteOldChunks, logError };

export async function getQueueStats() {
  const { data, error } = await supabase
    .from('nv_processing_queue')
    .select('status')
    .in('status', ['pending','processing','done','error']);
  if (error) return { pending:0, processing:0, done:0, error:0 };
  const counts = { pending:0, processing:0, done:0, error:0 };
  (data||[]).forEach(r => { if (counts[r.status] !== undefined) counts[r.status]++; });
  return counts;
}
