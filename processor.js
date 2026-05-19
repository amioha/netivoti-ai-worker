import logger                           from './logger.js';
import { downloadFile, extractText }    from './extractor.js';
import { splitToChunks, extractMetadata } from './chunker.js';
import { addEmbeddingsToChunks }        from './embedder.js';
import {
  updateQueueStatus,
  incrementAttempt,
  updateDocument,
  saveChunks,
  deleteOldChunks,
  logError,
} from './supabase.js';

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;

/* ============================================
   עיבוד מסמך בודד — Pipeline מלא
============================================ */
export async function processDocument(queueItem) {
  const { id: queueId, document_id, attempts } = queueItem;
  const doc = queueItem.nv_documents;

  if (!doc) {
    logger.error(`Queue item ${queueId}: document not found`);
    await updateQueueStatus(queueId, 'error', 'Document not found in nv_documents');
    return;
  }

  const docId = doc.id;
  logger.info(`Starting processing: "${doc.title}"`, { docId });

  // בדוק ניסיונות
  if (attempts >= MAX_RETRIES) {
    logger.error(`Max retries reached for doc ${docId}`, { docId });
    await updateQueueStatus(queueId, 'error', `Max retries (${MAX_RETRIES}) exceeded`);
    await updateDocument(docId, { status: 'error' });
    return;
  }

  // סמן כ-processing
  await incrementAttempt(queueId, attempts);
  await updateDocument(docId, { status: 'processing' });

  const startTime = Date.now();

  try {
    /* ---- שלב 1: הורדת קובץ ---- */
    logger.info(`[1/5] Downloading file...`, { docId });
    if (!doc.file_url) throw new Error('file_url is empty');

    const buffer   = await downloadFile(doc.file_url);
    const fileSize = (buffer.length / 1024).toFixed(1);
    logger.info(`[1/5] Downloaded ${fileSize}KB`, { docId });

    /* ---- שלב 2: חילוץ טקסט ---- */
    logger.info(`[2/5] Extracting text (type: ${doc.file_type})...`, { docId });
    const { pages, fullText, method, pageCount } = await extractText(
      buffer, doc.file_type, docId
    );

    if (!fullText || fullText.trim().length < 20) {
      throw new Error(`Text extraction failed or too short (method: ${method})`);
    }

    logger.info(`[2/5] Extracted ${fullText.length} chars, ${pageCount} pages (${method})`, { docId });

    /* ---- שלב 3: חילוץ מטא-דאטה ---- */
    logger.info(`[3/5] Extracting metadata...`, { docId });
    const meta = extractMetadata(fullText);
    logger.info(`[3/5] Metadata: type=${meta.doc_type}, year=${meta.year}, contractor=${meta.contractor}`, { docId });

    /* ---- שלב 4: חלוקה לקטעים ---- */
    logger.info(`[4/5] Splitting into chunks...`, { docId });
    const rawChunks = splitToChunks(pages, {
      id:         docId,
      title:      doc.title,
      file_url:   doc.file_url,
      year:       meta.year,
      contractor: meta.contractor,
      doc_type:   meta.doc_type,
      tender_num: meta.tender_num,
    });
    logger.info(`[4/5] Created ${rawChunks.length} chunks`, { docId });

    /* ---- שלב 5: Embeddings ---- */
    logger.info(`[5/5] Creating embeddings for ${rawChunks.length} chunks...`, { docId });
    const chunksWithEmbeddings = await addEmbeddingsToChunks(rawChunks);
    logger.info(`[5/5] Embeddings created: ${chunksWithEmbeddings.length}/${rawChunks.length}`, { docId });

    /* ---- שמירה ב-Supabase ---- */
    logger.info(`Saving to Supabase...`, { docId });
    await deleteOldChunks(docId); // נקה קטעים ישנים אם יש
    await saveChunks(chunksWithEmbeddings);

    /* ---- עדכון מסמך ---- */
    await updateDocument(docId, {
      status:       'done',
      ocr_done:     method === 'ocr',
      page_count:   pageCount,
      doc_type:     meta.doc_type,
      year:         meta.year,
      contractor:   meta.contractor,
      tender_num:   meta.tender_num,
      neighborhood: meta.neighborhood,
      metadata: {
        extraction_method: method,
        chunk_count:       chunksWithEmbeddings.length,
        char_count:        fullText.length,
        amounts:           meta.amounts,
        processed_at:      new Date().toISOString(),
      },
    });

    /* ---- עדכון תור ---- */
    await updateQueueStatus(queueId, 'done');

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(
      `✅ Completed "${doc.title}" — ${chunksWithEmbeddings.length} chunks in ${duration}s`,
      { docId }
    );

  } catch (err) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.error(`❌ Failed "${doc.title}" after ${duration}s: ${err.message}`, { docId });

    // האם כדאי לנסות שוב?
    const willRetry = attempts + 1 < MAX_RETRIES;
    const status    = willRetry ? 'pending' : 'error';

    await updateQueueStatus(queueId, status, err.message);
    await updateDocument(docId, { status: willRetry ? 'pending' : 'error' });
    await logError(docId, queueId, err);

    if (willRetry) {
      logger.info(`Will retry (attempt ${attempts + 1}/${MAX_RETRIES})`, { docId });
    }
  }
}
