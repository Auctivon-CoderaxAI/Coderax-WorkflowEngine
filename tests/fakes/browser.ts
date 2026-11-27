import type {
  BrowserAction,
  BrowserCapabilities,
  BrowserTab,
} from '@coderax/contracts';
import type {
  BrowserProvider,
  ProviderArtifact,
  ProviderCreateInput,
  ProviderElement,
} from '../../src/browser/types.js';
import { emptyFeatures } from '../../src/browser/capabilities.js';

/**
 * A deterministic fake browser provider for tests.
 *
 * It is a test double, not a provider: it performs no real browsing, produces a
 * fixed in-memory page and returns the fixture bytes it is given. The production
 * path is the versioned HTTP protocol adapter; this fake proves engine policy,
 * approval, receipt and artifact handling, never that cloud browsing works.
 */

export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const DEFAULT_ELEMENTS: ProviderElement[] = [
  { elementId: 'el-email', role: 'textbox', name: 'Email', inputType: 'email', disabled: false, focused: true },
  { elementId: 'el-password', role: 'textbox', name: 'Password', inputType: 'password', disabled: false, focused: false },
  { elementId: 'el-submit', role: 'button', name: 'Sign in', disabled: false, focused: false },
  { elementId: 'el-buy', role: 'button', name: 'Buy now', disabled: false, focused: false },
  { elementId: 'el-report', role: 'link', name: 'Download report', disabled: false, focused: false },
];

export type FakeBrowserProvider = BrowserProvider & {
  createInputs: ProviderCreateInput[];
  actions: Array<{ providerSessionId: string; action: BrowserAction }>;
  closed: string[];
  paused: string[];
  resumed: string[];
  released: string[];
  takeoverUrl: string;
  setPage: (page: { text?: string; title?: string; elements?: ProviderElement[] }) => void;
  setCapabilities: (patch: Partial<BrowserCapabilities>) => void;
  setNextArtifacts: (artifacts: ProviderArtifact[] | null) => void;
  setNextUrl: (url: string | null) => void;
  setNextTabs: (tabs: BrowserTab[] | null) => void;
  setInitialUrl: (url: string) => void;
  holdNextPause: () => void;
  releasePause: () => void;
  setScreenshot: (data: Buffer, contentType?: string) => void;
  setDownload: (data: Buffer, contentType?: string) => void;
  failNextAct: () => void;
  failNextCreateUnknown: () => void;
  failNextClose: () => void;
  failNextLifecycleUnknown: () => void;
};

function featuresAllTrue() {
  return {
    ...emptyFeatures(),
    sessions: true,
    navigation: true,
    inspection: true,
    screenshots: true,
    accessibleElements: true,
    forms: true,
    keyboard: true,
    mouse: true,
    tabs: true,
    uploads: true,
    downloads: true,
    sessionPersistence: true,
    pauseResume: true,
    takeover: true,
  };
}

