import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Router } from './router.js';

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
          bodyText = await readBody(request);
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
          headers: request.headers as Record<string, string | undefined>,
          bodyText,
          accept: request.headers.accept,
        });

        if (result.kind === 'json') {
          sendJson(response, result.status, result.body);
          return;
        }

        response.once('close', result.close);
        if (response.destroyed) { result.close(); return; }
        try {
          response.writeHead(result.status, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          for await (const event of result.events) {
            if (response.destroyed || response.writableEnded) break;
            // The SSE id carries the per-task sequence, so a browser reconnect sends
            // Last-Event-ID and resumes after the last frame it actually rendered.
            const seq =
              typeof event === 'object' && event !== null
                ? (event as { seq?: unknown }).seq
                : undefined;
            if (typeof seq === 'number') response.write(`id: ${seq}\n`);
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end();
        } finally {
          response.off('close', result.close);
          result.close();
        }
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
