import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Router } from './router.js';

const MAX_BODY_BYTES = 1_048_576;
const OVERFLOW_DRAIN_MS = 1_000;

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        request.pause();
        request.off('data', onData);
        chunks.length = 0;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
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
  const streamShutdown = new AbortController();
  const server: Server = createServer((request, response) => {
    void (async () => {
      let bodyText = '';
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          const limit =
            input.router.bodyLimit(
              request.method ?? 'GET',
              request.url ?? '/',
              request.headers.authorization,
            ) ?? MAX_BODY_BYTES;
          bodyText = await readBody(request, limit);
        }
      } catch {
        // Give the 413 a chance to flush while discarding in-flight bytes.
        // Closing the connection normally cancels this deadline; a peer that
        // keeps the connection open cannot make the drain run indefinitely.
        const socket = request.socket;
        const deadline = setTimeout(() => socket.destroy(), OVERFLOW_DRAIN_MS);
        deadline.unref();
        socket.once('close', () => clearTimeout(deadline));
        request.resume();
        response.setHeader('connection', 'close');
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

      const disconnected = new AbortController();
      response.once('close', () => disconnected.abort());
      try {
        const result = await input.router.handle({
          method: request.method ?? 'GET',
          path: request.url ?? '/',
          authorization: request.headers.authorization,
          bodyText,
          signal: AbortSignal.any([streamShutdown.signal, disconnected.signal]),
          lastEventId: Array.isArray(request.headers['last-event-id'])
            ? request.headers['last-event-id'][0]
            : request.headers['last-event-id'],
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
          // Closing the response must also release its connection during shutdown.
          connection: 'close',
        });
        response.flushHeaders();
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

  let closePromise: Promise<void> | null = null;
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
    close: () => {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        streamShutdown.abort();
      });
      return closePromise;
    },
  };
}
