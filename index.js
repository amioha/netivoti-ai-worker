import 'dotenv/config';
import cron               from 'node-cron';
import logger             from './logger.js';
import { getPendingDocs } from './supabase.js';
import { processDocument } from './processor.js';

const CRON_INTERVAL = process.env.CRON_INTERVAL || '*/3 * * * *';
let isRunning = false;

// תפוס הכל — אבל אל תקרוס
process.on('uncaughtException',  err => logger.error(`uncaughtException (ignored): ${err.message}`));
process.on('unhandledRejection', err => logger.error(`unhandledRejection (ignored): ${err}`));

async function runNext() {
  if (isRunning) return;
  isRunning = true;
  try {
    const pending = await getPendingDocs(1);
    if (!pending?.length) { logger.debug('Queue empty.'); return; }
    await processDocument(pending[0]);
  } catch (err) {
    logger.error(`runNext: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

async function main() {
  logger.info('Worker v3 — no pdf2pic, crash-safe');
  const missing = ['ANTHROPIC_API_KEY','VOYAGE_API_KEY','SUPABASE_URL','SUPABASE_KEY'].filter(k => !process.env[k]);
  if (missing.length) { logger.error(`Missing: ${missing.join(', ')}`); process.exit(1); }
  await runNext();
  cron.schedule(CRON_INTERVAL, runNext);
  logger.info(`Running. Cron: ${CRON_INTERVAL}`);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
main().catch(err => { logger.error(err.message); process.exit(1); });