export function fakeBrowserProvider(): FakeBrowserProvider {
  let page = {
    text: 'Example page content.',
    title: 'Example',
    elements: [...DEFAULT_ELEMENTS],
  };
  let capabilities: BrowserCapabilities = {
    provider: 'fake-cloud-browser',
    operational: true,
    reason: 'ready',
    detail: 'Fake browser provider for tests.',
    scope: 'browser',
    costClass: 'free',
    features: featuresAllTrue(),
    limits: {
      maxSessionTtlSeconds: 3600,
      maxSessionsPerOwner: 8,
      maxScreenshotBytes: 2_097_152,
      maxUploadBytes: 524_288,
    },
    checkedAt: new Date().toISOString(),
  };
  let screenshot: { data: Buffer; contentType: string } = {
    data: PNG_1X1,
    contentType: 'image/png',
  };
  let download: { data: Buffer; contentType: string } = {
    data: Buffer.from('%PDF-1.4 fake report\n'),
    contentType: 'application/pdf',
  };
  let nextArtifacts: ProviderArtifact[] | null = null;
  let nextUrl: string | null = null;
  let nextTabs: BrowserTab[] | null = null;
  let initialUrl = 'about:blank';
  let pauseGate: Promise<void> | null = null;
  let releasePauseGate: (() => void) | null = null;
  let failNext = false;
  let failNextCreateUnknownFlag = false;
  let failNextClose = false;
  let failNextLifecycleUnknownFlag = false;
  let tabCounter = 1;

  const sessions = new Map<
    string,
    { url: string; title: string; tabs: BrowserTab[] }
  >();

  const fake: FakeBrowserProvider = {
    kind: 'fake-cloud-browser',
    createInputs: [],
    actions: [],
    closed: [],
    paused: [],
    resumed: [],
    released: [],
    takeoverUrl: 'https://live.example.test/view/one?token=owner-only',

    describe: async () => ({ ...capabilities, checkedAt: new Date().toISOString() }),
    setPage: (next) => {
      page = {
        text: next.text ?? page.text,
        title: next.title ?? page.title,
        elements: next.elements ?? page.elements,
      };
    },
    setCapabilities: (patch) => {
      capabilities = { ...capabilities, ...patch };
    },
    setNextArtifacts: (artifacts) => {
      nextArtifacts = artifacts;
    },
    setNextUrl: (url) => {
      nextUrl = url;
    },
    setNextTabs: (tabs) => {
      nextTabs = tabs;
    },
    setInitialUrl: (url) => {
      initialUrl = url;
    },
    holdNextPause: () => {
      pauseGate = new Promise((resolve) => {
        releasePauseGate = resolve;
      });
    },
    releasePause: () => {
      releasePauseGate?.();
      releasePauseGate = null;
    },
    setScreenshot: (data, contentType = 'image/png') => {
      screenshot = { data, contentType };
    },
    setDownload: (data, contentType = 'application/pdf') => {
      download = { data, contentType };
    },
    failNextAct: () => {
      failNext = true;
    },
    failNextCreateUnknown: () => {
      failNextCreateUnknownFlag = true;
    },
    failNextClose: () => {
      failNextClose = true;
    },
    failNextLifecycleUnknown: () => {
      failNextLifecycleUnknownFlag = true;
    },

    create: async (input) => {
      fake.createInputs.push(input);
      if (failNextCreateUnknownFlag) {
        failNextCreateUnknownFlag = false;
        return {
          ok: false,
          code: 'unavailable',
          detail: 'The fake provider lost the create response.',
          outcomeUnknown: true,
        };
      }
      const providerSessionId = `ps_${fake.createInputs.length}`;
      const tabs: BrowserTab[] = [
        { tabId: 'tab-1', url: initialUrl, title: '', active: true },
      ];
      sessions.set(providerSessionId, { url: initialUrl, title: '', tabs });
      return { ok: true, value: { providerSessionId, url: initialUrl, title: '', tabs } };
    },

    act: async (input) => {
      fake.actions.push({ providerSessionId: input.providerSessionId, action: input.action });
      if (failNext) {
        failNext = false;
        return { ok: false, code: 'unavailable', detail: 'The fake provider is unavailable.' };
      }
      const session = sessions.get(input.providerSessionId);
      if (!session) {
        return { ok: false, code: 'not_configured', detail: 'No fake session exists.' };
      }

      const action = input.action;
      let observation:
        | { text?: string; elements?: ProviderElement[]; truncated?: boolean }
        | undefined;

      if (action.type === 'navigate') {
        session.url = action.url;
        session.title = page.title;
        session.tabs = session.tabs.map((tab) =>
          tab.active ? { ...tab, url: action.url, title: page.title } : tab,
        );
      } else if (action.type === 'inspect') {
        observation = { text: page.text, elements: page.elements, truncated: false };
      } else if (action.type === 'find') {
        const query = action.query?.toLowerCase();
        const role = action.role?.toLowerCase();
        const name = action.name?.toLowerCase();
        observation = {
          elements: page.elements.filter(
            (element) =>
              (!query ||
                element.name.toLowerCase().includes(query) ||
                element.role.toLowerCase().includes(query)) &&
              (!role || element.role.toLowerCase() === role) &&
              (!name || element.name.toLowerCase().includes(name)),
          ),
          truncated: false,
        };
      } else if (action.type === 'tab') {
        if (action.input === 'open' && action.url) {
          tabCounter += 1;
          session.tabs = [
            ...session.tabs,
            { tabId: `tab-${tabCounter}`, url: action.url, title: '', active: false },
          ];
        } else if (action.input === 'activate' && action.tabId) {
          const target = session.tabs.find((tab) => tab.tabId === action.tabId);
          if (target) {
            session.url = target.url;
            session.tabs = session.tabs.map((tab) => ({
              ...tab,
              active: tab.tabId === action.tabId,
            }));
          }
        } else if (action.input === 'close' && action.tabId) {
          session.tabs = session.tabs.filter((tab) => tab.tabId !== action.tabId);
          if (session.tabs.length > 0 && !session.tabs.some((tab) => tab.active)) {
            session.tabs = session.tabs.map((tab, index) => ({ ...tab, active: index === 0 }));
          }
        }
        if (action.input === 'list') {
          observation = { elements: [], truncated: false };
        }
      }

      let artifacts: ProviderArtifact[] = [];
      if (nextArtifacts) {
        artifacts = nextArtifacts;
        nextArtifacts = null;
      } else if (action.type === 'screenshot') {
        artifacts = [
          { kind: 'screenshot', contentType: screenshot.contentType, data: screenshot.data },
        ];
      } else if (action.type === 'download') {
        artifacts = [
          { kind: 'download', contentType: download.contentType, data: download.data },
        ];
      }

      const url = nextUrl ?? session.url;
      const tabs = nextTabs ?? session.tabs;
      nextUrl = null;
      nextTabs = null;
      return {
        ok: true,
        value: {
          url,
          title: session.title,
          tabs,
          ...(observation ? { observation } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
        },
      };
    },

    pause: async (providerSessionId) => {
      fake.paused.push(providerSessionId);
      if (pauseGate) {
        const gate = pauseGate;
        pauseGate = null;
        await gate;
      }
      if (failNextLifecycleUnknownFlag) {
        failNextLifecycleUnknownFlag = false;
        return {
          ok: false,
          code: 'unavailable',
          detail: 'The fake provider lost the pause response.',
          outcomeUnknown: true,
        };
      }
      return { ok: true, value: undefined };
    },
    resume: async (providerSessionId) => {
      fake.resumed.push(providerSessionId);
      if (failNextLifecycleUnknownFlag) {
        failNextLifecycleUnknownFlag = false;
        return {
          ok: false,
          code: 'unavailable',
          detail: 'The fake provider lost the resume response.',
          outcomeUnknown: true,
        };
      }
      return { ok: true, value: undefined };
    },
    takeover: async () => {
      if (failNextLifecycleUnknownFlag) {
        failNextLifecycleUnknownFlag = false;
        return {
          ok: false,
          code: 'unavailable',
          detail: 'The fake provider lost the takeover response.',
          outcomeUnknown: true,
        };
      }
      return { ok: true, value: { interactiveUrl: fake.takeoverUrl } };
    },
    release: async (providerSessionId) => {
      fake.released.push(providerSessionId);
      if (failNextLifecycleUnknownFlag) {
        failNextLifecycleUnknownFlag = false;
        return {
          ok: false,
          code: 'unavailable',
          detail: 'The fake provider lost the release response.',
          outcomeUnknown: true,
        };
      }
      return { ok: true, value: undefined };
    },
    close: async (providerSessionId) => {
      fake.closed.push(providerSessionId);
      if (failNextClose) {
        failNextClose = false;
        return {
          ok: false,
          code: 'unavailable',
          detail: 'The fake provider could not confirm termination.',
        };
      }
      sessions.delete(providerSessionId);
      return { ok: true, value: undefined };
    },
  };

  return fake;
}
