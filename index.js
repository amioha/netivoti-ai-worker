import 'dotenv/config';
import cron               from 'node-cron';
import logger             from './logger.js';
import { getPendingDocs } from './supabase.js';
import { processDocument } from './processor.js';

const CRON_INTERVAL = process.env.CRON_INTERVAL || '*/3 * * * *';

let isRunning = false;

/* ============================================
   עיבוד מסמך אחד בכל פעם
============================================ */
async function runNext() {
  if (isRunning) {
    logger.debug('Still processing previous document, skipping...');
    return;
  }

  isRunning = true;

  try {
    // שלוף מסמך אחד בלבד
    const pending = await getPendingDocs(1);

    if (!pending || pending.length === 0) {
      logger.debug('Queue empty — nothing to process.');
      return;
    }

    const item = pending[0];
    logger.info(`Processing 1 document: "${item.nv_documents?.title || item.document_id}"`);
    await processDocument(item);

  } catch (err) {
    logger.error(`Batch error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/* ============================================
   STARTUP
============================================= */
async function main() {
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  שקיפות ציבורית נתיבות — Worker v2');
  logger.info('  Mode: sequential (1 doc at a time)');
  logger.info(`  Cron: ${CRON_INTERVAL}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const required = ['ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  logger.info('Running first batch...');
  await runNext();

  cron.schedule(CRON_INTERVAL, () => runNext());
  logger.info('Worker running. Processing one document per tick.');
}

process.on('SIGTERM', () => { logger.info('Shutting down...'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('Interrupted.');     process.exit(0); });
process.on('unhandledRejection', err => logger.error(`Unhandled: ${err}`));
process.on('uncaughtException',  err => { logger.error(`Uncaught: ${err.message}`); process.exit(1); });

main().catch(err => { logger.error(`Startup: ${err.message}`); process.exit(1); });
