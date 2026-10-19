import 'server-only';
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { ZodError, type ZodType } from 'zod';
import type { MembershipRole } from '@evenbooks/contracts';
import { ServiceError, runInCompany, type ServiceContext } from '@evenbooks/services';
import { EmailIdentityPermissionError } from '@evenbooks/integrations';
import { AuthError, requirePrincipal, type Principal } from './company';
import { getDb } from './db';
import { logger } from './logger';

export interface RouteArgs<TBody, TQuery, TParams> {
  req: NextRequest;
  body: TBody;
  query: TQuery;
  params: TParams;
  principal: Principal;
  requestId: string;
}

export interface RouteOptions<TBody, TQuery, TParams> {
  body?: ZodType<TBody>;
  query?: ZodType<TQuery>;
  params?: ZodType<TParams>;
  role?: MembershipRole;
}

export type RouteContext = { params: Promise<Record<string, string | string[]>> };

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(init.headers ?? {}) },
  });
}

export function errorResponse(code: string, message: string, status: number, details?: unknown, requestId?: string): Response {
  return json({ error: { code, message, details, requestId } }, { status });
}

/**
 * Typed route handler wrapper: authenticates, resolves the company, validates
 * input, and maps errors to a stable JSON shape. The client sends the company
 * id it believes is active in `x-company-id`; a mismatch is rejected so a stale
 * tab cannot write into a newly selected company.
 */
export function route<TBody = undefined, TQuery = undefined, TParams = Record<string, string>>(
  opts: RouteOptions<TBody, TQuery, TParams>,
  handler: (args: RouteArgs<TBody, TQuery, TParams>) => Promise<Response | unknown>,
) {
  return async (req: NextRequest, ctx?: RouteContext): Promise<Response> => {
    const requestId = req.headers.get('x-request-id') ?? randomUUID();
    const started = Date.now();
    try {
      const principal = await requirePrincipal({
        role: opts.role,
        expectedCompanyId: req.headers.get('x-company-id'),
      });
      principal.ctx.requestId = requestId;
      const rawParams = ctx ? await ctx.params : {};
      const params = (opts.params ? opts.params.parse(rawParams) : rawParams) as TParams;
      const query = (opts.query ? opts.query.parse(Object.fromEntries(req.nextUrl.searchParams)) : undefined) as TQuery;
      let body = undefined as TBody;
      if (opts.body) {
        const text = await req.text();
        let parsed: unknown = undefined;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            return errorResponse('validation', 'Malformed JSON body', 400, undefined, requestId);
          }
        }
        body = opts.body.parse(parsed);
      }
      const result = await handler({ req, body, query, params, principal, requestId });
      if (result instanceof Response) return result;
      return json(result, { headers: { 'x-request-id': requestId } });
    } catch (err) {
      return handleError(err, requestId, req);
    } finally {
      logger.debug({ requestId, method: req.method, path: req.nextUrl.pathname, ms: Date.now() - started }, 'request');
    }
  };
}

export function handleError(err: unknown, requestId: string, req?: NextRequest): Response {
  if (err instanceof AuthError) {
    const status = err.kind === 'unauthenticated' ? 401 : err.kind === 'forbidden' ? 403 : err.kind === 'company_mismatch' ? 409 : 412;
    return errorResponse(err.kind, err.message, status, undefined, requestId);
  }
  if (err instanceof ZodError) {
    return errorResponse('validation', 'Some details are missing or not valid. Check the form and try again.', 400, err.issues, requestId);
  }
  if (err instanceof ServiceError) {
    return errorResponse(err.code, err.message, err.status, err.details, requestId);
  }
  if (err instanceof EmailIdentityPermissionError) {
    logger.error({ requestId, err, path: req?.nextUrl.pathname }, 'email identity permission denied');
    return errorResponse('external_error', err.message, 502, undefined, requestId);
  }
  logger.error({ requestId, err, path: req?.nextUrl.pathname }, 'unhandled error');
  return errorResponse('internal', 'Something went wrong on our side. Nothing was saved. Try again in a moment.', 500, undefined, requestId);
}

/** Convenience: run a service function in the principal's company context. */
export function inCompany<T>(principal: Principal, fn: (s: ServiceContext) => Promise<T>): Promise<T> {
  return runInCompany(getDb().db, principal.ctx, fn);
}

export const uuidParam = (name: string) =>
  ({
    parse(v: unknown) {
      const val = (v as Record<string, string>)[name];
      if (!val || !/^[0-9a-f-]{36}$/i.test(val)) throw new ServiceError('not_found', 'Not found');
      return { [name]: val } as Record<string, string>;
    },
  }) as unknown as ZodType<Record<string, string>>;
