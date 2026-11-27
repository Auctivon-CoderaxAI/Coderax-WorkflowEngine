import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Router } from './router.js';
import type { Logger } from '../observability/logger.js';
import type { MetricsRegistry } from '../observability/metrics.js';

/**
 * An absolute ceiling for discarding an oversized body.
 *
 * The declared per-route bound is the real limit. This cap only stops a client
 * from streaming forever after it has already exceeded that bound.
 */
const HARD_DRAIN_LIMIT_BYTES = 33_554_432;

class BodyTooLargeError extends Error {
  constructor() {
    super('request body exceeds the limit for this operation');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read a request body up to `limit`.
 *
 * Over-limit input is answered with a structured 413, so the remaining bytes are
 * drained rather than the socket being destroyed: a reset would reach the client
 * as ECONNRESET and hide the status the contract promises. Nothing past the limit
 * is retained.
 */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      request.resume();
      reject(new BodyTooLargeError());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        if (size > HARD_DRAIN_LIMIT_BYTES) {
          request.destroy();
          reject(new BodyTooLargeError());
        }
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) reject(new BodyTooLargeError());
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
  });
  response.end(payload);
}

/**
 * An untrusted inbound correlation id is accepted only when it is a bounded,
 * header-safe token. Anything else is replaced rather than reflected into a log
 * or a response header.
 */
function acceptedRequestId(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : null;
}

export type HttpServer = {
  listen: () => Promise<{ url: string }>;
  close: () => Promise<void>;
};

export function createHttpServer(input: {
  router: Router;
  host: string;
  port: number;
  requestId: () => string;
  metrics?: MetricsRegistry;
  logger?: Logger;
}): HttpServer {
  const server: Server = createServer((request, response) => {
    const requestId = acceptedRequestId(request.headers['x-request-id']) ?? input.requestId();
    const startedMs = Date.now();
    let status = 500;
    input.metrics?.requestStarted();

    void (async () => {
      let bodyText = '';
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          bodyText = await readBody(
            request,
            input.router.bodyLimitFor(request.method ?? 'GET', request.url ?? '/'),
          );
        }
      } catch {
        status = 413;
        response.setHeader('connection', 'close');
        sendJson(
          response,
          413,
          {
            type: 'https://coderax.dev/problems/validation_failed',
            title: 'validation failed',
            status: 413,
            code: 'validation_failed',
            detail: 'The request body is too large.',
            requestId,
            retryable: false,
          },
          requestId,
        );
        return;
      }

      try {
        const result = await input.router.handle({
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          authorization: request.headers.authorization,
          bodyText,
          requestId,
          idempotencyKey: Array.isArray(request.headers['idempotency-key'])
            ? request.headers['idempotency-key'][0]
            : request.headers['idempotency-key'],
          accept: request.headers.accept,
          lastEventId: Array.isArray(request.headers['last-event-id'])
            ? request.headers['last-event-id'][0]
            : request.headers['last-event-id'],
        });
        status = result.status;

        if (result.kind === 'json') {
          sendJson(response, result.status, result.body, requestId);
          return;
        }

        response.writeHead(result.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          ...(result.headers ?? {}),
          'x-request-id': requestId,
        });
        for await (const frame of result.events) {
          if (response.destroyed || response.writableEnded) break;
          if (frame.id !== undefined) {
            response.write(`id: ${frame.id}\n`);
          }
          response.write(`data: ${JSON.stringify(frame.data)}\n\n`);
        }
        response.end();
      } catch {
        status = 500;
        input.logger?.error('http.request_failed', {
          requestId,
          method: request.method ?? 'GET',
          durationMs: Date.now() - startedMs,
        });
        if (!response.headersSent) {
          sendJson(
            response,
            500,
            {
              type: 'https://coderax.dev/problems/internal_error',
              title: 'internal error',
              status: 500,
              code: 'internal_error',
              detail: 'The request could not be completed.',
              requestId,
              retryable: false,
            },
            requestId,
          );
        } else {
          response.end();
        }
      }
    })().finally(() => {
      input.metrics?.requestFinished(status);
      input.logger?.info('http.request', {
        requestId,
        method: request.method ?? 'GET',
        status,
        durationMs: Date.now() - startedMs,
      });
    });
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(input.port, input.host, () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : input.port;
          resolve({ url: `http://${input.host}:${port}` });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
