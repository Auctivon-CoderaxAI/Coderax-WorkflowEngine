import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Router } from './router.js';
import type { Logger } from '../observability/logger.js';
import type { MetricsRegistry } from '../observability/metrics.js';

const MAX_BODY_BYTES = 1_048_576;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
          bodyText = await readBody(request);
        }
      } catch {
        status = 413;
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
          ...(typeof request.headers['last-event-id'] === 'string'
            ? { lastEventId: request.headers['last-event-id'] }
            : {}),
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
          'x-request-id': requestId,
        });
        for await (const event of result.events) {
          if (response.destroyed || response.writableEnded) break;
          response.write(`data: ${JSON.stringify(event)}\n\n`);
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
