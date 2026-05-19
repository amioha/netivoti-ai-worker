import axios  from 'axios';
import logger from './logger.js';

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL   = 'voyage-3';
const MAX_BATCH = 96; // מגבלת Voyage API

/* ============================================
   יצירת Embedding לטקסט בודד
============================================ */
export async function getEmbedding(text) {
  const embeddings = await getEmbeddingsBatch([text]);
  return embeddings[0] || null;
}

/* ============================================
   יצירת Embeddings ל-batch של טקסטים
   חוסך קריאות API — מעבד עד 96 בבת אחת
============================================ */
export async function getEmbeddingsBatch(texts) {
  if (!texts.length) return [];
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY לא מוגדר');

  const results = [];

  // חלק ל-batches
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH).map(t =>
      t.slice(0, 8000) // מגבלת טוקנים
    );

    try {
      logger.debug(`Embedding batch ${i}–${i + batch.length} (${batch.length} texts)`);

      const res = await axios.post(
        'https://api.voyageai.com/v1/embeddings',
        { model: MODEL, input: batch },
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30_000,
        }
      );

      const embeddings = res.data?.data || [];
      // מיין לפי index כדי לשמור על הסדר
      embeddings.sort((a, b) => a.index - b.index);
      results.push(...embeddings.map(e => e.embedding));

      // המתן קצת בין batches כדי לא לעלות על rate limit
      if (i + MAX_BATCH < texts.length) {
        await sleep(500);
      }

    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.detail || err.message;

      if (status === 429) {
        logger.warn('Rate limit hit, waiting 10 seconds...');
        await sleep(10_000);
        i -= MAX_BATCH; // נסה שוב את אותו batch
        continue;
      }

      logger.error(`Embedding batch failed: ${msg}`);
      // החזר nulls במקום לכשול לגמרי
      results.push(...new Array(batch.length).fill(null));
    }
  }

  return results;
}

/* ============================================
   הוסף embeddings לקטעים
============================================ */
export async function addEmbeddingsToChunks(chunks) {
  if (!chunks.length) return chunks;

  logger.info(`Creating embeddings for ${chunks.length} chunks...`);

  const texts      = chunks.map(c => c.content);
  const embeddings = await getEmbeddingsBatch(texts);

  return chunks.map((chunk, i) => ({
    ...chunk,
    embedding: embeddings[i] || null,
  })).filter(c => c.embedding !== null); // סנן קטעים ללא embedding
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
