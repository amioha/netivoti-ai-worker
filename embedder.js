import axios  from 'axios';
import logger from './logger.js';

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const MODEL          = 'voyage-3';
const MAX_BATCH      = 20; // קטן יותר למניעת rate limit

if (!VOYAGE_API_KEY) {
  logger.error('VOYAGE_API_KEY is not set!');
} else {
  logger.info(`Voyage key loaded: ${VOYAGE_API_KEY.slice(0, 8)}...`);
}

/* ---- sleep ---- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- embedding לטקסט בודד ---- */
export async function getEmbedding(text) {
  const results = await getEmbeddingsBatch([text]);
  return results[0] || null;
}

/* ---- embeddings ל-batch עם backoff ---- */
export async function getEmbeddingsBatch(texts) {
  if (!texts.length) return [];
  if (!VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY לא מוגדר');

  const results  = [];
  let   retries  = 0;
  const MAX_RETRIES = 5;

  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH).map(t => String(t).slice(0, 8000));

    let success = false;
    retries = 0;

    while (!success && retries < MAX_RETRIES) {
      try {
        logger.debug(`Embedding batch ${i}–${i + batch.length} (attempt ${retries + 1})`);

        const res = await axios.post(
          'https://api.voyageai.com/v1/embeddings',
          { model: MODEL, input: batch },
          {
            headers: {
              'Authorization': `Bearer ${VOYAGE_API_KEY}`,
              'Content-Type':  'application/json',
            },
            timeout: 30_000,
          }
        );

        const embeddings = (res.data?.data || [])
          .sort((a, b) => a.index - b.index)
          .map(e => e.embedding);

        results.push(...embeddings);
        success = true;

        // המתן בין batches — מונע rate limit
        if (i + MAX_BATCH < texts.length) {
          await sleep(2_000); // 2 שניות בין batches
        }

      } catch (err) {
        const status  = err.response?.status;
        const message = err.response?.data?.detail || err.response?.data?.message || err.message;

        if (status === 401) {
          throw new Error(`Voyage key invalid: ${VOYAGE_API_KEY?.slice(0, 8)}`);
        }

        if (status === 429) {
          // Rate limit — backoff exponential
          retries++;
          const wait = Math.min(60_000 * retries, 120_000); // 60s, 120s מקסימום
          logger.warn(`Voyage rate limit (attempt ${retries}/${MAX_RETRIES}) — waiting ${wait/1000}s...`);
          await sleep(wait);
          continue;
        }

        // שגיאה אחרת — נסה שוב אחרי 10 שניות
        retries++;
        logger.error(`Embedding error (${status}): ${message} — retry ${retries}/${MAX_RETRIES}`);
        await sleep(10_000);
      }
    }

    if (!success) {
      logger.error(`Batch ${i} failed after ${MAX_RETRIES} retries — skipping`);
      results.push(...new Array(batch.length).fill(null));
    }
  }

  return results;
}

/* ---- הוסף embeddings לקטעים ---- */
export async function addEmbeddingsToChunks(chunks) {
  if (!chunks.length) return [];

  logger.info(`Creating embeddings for ${chunks.length} chunks...`);

  // עבד את הקטעים ב-batches קטנים עם המתנה
  const results = [];
  const CHUNK_BATCH = 20;

  for (let i = 0; i < chunks.length; i += CHUNK_BATCH) {
    const batch      = chunks.slice(i, i + CHUNK_BATCH);
    const texts      = batch.map(c => c.content);
    const embeddings = await getEmbeddingsBatch(texts);

    const withEmb = batch
      .map((chunk, j) => ({ ...chunk, embedding: embeddings[j] || null }))
      .filter(c => c.embedding !== null);

    results.push(...withEmb);

    if (i + CHUNK_BATCH < chunks.length) {
      logger.debug(`Chunk batch ${i}–${i+CHUNK_BATCH} done, waiting 3s...`);
      await sleep(3_000); // 3 שניות בין batches
    }
  }

  logger.info(`Embeddings done: ${results.length}/${chunks.length}`);
  return results;
}
