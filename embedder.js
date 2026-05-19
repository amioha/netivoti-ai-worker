import axios  from 'axios';
import logger from './logger.js';

const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY;
const MODEL          = 'voyage-3';
const MAX_BATCH      = 96;

if (!VOYAGE_API_KEY) {
  logger.error('VOYAGE_API_KEY is not set! Embeddings will fail.');
} else {
  logger.info(`Voyage key loaded: ${VOYAGE_API_KEY.slice(0, 8)}...`);
}

/* ---- embedding לטקסט בודד ---- */
export async function getEmbedding(text) {
  const results = await getEmbeddingsBatch([text]);
  return results[0] || null;
}

/* ---- embeddings ל-batch ---- */
export async function getEmbeddingsBatch(texts) {
  if (!texts.length) return [];
  if (!VOYAGE_API_KEY) throw new Error('VOYAGE_API_KEY לא מוגדר');

  const results = [];

  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH).map(t => String(t).slice(0, 8000));

    try {
      logger.debug(`Embedding batch ${i}–${i + batch.length}`);

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

      if (i + MAX_BATCH < texts.length) await sleep(300);

    } catch (err) {
      const status  = err.response?.status;
      const message = err.response?.data?.detail || err.response?.data?.message || err.message;

      if (status === 401) {
        throw new Error(`Voyage API key invalid (401). Key starts with: ${VOYAGE_API_KEY?.slice(0, 8)}`);
      }
      if (status === 429) {
        logger.warn('Voyage rate limit — waiting 10s...');
        await sleep(10_000);
        i -= MAX_BATCH;
        continue;
      }

      logger.error(`Embedding batch failed (${status}): ${message}`);
      results.push(...new Array(batch.length).fill(null));
    }
  }

  return results;
}

/* ---- הוסף embeddings לקטעים ---- */
export async function addEmbeddingsToChunks(chunks) {
  if (!chunks.length) return [];

  logger.info(`Creating embeddings for ${chunks.length} chunks...`);

  const texts      = chunks.map(c => c.content);
  const embeddings = await getEmbeddingsBatch(texts);

  const withEmbeddings = chunks
    .map((chunk, i) => ({ ...chunk, embedding: embeddings[i] || null }))
    .filter(c => c.embedding !== null);

  logger.info(`Embeddings done: ${withEmbeddings.length}/${chunks.length}`);
  return withEmbeddings;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
