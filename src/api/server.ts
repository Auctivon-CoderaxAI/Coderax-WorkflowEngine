import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Router } from './router.js';

const MAX_BODY_BYTES = 1_048_576;
/** A client that ignores the bound is cut off rather than read forever. */
const HARD_BODY_BYTES = MAX_BODY_BYTES * 8;

type BodyRead = { text: string } | { tooLarge: true };

/**
 * Reads a request body under a hard bound.
 *
 * An oversized body is drained rather than having its socket destroyed: a client
 * that sent too much must receive the typed 413 that says so, not a reset
 * connection it can only report as a transport failure. Buffering stops as soon
 * as the bound is crossed, and a client that keeps going past the hard limit is
 * disconnected.
 */
function readBody(request: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > HARD_BODY_BYTES) {
        request.destroy();
        reject(new Error('request body is too large'));
        return;
      }
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        resolve({ tooLarge: true });
        return;
      }
      resolve({ text: Buffer.concat(chunks).toString('utf8') });
    });
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export type HttpServer = {
  listen: () => Promise<{ url: string }>;
  close: () => Promise<void>;
};

export function createHttpServer(input: {
  router: Router;
  host: string;
  port: number;
}): HttpServer {
  const server: Server = createServer((request, response) => {
    void (async () => {
      let bodyText = '';
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          const body = await readBody(request);
          if ('tooLarge' in body) {
            sendJson(response, 413, {
              type: 'https://coderax.dev/problems/validation_failed',
              title: 'validation failed',
              status: 413,
              code: 'validation_failed',
              detail: 'The request body is too large.',
              retryable: false,
            });
            return;
          }
          bodyText = body.text;
        }
      } catch {
        sendJson(response, 413, {
          type: 'https://coderax.dev/problems/validation_failed',
          title: 'validation failed',
          status: 413,
          code: 'validation_failed',
          detail: 'The request body is too large.',
          retryable: false,
        });
        return;
      }

      try {
        const result = await input.router.handle({
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          authorization: request.headers.authorization,
          accept: typeof request.headers.accept === 'string' ? request.headers.accept : undefined,
          bodyText,
        });

        if (result.kind === 'json') {
          sendJson(response, result.status, result.body);
          return;
        }

        response.writeHead(result.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        for await (const event of result.events) {
          if (response.destroyed || response.writableEnded) break;
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      } catch {
        if (!response.headersSent) {
          sendJson(response, 500, {
            type: 'https://coderax.dev/problems/internal_error',
            title: 'internal error',
            status: 500,
            code: 'internal_error',
            detail: 'The request could not be completed.',
            retryable: false,
          });
        } else {
          response.end();
        }
      }
    })();
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
