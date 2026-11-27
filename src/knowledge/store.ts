import { credentialEndpoint } from '../security/endpoint.js';
import type {
  DataMode,
  KnowledgeIngestResult,
  KnowledgeList,
  KnowledgeSearchResult,
} from '@coderax/contracts';
import type { ServiceResult } from '../support/result.js';
import { fail, ok } from '../support/result.js';
import type { Clock, IdGenerator } from '../support/clock.js';

/**
 * Retrieval is partitioned by owner and data mode, exactly like memory. A cloud
 * run cannot retrieve a private document because the partition is part of the
 * lookup key. When an embedding provider is configured the store ranks by cosine
 * similarity; otherwise it ranks lexically and reports that honestly, so a
 * deployment without embeddings still has useful retrieval instead of a
 * capability that pretends to be vector search.
 */

export type EmbeddingProvider = {
  id: string;
  cloudOnly?: boolean;
  embed: (texts: string[]) => Promise<number[][]>;
};

export type KnowledgeStore = {
  ingest: (input: {
    ownerId: string;
    mode: DataMode;
    title: string;
    text: string;
  }) => Promise<ServiceResult<KnowledgeIngestResult>>;
  search: (input: {
    ownerId: string;
    mode: DataMode;
    query: string;
    k: number;
  }) => Promise<KnowledgeSearchResult>;
  list: (input: { ownerId: string; mode: DataMode }) => Promise<KnowledgeList>;
};

type Chunk = { text: string; vector: number[] | null };
type Document = {
  documentId: string;
  ownerId: string;
  mode: DataMode;
  title: string;
  createdAt: string;
  chunks: Chunk[];
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'but', 'not',
  'you', 'your', 'our', 'has', 'have', 'had', 'its', 'into', 'about', 'than', 'then', 'they',
  'them', 'their', 'will', 'can', 'could', 'should', 'would', 'what', 'when', 'where', 'which',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 > size) {
      chunks.push(current.trim());
      current = overlap > 0 ? current.slice(Math.max(0, current.length - overlap)) : '';
    }
    current = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    // A single paragraph can exceed the target; split it on sentence/word edges.
    while (current.length > size * 2) {
      const boundary = current.lastIndexOf('. ', size - 2);
      const cut = boundary >= overlap ? boundary + 2 : size;
      chunks.push(current.slice(0, cut).trim());
      current = current.slice(Math.max(1, cut - overlap));
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());
  return chunks.slice(0, 500);
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function createKnowledgeStore(input: {
  clock: Clock;
  ids: IdGenerator;
  embeddings: EmbeddingProvider | null;
  maxDocuments?: number;
}): KnowledgeStore {
  const documents = new Map<string, Document>();
  const maxDocuments = input.maxDocuments ?? 500;

  function partition(ownerId: string, mode: DataMode): Document[] {
    return [...documents.values()].filter(
      (document) => document.ownerId === ownerId && document.mode === mode,
    );
  }

  return {
    ingest: async ({ ownerId, mode, title, text }) => {
      if (partition(ownerId, mode).length >= maxDocuments) {
        return fail('conflict', 'The knowledge store is full for this data mode.');
      }
      const pieces = chunkText(text);
      if (pieces.length === 0) {
        return fail('validation_failed', 'The document contains no indexable text.');
      }

      let vectors: number[][] | null = null;
      if (input.embeddings && !(mode === 'private' && input.embeddings.cloudOnly)) {
        try {
          vectors = await input.embeddings.embed(pieces);
          if (vectors.length !== pieces.length) vectors = null;
        } catch {
          // Retrieval still works lexically; the result says so.
          vectors = null;
        }
      }

      const documentId = `doc_${input.ids.receipt().slice(5)}`;
      const createdAt = input.clock.iso();
      documents.set(documentId, {
        documentId,
        ownerId,
        mode,
        title: title.slice(0, 300),
        createdAt,
        chunks: pieces.map((piece, index) => ({
          text: piece,
          vector: vectors?.[index] ?? null,
        })),
      });

      return ok({
        documentId,
        title: title.slice(0, 300),
        chunks: pieces.length,
        embedding: vectors ? 'semantic' : 'lexical',
        createdAt,
      });
    },

    search: async ({ ownerId, mode, query, k }) => {
      const scoped = partition(ownerId, mode);
      if (scoped.length === 0) return { hits: [], embedding: 'lexical' };

      let queryVector: number[] | null = null;
      if (input.embeddings && !(mode === 'private' && input.embeddings.cloudOnly)) {
        try {
          const embedded = await input.embeddings.embed([query]);
          queryVector = embedded[0] ?? null;
        } catch {
          queryVector = null;
        }
      }

      const terms = tokenize(query);
      const allChunks = scoped.flatMap((document) =>
        document.chunks.map((chunk) => ({ document, chunk })),
      );
      const documentFrequency = new Map<string, number>();
      for (const term of new Set(terms)) {
        documentFrequency.set(
          term,
          allChunks.filter(({ chunk }) => tokenize(chunk.text).includes(term)).length,
        );
      }

      const scored = allChunks.map(({ document, chunk }) => {
        let score = 0;
        if (queryVector && chunk.vector) {
          score = cosine(queryVector, chunk.vector);
        } else if (terms.length > 0) {
          const tokens = tokenize(chunk.text);
          const counts = new Map<string, number>();
          for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
          for (const term of terms) {
            const frequency = counts.get(term) ?? 0;
            if (frequency === 0) continue;
            const df = documentFrequency.get(term) ?? 0;
            const idf = Math.log((allChunks.length + 1) / (df + 1)) + 1;
            score += (frequency / Math.sqrt(tokens.length || 1)) * idf;
          }
          if (terms.length > 0 && query.trim().length >= 4 && chunk.text.toLowerCase().includes(query.toLowerCase())) {
            score += 0.5;
          }
        }
        return { document, chunk, score };
      });

      const ranked = scored
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, k);
      const maximum = ranked[0]?.score ?? 0;
      return {
        embedding: queryVector && ranked.some((entry) => entry.chunk.vector) ? 'semantic' : 'lexical',
        hits: ranked.map((entry) => ({
          documentId: entry.document.documentId,
          title: entry.document.title,
          text: entry.chunk.text,
          score: maximum > 0 ? Math.min(1, entry.score / maximum) : 0,
        })),
      };
    },

    list: async ({ ownerId, mode }) => ({
      documents: partition(ownerId, mode).map((document) => ({
        documentId: document.documentId,
        title: document.title,
        chunks: document.chunks.length,
        mode: document.mode,
        createdAt: document.createdAt,
      })),
    }),
  };
}

/**
 * An OpenAI-compatible embeddings endpoint. The key is supplied by name from the
 * caller and never logged or embedded in a URL.
 */
export function createOpenAiEmbeddingProvider(input: {
  baseURL: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): EmbeddingProvider {
  const endpoint = credentialEndpoint(input.baseURL);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/embeddings';
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 20_000;
  return {
    id: 'openai-compatible',
    cloudOnly: true,
    embed: async (texts) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint.href, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({ model: input.model, input: texts }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`embeddings responded with HTTP ${response.status}`);
        const body = (await response.json()) as {
          data?: Array<{ embedding?: unknown }>;
        };
        const rows = body.data ?? [];
        if (rows.length !== texts.length) throw new Error('embeddings response was incomplete');
        return rows.map((row) => {
          if (!Array.isArray(row.embedding) || row.embedding.some((value) => typeof value !== 'number')) {
            throw new Error('embeddings response was not numeric');
          }
          return row.embedding as number[];
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
