import 'dotenv/config';
import cron             from 'node-cron';
import logger           from './logger.js';
import { getPendingDocs } from './supabase.js';
import { processDocument } from './processor.js';

const BATCH_SIZE    = parseInt(process.env.BATCH_SIZE)    || 5;
const CRON_INTERVAL = process.env.CRON_INTERVAL           || '*/3 * * * *'; // כל 3 דקות

let isRunning = false; // מונע ריצה כפולה

/* ============================================
   לולאת עיבוד עיקרית
============================================ */
async function runBatch() {
  if (isRunning) {
    logger.debug('Previous batch still running, skipping...');
    return;
  }

  isRunning = true;

  try {
    const pending = await getPendingDocs(BATCH_SIZE);

    if (!pending || pending.length === 0) {
      logger.debug('No pending documents.');
      return;
    }

    logger.info(`Found ${pending.length} pending documents, processing...`);

    // עיבוד מקבילי עם הגבלה
    await Promise.allSettled(
      pending.map(item => processDocument(item))
    );

  } catch (err) {
    logger.error(`Batch run error: ${err.message}`);
  } finally {
    isRunning = false;
  }
}

/* ============================================
   STARTUP
============================================ */
async function main() {
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  שקיפות ציבורית נתיבות — Worker');
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info(`Batch size:    ${BATCH_SIZE}`);
  logger.info(`Cron interval: ${CRON_INTERVAL}`);
  logger.info(`Supabase URL:  ${process.env.SUPABASE_URL}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // בדיקת משתני סביבה
  const required = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (missing.length) {
    logger.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // הרץ מיד בהתחלה
  logger.info('Running initial batch...');
  await runBatch();

  // הגדר Cron
  cron.schedule(CRON_INTERVAL, () => {
    logger.debug(`Cron triggered (${CRON_INTERVAL})`);
    runBatch();
  });

  logger.info(`Worker is running. Next check in ${CRON_INTERVAL}`);
}

/* ============================================
   GRACEFUL SHUTDOWN
============================================ */
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}`);
  process.exit(1);
});

main().catch(err => {
  logger.error(`Startup error: ${err.message}`);
  process.exit(1);
});
