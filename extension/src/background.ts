import {
  defaultMicroContinuousTicker,
  fetchDrafts,
  getSettings,
  type Draft,
  type HandoffResponse,
  type OverlayPosition,
} from './shared.js';

const POLL_ALARM = 'poll-drafts';
const TRADOVATE_URL = 'https://trader.tradovate.com/';
let lastNotifiedDraftIds = new Set<string>();

interface FillResult {
  filled: string[];
  skipped: string[];
}

function requiredSkippedFields(draft: Draft, fillResult: FillResult): string[] {
  const required = new Set(['side', 'quantity', 'entry']);
  if (draft.takeProfit) required.add('take profit');
  if (draft.stopLoss) required.add('stop loss');
  return fillResult.skipped.filter((field) => required.has(field));
}

async function notifyTicketFillWarning(draft: Draft, skipped: string[]): Promise<void> {
  try {
    await chrome.notifications.create(`ticket-fill-warning-${draft.id}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('warning-icon.png'),
      priority: 2,
      requireInteraction: true,
      title: 'ACTION REQUIRED: TICKET FILL INCOMPLETE',
      message: `WARNING — skipped: ${skipped.join(', ')}. Review the ticket before Send.`,
    });
  } catch (error) {
    console.warn('[bridge] Could not show ticket fill warning', error);
  }
}

export function ensurePollingAlarm(): void {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 });
}

async function waitForTabComplete(tabId: number, timeoutMs: number, navigate?: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab did not finish loading'));
    }, timeoutMs);
    const listener = (updatedTabId: number, changeInfo: chrome.tabs.OnUpdatedInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    void navigate?.().catch((error) => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(error);
    });
  });
}

export async function poll(): Promise<void> {
  const settings = await getSettings();
  if (!settings) return;

  try {
    const drafts = await fetchDrafts(settings);
    console.info('[bridge] Draft poll completed', {
      count: drafts.length,
      drafts: drafts.map((draft) => ({
        id: draft.id,
        ticker: draft.ticker,
        action: draft.action,
        quantity: draft.quantity,
        orderType: draft.orderType,
        stopPrice: draft.stopPrice,
        limitPrice: draft.limitPrice,
      })),
    });
    if (drafts.length === 0) {
      lastNotifiedDraftIds.clear();
      await chrome.action.setBadgeText({ text: '' });
      return;
    }
    await chrome.action.setBadgeText({ text: String(drafts.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
    const draftIds = new Set(drafts.map((draft) => draft.id));
    const hasNewDraft = [...draftIds].some((id) => !lastNotifiedDraftIds.has(id));
    lastNotifiedDraftIds = draftIds;
    if (hasNewDraft) {
      try {
      await chrome.notifications.create('pending-drafts', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title: 'Tradovate order draft ready',
        message: `${drafts.length} order draft${drafts.length === 1 ? '' : 's'} awaiting review.`,
        buttons: [{ title: 'Fill Tradovate ticket' }],
      });
      } catch (error) {
        console.warn('[bridge] Could not show draft notification', error);
      }
    }
  } catch (error) {
    console.warn('[bridge] Draft poll failed', error);
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensurePollingAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  ensurePollingAlarm();
  void poll();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes.settings) return;
  lastNotifiedDraftIds.clear();
  ensurePollingAlarm();
  void poll();
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== 'pending-drafts' || buttonIndex !== 0) return;
  void (async () => {
    const settings = await getSettings();
    if (!settings) return;
    const drafts = await fetchDrafts(settings);
    if (drafts.length !== 1) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
      return;
    }
    const newestDraft = drafts[0];
    if (newestDraft.action === 'cancel') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
      return;
    }
    if (newestDraft) console.info('[bridge] Notification requested ticket fill', await handoffDraft(newestDraft));
  })();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void poll();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId === 'pending-drafts') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
  }
});

async function handoffDraft(draft: Draft): Promise<HandoffResponse> {
  if (draft.action === 'cancel') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
    return {
      delivered: true,
      message: 'Cancellation reminder opened for manual review. No Tradovate ticket was changed.',
    };
  }
  const tradovateDraft = { ...draft, ticker: defaultMicroContinuousTicker(draft.ticker) };
  const settings = await getSettings();
  const overlayPosition: OverlayPosition = settings?.overlayPosition ?? 'bottom-right';
  const tabs = await chrome.tabs.query({ url: 'https://trader.tradovate.com/*' });
  const existingTab = tabs[0];
  const tab = existingTab ?? await chrome.tabs.create({ url: TRADOVATE_URL, active: true });
  if (tab.id == null) return { delivered: false, message: 'Could not open a Tradovate tab.' };

    await chrome.tabs.update(tab.id, { active: true });
    try {
      if (!existingTab) {
      await waitForTabComplete(tab.id, 15_000);
      }
    let response: {
      controls?: unknown[];
      fillResult?: FillResult;
    };
    try {
      response = await chrome.tabs.sendMessage(tab.id, { type: 'fill-draft', draft: tradovateDraft, overlayPosition }) as typeof response;
    } catch {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      response = await chrome.tabs.sendMessage(tab.id, { type: 'fill-draft', draft: tradovateDraft, overlayPosition }) as typeof response;
    }
    console.info('[bridge] Tradovate ticket controls discovered', response.controls ?? []);
    if (response.fillResult) console.info('[bridge] Tradovate ticket fill result', response.fillResult);
    const skipped = response.fillResult ? requiredSkippedFields(draft, response.fillResult) : [];
    if (skipped.length > 0) await notifyTicketFillWarning(draft, skipped);
    return {
      delivered: true,
      message: response.fillResult
        ? `Filled: ${response.fillResult.filled.join(', ') || 'none'}. Verify the Tradovate ticket before Send.`
        : 'Draft is ready for manual entry in Tradovate.',
    };
  } catch {
    await notifyTicketFillWarning(draft, ['ticket connection']);
    return {
      delivered: false,
      message: 'Tradovate was opened. Log in and wait for it to load, then select this draft again.',
    };
  }
}

async function openTradovate(): Promise<HandoffResponse> {
  const tabs = await chrome.tabs.query({ url: 'https://trader.tradovate.com/*' });
  const tab = tabs[0] ?? await chrome.tabs.create({ url: TRADOVATE_URL, active: true });
  if (tab.id == null) return { delivered: false, message: 'Could not open a Tradovate tab.' };
  await chrome.tabs.update(tab.id, { active: true });
  return { delivered: true, message: 'Tradovate opened for manual cancellation.' };
}

chrome.runtime.onMessage.addListener((message: { type: string; draft?: Draft }, _sender, sendResponse) => {
  if (message.type === 'poll-now') {
    void poll();
    return;
  }
  if (message.type === 'handoff-draft' && message.draft) {
    void handoffDraft(message.draft).then(sendResponse);
    return true;
  }
  if (message.type === 'open-tradovate') {
    void openTradovate().then(sendResponse);
    return true;
  }
});
