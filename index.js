import 'dotenv/config';
import cron               from 'node-cron';
import logger             from './logger.js';
import { getPendingDocs } from './supabase.js';
import { processDocument } from './processor.js';

const CRON_INTERVAL = process.env.CRON_INTERVAL || '*/3 * * * *';
let isRunning       = false;
let currentDocId    = null;
let currentQueueId  = null;

/* ============================================
   תפיסת שגיאות UNCAUGHT ברמת ה-process
   מונע קריסת ה-Worker על קבצים פגומים
============================================ */
process.on('uncaughtException', async (err) => {
  logger.error(`uncaughtException: ${err.message}`);

  // אם יש מסמך שמעבד עכשיו — סמן אותו כשגיאה
  if (currentQueueId && currentDocId) {
    logger.error(`Marking current doc ${currentDocId} as failed`);
    try {
      const { updateQueueStatus, updateDocument } = await import('./supabase.js');
      await updateQueueStatus(currentQueueId, 'error', `uncaughtException: ${err.message}`);
      await updateDocument(currentDocId, { status: 'error', last_error: err.message });
    } catch (e) {
      logger.error(`Could not mark doc as failed: ${e.message}`);
    }
  }

  // אפס state ואל תקרוס — ממשיך למסמך הבא
  isRunning      = false;
  currentDocId   = null;
  currentQueueId = null;
  logger.info('Recovered from uncaughtException — continuing...');
});

process.on('unhandledRejection', (reason) => {
  logger.error(`unhandledRejection: ${reason}`);
  // אל תקרוס — המשך
});

/* ============================================
   עיבוד מסמך אחד בכל פעם
============================================ */
async function runNext() {
  if (isRunning) {
    logger.debug('Still processing, skipping tick...');
    return;
  }
  isRunning = true;

  try {
    const pending = await getPendingDocs(1);
    if (!pending || pending.length === 0) {
      logger.debug('Queue empty.');
      return;
    }

    const item     = pending[0];
    currentQueueId = item.id;
    currentDocId   = item.document_id;

    logger.info(`Processing: "${item.nv_documents?.title || item.document_id}"`);
    await processDocument(item);

  } catch (err) {
    logger.error(`runNext error: ${err.message}`);
  } finally {
    isRunning      = false;
    currentDocId   = null;
    currentQueueId = null;
  }
}

/* ============================================
   STARTUP
============================================ */
async function main() {
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  שקיפות ציבורית — Worker v3');
  logger.info('  Crash-safe: uncaught errors handled');
  logger.info(`  Cron: ${CRON_INTERVAL}`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const missing = ['ANTHROPIC_API_KEY','VOYAGE_API_KEY','SUPABASE_URL','SUPABASE_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) { logger.error(`Missing: ${missing.join(', ')}`); process.exit(1); }

  await runNext();
  cron.schedule(CRON_INTERVAL, runNext);
  logger.info('Worker running — crash-safe mode active.');
}

process.on('SIGTERM', () => { logger.info('SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT');  process.exit(0); });

main().catch(err => { logger.error(`Startup: ${err.message}`); process.exit(1); });
