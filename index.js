import 'dotenv/config';
import cron               from 'node-cron';
import logger             from './logger.js';
import { getPendingDocs, getQueueStats } from './supabase.js';
import { processDocument } from './processor.js';

const CRON_INTERVAL = process.env.CRON_INTERVAL || '*/3 * * * *';
let isRunning = false;
let tickCount = 0;

process.on('uncaughtException',  err => logger.error(`uncaughtException (ignored): ${err.message}`));
process.on('unhandledRejection', err => logger.error(`unhandledRejection (ignored): ${err}`));

async function runNext() {
  if (isRunning) {
    logger.debug('Still processing previous document — skipping tick');
    return;
  }

  isRunning = true;
  tickCount++;

  try {
    // כל 5 ריצות — הצג סטטיסטיקה
    if (tickCount % 5 === 1) {
      try {
        const stats = await getQueueStats();
        logger.info(`📊 Queue stats — pending:${stats.pending} processing:${stats.processing} done:${stats.done} error:${stats.error}`);
      } catch {}
    }

    const pending = await getPendingDocs(1);

    if (!pending || pending.length === 0) {
      logger.debug('Queue empty — nothing to process');
      return;
    }

    const item = pending[0];
    logger.info(`📄 Processing doc ID:${item.document_id} — "${item.nv_documents?.title || 'unknown'}"`);
    await processDocument(item);

  } catch (err) {
    logger.error(`runNext error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

async function main() {
  logger.info('══════════════════════════════════════════');
  logger.info('  שקיפות ציבורית נתיבות — Worker v4');
  logger.info('  OCR: enabled | Timeout: 25min | Sequential');
  logger.info(`  Cron: ${CRON_INTERVAL}`);
  logger.info('══════════════════════════════════════════');

  const required = ['ANTHROPIC_API_KEY','VOYAGE_API_KEY','SUPABASE_URL','SUPABASE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) { logger.error(`Missing env vars: ${missing.join(', ')}`); process.exit(1); }

  // הרץ מיד
  await runNext();

  // Cron
  cron.schedule(CRON_INTERVAL, runNext);
  logger.info(`Worker running. Cron: ${CRON_INTERVAL}`);
}

process.on('SIGTERM', () => { logger.info('SIGTERM received'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT received');  process.exit(0); });

main().catch(err => { logger.error(`Startup failed: ${err.message}`); process.exit(1); });
