import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['*.accessUrl', '*.access_url', '*.setupToken', '*.secret', '*.password', '*.token', '*.ciphertext'], censor: '[redacted]' },
  base: { service: 'evenbooks-worker' },
});
