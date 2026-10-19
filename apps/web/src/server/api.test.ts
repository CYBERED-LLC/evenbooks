import { expect, it, vi } from 'vitest';
import { EmailIdentityPermissionError } from '@evenbooks/integrations';

vi.mock('server-only', () => ({}));
vi.mock('./company', () => ({ AuthError: class extends Error {} }));
vi.mock('./db', () => ({}));
vi.mock('./logger', () => ({ logger: { error: vi.fn() } }));

import { handleError } from './api';
import { logger } from './logger';

it('returns a safe, actionable sender permission error and logs the provider cause', async () => {
  const cause = Object.assign(new Error('Private AWS account and identity details'), { name: 'AccessDeniedException' });
  const err = new EmailIdentityPermissionError(cause);
  const response = handleError(err, 'sender-request');
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: {
    code: 'external_error',
    message: err.message,
    requestId: 'sender-request',
  } });
  expect(err.message).toContain('missing email provider permissions');
  expect(err.message).not.toContain('Private AWS');
  expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err, requestId: 'sender-request' }), 'email identity permission denied');
});
