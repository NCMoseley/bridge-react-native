import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Listener<T extends (...args: any[]) => unknown> {
  addListener: ReturnType<typeof vi.fn<(callback: T) => void>>;
}

interface ChromeMock {
  action: {
    setBadgeBackgroundColor: ReturnType<typeof vi.fn>;
    setBadgeText: ReturnType<typeof vi.fn>;
  };
  alarms: {
    create: ReturnType<typeof vi.fn>;
    onAlarm: Listener<(alarm: { name: string }) => void>;
  };
  notifications: {
    create: ReturnType<typeof vi.fn>;
    onButtonClicked: Listener<(notificationId: string, buttonIndex: number) => void>;
    onClicked: Listener<(notificationId: string) => void>;
  };
  runtime: {
    getURL: ReturnType<typeof vi.fn<(path: string) => string>>;
    onInstalled: Listener<() => void>;
    onMessage: Listener<(message: { type: string; draft?: unknown }, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void>;
    onStartup: Listener<() => void>;
  };
  scripting: {
    executeScript: ReturnType<typeof vi.fn>;
  };
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
    onChanged: Listener<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void>;
  };
  tabs: {
    create: ReturnType<typeof vi.fn>;
    onUpdated: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    };
    query: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function createChromeMock(): ChromeMock {
  return {
    action: {
      setBadgeBackgroundColor: vi.fn().mockResolvedValue(undefined),
      setBadgeText: vi.fn().mockResolvedValue(undefined),
    },
    alarms: {
      create: vi.fn(),
      onAlarm: { addListener: vi.fn() },
    },
    notifications: {
      create: vi.fn().mockResolvedValue(undefined),
      onButtonClicked: { addListener: vi.fn() },
      onClicked: { addListener: vi.fn() },
    },
    runtime: {
      getURL: vi.fn((path: string) => `chrome-extension://${path}`),
      onInstalled: { addListener: vi.fn() },
      onMessage: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue(undefined),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({
          settings: {
            bridgeUrl: 'https://bridge.example.test',
            extensionToken: 'token-1',
          },
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      onUpdated: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('extension background polling', () => {
  let chromeMock: ChromeMock;
  let installListener: (() => void) | undefined;
  let startupListener: (() => void) | undefined;
  let notificationButtonListener:
    | ((notificationId: string, buttonIndex: number) => void)
    | undefined;
  let storageChangedListener:
    | ((changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void)
    | undefined;

  beforeEach(async () => {
    vi.resetModules();
    chromeMock = createChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      drafts: [{
        id: 'draft-1',
        ticker: 'MNQ1!',
        action: 'buy',
        quantity: 1,
        orderType: 'market',
        receivedAt: '2026-08-03T20:00:00.000Z',
        status: 'pending',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    await import('../extension/src/background.ts');

    installListener = chromeMock.runtime.onInstalled.addListener.mock.calls[0]?.[0];
    startupListener = chromeMock.runtime.onStartup.addListener.mock.calls[0]?.[0];
    notificationButtonListener = chromeMock.notifications.onButtonClicked.addListener.mock.calls[0]?.[0];
    storageChangedListener = chromeMock.storage.onChanged.addListener.mock.calls[0]?.[0];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-establishes polling and polls drafts on startup', async () => {
    expect(startupListener).toBeTypeOf('function');

    startupListener?.();
    await vi.waitFor(() => {
      expect(chromeMock.alarms.create).toHaveBeenCalledWith('poll-drafts', { periodInMinutes: 0.5 });
      expect(fetch).toHaveBeenCalledWith('https://bridge.example.test/api/drafts', {
        headers: { 'x-extension-token': 'token-1' },
      });
      expect(chromeMock.notifications.create).toHaveBeenCalledWith('pending-drafts', expect.objectContaining({
        title: 'Tradovate order draft ready',
      }));
    });
  });

  it('repolls immediately when saved bridge settings change', async () => {
    expect(storageChangedListener).toBeTypeOf('function');
    chromeMock.storage.local.get.mockResolvedValue({
      settings: {
        bridgeUrl: 'https://bridge.example.test',
        extensionToken: 'token-2',
      },
    });

    storageChangedListener?.({
      settings: {
        oldValue: {
          bridgeUrl: 'https://bridge.example.test',
          extensionToken: 'token-1',
        },
        newValue: {
          bridgeUrl: 'https://bridge.example.test',
          extensionToken: 'token-2',
        },
      },
    }, 'local');

    await vi.waitFor(() => {
      expect(chromeMock.alarms.create).toHaveBeenCalledWith('poll-drafts', { periodInMinutes: 0.5 });
      expect(fetch).toHaveBeenCalledWith('https://bridge.example.test/api/drafts', {
        headers: { 'x-extension-token': 'token-2' },
      });
    });
  });

  it('creates the polling alarm when the extension is installed', () => {
    expect(installListener).toBeTypeOf('function');

    installListener?.();

    expect(chromeMock.alarms.create).toHaveBeenCalledWith('poll-drafts', { periodInMinutes: 0.5 });
  });

  it('opens the review page from the notification button when multiple drafts are pending', async () => {
    expect(notificationButtonListener).toBeTypeOf('function');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      drafts: [
        {
          id: 'draft-1',
          ticker: 'MGC1!',
          action: 'sell',
          quantity: 4,
          orderType: 'stop',
          stopPrice: 4391.7,
          receivedAt: '2026-08-07T19:15:00.000Z',
          status: 'pending',
        },
        {
          id: 'draft-2',
          ticker: 'MGC1!',
          action: 'buy',
          quantity: 4,
          orderType: 'stop',
          stopPrice: 4406,
          receivedAt: '2026-08-07T19:15:00.000Z',
          status: 'pending',
        },
      ],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    notificationButtonListener?.('pending-drafts', 0);

    await vi.waitFor(() => {
      expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://review.html' });
    });
    expect(chromeMock.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
