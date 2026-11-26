import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Router } from './router.js';

const MAX_BODY_BYTES = 1_048_576;

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
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
          const limit =
            input.router.bodyLimit(
              request.method ?? 'GET',
              request.url ?? '/',
            ) ?? MAX_BODY_BYTES;
          bodyText = await readBody(request, limit);
        }
      } catch {
        sendJson(response, 413, {
          type: 'https://coderax.dev/problems/payload_too_large',
          title: 'payload too large',
          status: 413,
          code: 'payload_too_large',
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
          bodyText,
          accept: Array.isArray(request.headers.accept)
            ? request.headers.accept.join(', ')
            : request.headers.accept,
          lastEventId: Array.isArray(request.headers['last-event-id'])
            ? request.headers['last-event-id'][0]
            : request.headers['last-event-id'],
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
          if (event.id) response.write(`id: ${event.id}\n`);
          response.write(`data: ${JSON.stringify(event.data)}\n\n`);
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
