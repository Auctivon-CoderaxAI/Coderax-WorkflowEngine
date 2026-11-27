import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Router } from './router.js';

const MAX_BODY_BYTES = 1_048_576;

export class BodyTooLargeError extends Error {
  constructor() {
    super('request body is too large');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Reads a body up to the operation's ceiling.
 *
 * An over-limit body is not destroyed: the socket keeps draining so the client
 * receives the 413 it is entitled to read. Destroying mid-upload surfaces as a
 * reset on the client, which is indistinguishable from a network failure and
 * hides the contract's own error code.
 */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        // Release what was buffered; the remaining bytes are read and dropped.
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (overflow) reject(new BodyTooLargeError());
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  close = false,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...(close ? { connection: 'close' } : {}),
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
          const limit =
            input.router.bodyLimit(
              request.method ?? 'GET',
              request.url ?? '/',
            ) ?? MAX_BODY_BYTES;
          bodyText = await readBody(request, limit);
        }
      } catch {
        // The connection closes after this response because the rest of the
        // oversized body still has to be discarded.
        sendJson(
          response,
          413,
          {
            type: 'https://coderax.dev/problems/payload_too_large',
            title: 'payload too large',
            status: 413,
            code: 'payload_too_large',
            detail: 'The request body is too large.',
            retryable: false,
          },
          true,
        );
        return;
      }

      try {
        const result = await input.router.handle({
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          authorization: request.headers.authorization,
          bodyText,
        });

        if (result.kind === 'json') {
          sendJson(response, result.status, result.body);
          return;
        }

        if (result.kind === 'text') {
          response.writeHead(result.status, {
            'content-type': result.contentType,
            'cache-control': 'no-store',
            // The preview is a self-contained document with no external loads.
            'content-security-policy':
              "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
            'x-content-type-options': 'nosniff',
            'content-length': Buffer.byteLength(result.body),
          });
          response.end(result.body);
          return;
        }

        response.writeHead(result.status, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        for await (const frame of result.events) {
          if (response.destroyed || response.writableEnded) break;
          response.write(
            frame.kind === 'comment'
              ? `: ${frame.comment}\n\n`
              : `data: ${JSON.stringify(frame.event)}\n\n`,
          );
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
