import 'server-only';
import { createRequire } from 'node:module';

/**
 * SNS signature verification using `sns-validator` (checks SigningCertURL host
 * against amazonaws.com and the SHA1/SHA256 RSA signature). Set
 * SNS_SKIP_SIGNATURE_VERIFICATION=1 only in local development.
 */
export async function verifySnsMessage(raw: string): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (process.env.SNS_SKIP_SIGNATURE_VERIFICATION === '1' && (process.env.APP_ENV ?? process.env.NODE_ENV) !== 'production') return parsed;
  const require = createRequire(import.meta.url);
  const MessageValidator = require('sns-validator') as new () => { validate(msg: unknown, cb: (err: Error | null, msg?: Record<string, unknown>) => void): void };
  const validator = new MessageValidator();
  return new Promise((resolve, reject) => {
    validator.validate(parsed, (err, msg) => (err ? reject(err) : resolve(msg ?? parsed)));
  });
}
