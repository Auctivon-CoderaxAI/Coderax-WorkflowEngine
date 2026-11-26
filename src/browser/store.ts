import type {
  BrowserArtifact,
  BrowserElement,
  BrowserReceipt,
  BrowserSession,
} from '@coderax/contracts';

/**
 * Process-local control-plane records.
 *
 * Browser sessions live in the provider; this store keeps the owner scope, the
 * provider handle, the last observed elements and the append-only receipts. A
 * restart therefore loses control of a live session rather than inventing one:
 * the provider expires it, and no receipt survives that did not happen.
 *
 * Artifacts are bounded so a long research session cannot grow engine memory
 * without limit. Evicted artifacts remain named by their receipt, but their
 * content is gone; the API reports not_found rather than fabricating bytes.
 */

export type StoredBrowserSession = {
  ownerId: string;
  providerSessionId: string;
  session: BrowserSession;
  lastElements: BrowserElement[];
};

export type StoredBrowserArtifact = {
  ownerId: string;
  artifact: BrowserArtifact;
  data: Buffer;
};

export type BrowserStore = {
  putSession: (record: StoredBrowserSession) => void;
  session: (ownerId: string, sessionId: string) => StoredBrowserSession | null;
  sessions: (ownerId: string) => StoredBrowserSession[];
  updateSession: (record: StoredBrowserSession) => void;
  liveSessions: () => StoredBrowserSession[];
  addReceipt: (input: { ownerId: string; receipt: BrowserReceipt }) => void;
  receipts: (ownerId: string, sessionId: string) => BrowserReceipt[];
  addArtifact: (record: StoredBrowserArtifact) => void;
  artifact: (ownerId: string, artifactId: string) => StoredBrowserArtifact | null;
};

export function createBrowserStore(input: {
  maxReceiptsPerSession?: number;
  maxArtifacts?: number;
  maxArtifactBytes?: number;
} = {}): BrowserStore {
  const sessions = new Map<string, StoredBrowserSession>();
  const receipts = new Map<string, BrowserReceipt[]>();
  const artifacts = new Map<string, StoredBrowserArtifact>();
  const maxReceipts = input.maxReceiptsPerSession ?? 500;
  const maxArtifacts = input.maxArtifacts ?? 256;
  const maxArtifactBytes = input.maxArtifactBytes ?? 64 * 1024 * 1024;
  let artifactBytes = 0;

  function receiptKey(ownerId: string, sessionId: string): string {
    return `${ownerId}\u0000${sessionId}`;
  }

  function evictArtifacts(): void {
    while (artifacts.size > maxArtifacts || artifactBytes > maxArtifactBytes) {
      const oldest = artifacts.keys().next();
      if (oldest.done) break;
      const entry = artifacts.get(oldest.value);
      artifacts.delete(oldest.value);
      if (entry) artifactBytes -= entry.data.length;
    }
  }

  return {
    putSession: (record) => {
      sessions.set(record.session.sessionId, record);
    },
    session: (ownerId, sessionId) => {
      const record = sessions.get(sessionId);
      return record && record.ownerId === ownerId ? record : null;
    },
    sessions: (ownerId) =>
      [...sessions.values()].filter((record) => record.ownerId === ownerId),
    updateSession: (record) => {
      sessions.set(record.session.sessionId, record);
    },
    liveSessions: () =>
      [...sessions.values()].filter(
        (record) =>
          record.session.state === 'ready' ||
          record.session.state === 'paused' ||
          record.session.state === 'owner_controlled' ||
          record.session.state === 'creating',
      ),
    addReceipt: ({ ownerId, receipt }) => {
      const key = receiptKey(ownerId, receipt.sessionId);
      const list = receipts.get(key) ?? [];
      list.push(receipt);
      if (list.length > maxReceipts) list.splice(0, list.length - maxReceipts);
      receipts.set(key, list);
    },
    receipts: (ownerId, sessionId) => [...(receipts.get(receiptKey(ownerId, sessionId)) ?? [])],
    addArtifact: (record) => {
      artifacts.set(record.artifact.artifactId, record);
      artifactBytes += record.data.length;
      evictArtifacts();
    },
    artifact: (ownerId, artifactId) => {
      const record = artifacts.get(artifactId);
      return record && record.ownerId === ownerId ? record : null;
    },
  };
}
