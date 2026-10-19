import 'server-only';
import pino from 'pino';

const REDACT = ['req.headers.authorization', 'req.headers.cookie', '*.accessUrl', '*.access_url', '*.secret', '*.password', '*.token'];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'evenbooks-web' },
});
