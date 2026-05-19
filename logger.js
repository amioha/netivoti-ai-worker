import { createLogger, format, transports } from 'winston';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir   = join(__dirname, '../logs');

// וודא שתיקיית logs קיימת
try { mkdirSync(logsDir, { recursive: true }); } catch {}

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, docId, ...meta }) => {
      const docPart = docId ? ` [doc:${docId}]` : '';
      const metaPart = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}]${docPart} ${message}${metaPart}`;
    })
  ),
  transports: [
    // קונסול — צבעוני
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.timestamp({ format: 'HH:mm:ss' }),
        format.printf(({ timestamp, level, message, docId }) => {
          const docPart = docId ? ` [doc:${docId}]` : '';
          return `${timestamp} ${level}${docPart} ${message}`;
        })
      )
    }),
    // קובץ — כל הלוגים
    new transports.File({
      filename: join(logsDir, 'worker.log'),
      maxsize: 5 * 1024 * 1024, // 5MB
      maxFiles: 5,
      tailable: true,
    }),
    // קובץ נפרד לשגיאות
    new transports.File({
      filename: join(logsDir, 'errors.log'),
      level: 'error',
      maxsize: 2 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});

export default logger;
