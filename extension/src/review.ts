import {
  displayPercent,
  fetchDrafts,
  fetchRecentDrafts,
  formatPrice,
  getSettings,
  percentAsDecimal,
  resolveContinuousTicker,
  roundPrice,
  strategyStopPresentation,
  type Draft,
  type ExtensionSettings,
  type RecentDraftHistoryOptions,
} from './shared.js';

const status = document.querySelector<HTMLElement>('#connection-status')!;
const draftsContainer = document.querySelector<HTMLElement>('#drafts')!;
const recentDraftsContainer = document.querySelector<HTMLElement>('#recent-drafts')!;
const recentDraftSummary = document.querySelector<HTMLElement>('#recent-drafts-summary')!;
const recentDraftFilters = document.querySelector<HTMLFormElement>('#recent-draft-filters')!;
const recentDraftRangeField = document.querySelector<HTMLSelectElement>('#recent-draft-range')!;
const recentDraftSinceField = document.querySelector<HTMLSelectElement>('#recent-draft-since')!;
const recentDraftQueryField = document.querySelector<HTMLInputElement>('#recent-draft-query')!;
const recentDraftAccountField = document.querySelector<HTMLSelectElement>('#recent-draft-account')!;
const RECENT_DRAFT_SINCE_HOURS = 12;
const RECENT_DRAFT_LIMIT = 200;
const LOCAL_STORAGE_SETTINGS_KEY = 'bridge-review-settings';
const IS_EXTENSION_CONTEXT = typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined' && typeof chrome.runtime.sendMessage === 'function';
let recentDraftReloadTimer: number | undefined;

async function getReviewSettings(): Promise<ExtensionSettings | undefined> {
  try {
    const settings = await getSettings();
    if (settings) return settings;
  } catch { /* not running inside the extension */ }

  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(LOCAL_STORAGE_SETTINGS_KEY);
    if (stored) {
      try {
        return JSON.parse(stored) as ExtensionSettings;
      } catch { /* ignore malformed stored settings */ }
    }
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (token) {
    const settings = {
      bridgeUrl: params.get('bridgeUrl') ?? window.location.origin,
      extensionToken: token,
    };
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(LOCAL_STORAGE_SETTINGS_KEY, JSON.stringify(settings));
      } catch { /* ignore storage failures */ }
    }
    return settings;
  }

  return undefined;
}

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function formatDraftAge(receivedAt: string): string {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - new Date(receivedAt).getTime()) / 1000));
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s old` : `${minutes}m ${seconds}s old`;
}

function updateDraftAges(): void {
  for (const age of Array.from(document.querySelectorAll<HTMLElement>('[data-draft-received-at]'))) {
    age.textContent = `Age: ${formatDraftAge(age.dataset.draftReceivedAt!)}`;
  }
}

function renderEmptyState(message: string): HTMLElement {
  const state = document.createElement('div');
  state.className = 'empty-state';
  state.textContent = message;
  return state;
}

function entryPrice(draft: Draft): number | undefined {
  return draft.stopPrice ?? draft.limitPrice ?? draft.signalPrice;
}

function absoluteProtection(draft: Draft, field: 'takeProfit' | 'stopLoss'): number | undefined {
  const protection = draft[field];
  if (!protection) return undefined;
  const directPrice = field === 'takeProfit' ? protection.limitPrice : protection.stopPrice;
  if (typeof directPrice === 'number') return directPrice;
  const percent = protection.percent;
  const entry = entryPrice(draft);
  if (typeof percent !== 'number' || entry == null) return undefined;
  const decimal = percentAsDecimal(percent);
  const isBuy = draft.action === 'buy';
  if (field === 'takeProfit') return entry * (isBuy ? 1 + decimal : 1 - decimal);
  return entry * (isBuy ? 1 - decimal : 1 + decimal);
}

function formatProtection(draft: Draft, field: 'takeProfit' | 'stopLoss'): string {
  const protection = draft[field];
  const absolute = absoluteProtection(draft, field);
  const entry = entryPrice(draft);
  if (!protection || absolute == null) return 'Not provided';
  const parts = [formatPrice(draft.ticker, absolute)];
  if (entry != null) {
    const distance = Math.abs(roundPrice(draft.ticker, absolute) - roundPrice(draft.ticker, entry));
    parts.push(`${formatPrice(draft.ticker, distance)} away`);
  }
  if (typeof protection.percent === 'number') parts.push(`${displayPercent(protection.percent)}%`);
  return parts.join(' | ');
}

function formatStrategyStop(draft: Draft, strategyStopPrice: number): string {
  const parts = [formatPrice(draft.ticker, strategyStopPrice)];
  const entry = entryPrice(draft);
  if (entry != null) {
    const distance = Math.abs(roundPrice(draft.ticker, strategyStopPrice) - roundPrice(draft.ticker, entry));
    parts.push(`${formatPrice(draft.ticker, distance)} away`);
  }
  return parts.join(' | ');
}

const CONTRACT_ALTERNATIVES: Record<string, string[]> = {
  MNQ: ['MNQ', 'NQ'],
  NQ: ['MNQ', 'NQ'],
  MES: ['MES', 'ES'],
  ES: ['MES', 'ES'],
  MYM: ['MYM', 'YM'],
  YM: ['MYM', 'YM'],
  MGC: ['MGC', 'GC'],
  GC: ['MGC', 'GC'],
};

function tickerRoot(ticker: string): string | undefined {
  return Object.keys(CONTRACT_ALTERNATIVES)
    .sort((left, right) => right.length - left.length)
    .find((root) => ticker.startsWith(root));
}

function tickerForRoot(ticker: string, root: string): string {
  const currentRoot = tickerRoot(ticker);
  return currentRoot ? `${root}${ticker.slice(currentRoot.length)}` : ticker;
}

async function rejectDraft(settings: ExtensionSettings, draft: Draft): Promise<void> {
  const response = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/api/drafts/${draft.id}/rejected`, {
    method: 'POST',
    headers: { 'x-extension-token': settings.extensionToken },
  });
  if (!response.ok) throw new Error(`Could not reject draft (${response.status})`);
}

async function markSubmitted(settings: ExtensionSettings, draft: Draft): Promise<void> {
  const response = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/api/drafts/${draft.id}/submitted`, {
    method: 'POST',
    headers: { 'x-extension-token': settings.extensionToken },
  });
  if (!response.ok) throw new Error(`Could not mark draft submitted (${response.status})`);
}

async function fillTradovateTicket(draft: Draft): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: 'handoff-draft',
    draft,
  }) as { delivered: boolean; message: string };
  setStatus(response.message, !response.delivered);
}

async function openTradovate(): Promise<void> {
  const response = await chrome.runtime.sendMessage({
    type: 'open-tradovate',
  }) as { delivered: boolean; message: string };
  setStatus(response.message, !response.delivered);
}

function appendTradovateReuseControls(item: HTMLElement, draft: Draft, buttonLabel: string): void {
  const root = tickerRoot(draft.ticker);
  const contract = document.createElement('label');
  contract.className = 'contract-selector';
  contract.textContent = 'Tradovate contract';
  const select = document.createElement('select');
  const alternatives = root ? CONTRACT_ALTERNATIVES[root] : [draft.ticker];
  for (const alternative of alternatives) {
    const option = document.createElement('option');
    option.value = tickerForRoot(draft.ticker, alternative);
    option.textContent = option.value;
    select.append(option);
  }
  const contractNote = document.createElement('span');
  contractNote.textContent = root
    ? 'Choose the micro or full-size contract. The alert’s expiry code is retained.'
    : 'No alternate contract is configured for this symbol.';
  contract.append(select, contractNote);
  if (!IS_EXTENSION_CONTEXT) {
    const note = document.createElement('small');
    note.textContent = 'Trade filling is only available inside the Chrome extension.';
    item.append(contract, note);
    return;
  }
  const fill = document.createElement('button');
  fill.type = 'button';
  fill.textContent = buttonLabel;
  fill.addEventListener('click', async () => {
    fill.disabled = true;
    try {
      await fillTradovateTicket({ ...draft, ticker: resolveContinuousTicker(select.value) });
    } catch {
      setStatus('Could not hand this draft to Tradovate.', true);
    } finally {
      fill.disabled = false;
    }
  });
  item.append(contract, fill);
}

function renderDraft(
  settings: ExtensionSettings,
  draft: Draft,
  options: { actionable: boolean; reusable?: boolean },
): HTMLElement {
  const item = document.createElement('article');
  item.className = `draft${draft.action === 'cancel' && draft.status === 'pending' ? ' cancellation-reminder' : ''}`;
  const heading = document.createElement('h2');
  heading.className = draft.action;
  heading.textContent = draft.action === 'cancel'
    ? draft.cancellationMessage ?? 'Cancel opposite entry'
    : `${draft.action.toUpperCase()} ${draft.quantity} ${draft.ticker}${draft.rangeName ? ` - ${draft.rangeName}` : ''}${draft.orderLeg ? ` (${draft.orderLeg})` : ''}${draft.accountName ? ` - ${draft.accountName}` : ''}`;
  const grid = document.createElement('div');
  grid.className = 'draft-grid';
  if (draft.action === 'cancel') {
    const message = document.createElement('strong');
    message.textContent = `Review and cancel the opposite ${draft.ticker} entry in Tradovate.`;
    grid.append(message);
    if (draft.accountName) {
      const account = document.createElement('div');
      const accountLabel = document.createElement('span');
      accountLabel.textContent = 'Account';
      const accountValue = document.createElement('strong');
      accountValue.textContent = draft.accountName;
      account.append(accountLabel, accountValue);
      grid.append(account);
    }
  } else {
    const strategyStop = strategyStopPresentation(draft);
    const takeProfit = absoluteProtection(draft, 'takeProfit');
    const stopLoss = absoluteProtection(draft, 'stopLoss');
    const fields: Array<{ label: string; value: string; note?: string; copyValue?: string }> = [
      { label: 'Side', value: draft.action.toUpperCase() },
      { label: 'Quantity', value: String(draft.quantity), copyValue: String(draft.quantity) },
      { label: 'Order type', value: draft.orderType.toUpperCase() },
      {
        label: 'Entry',
        value: formatPrice(draft.ticker, entryPrice(draft)),
        copyValue: entryPrice(draft) != null ? formatPrice(draft.ticker, entryPrice(draft)) : undefined,
      },
      { label: 'Account', value: draft.accountName ?? 'Unassigned' },
      {
        label: 'Take profit',
        value: formatProtection(draft, 'takeProfit'),
        copyValue: takeProfit != null ? formatPrice(draft.ticker, takeProfit) : undefined,
      },
      ...(strategyStop
        ? [{
          label: strategyStop.label,
          value: formatStrategyStop(draft, strategyStop.price),
          note: 'Informational only — not filled into Tradovate.',
          copyValue: formatPrice(draft.ticker, strategyStop.price),
        }]
        : [{
          label: 'Stop loss',
          value: formatProtection(draft, 'stopLoss'),
          copyValue: stopLoss != null ? formatPrice(draft.ticker, stopLoss) : undefined,
        }]),
    ];
    for (const { label, value, note, copyValue } of fields) {
      const field = document.createElement('div');
      const labelElement = document.createElement('span');
      labelElement.textContent = label;
      field.append(labelElement);
      if (copyValue != null) {
        const valueRow = document.createElement('div');
        valueRow.className = 'value-row';
        const valueElement = document.createElement('strong');
        valueElement.textContent = value;
        const copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'copy-value';
        copyButton.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
        copyButton.title = `Copy ${label.toLowerCase()}`;
        const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
        const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
        copyButton.innerHTML = copyIcon;
        copyButton.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(copyValue);
            copyButton.classList.add('copied');
            copyButton.innerHTML = checkIcon;
            window.setTimeout(() => {
              copyButton.classList.remove('copied');
              copyButton.innerHTML = copyIcon;
            }, 1500);
          } catch {
            setStatus('Could not copy to the clipboard.', true);
          }
        });
        valueRow.append(valueElement, copyButton);
        field.append(valueRow);
      } else {
        const valueElement = document.createElement('strong');
        valueElement.textContent = value;
        field.append(valueElement);
      }
      if (note) {
        const noteElement = document.createElement('small');
        noteElement.textContent = note;
        field.append(noteElement);
      }
      grid.append(field);
    }
  }
  const statusPill = document.createElement('span');
  statusPill.className = `status ${draft.status}`;
  statusPill.textContent = draft.status;
  const received = document.createElement('p');
  received.textContent = `Received ${new Date(draft.receivedAt).toLocaleString()}`;
  item.append(heading, statusPill, grid, received);
  if (options.actionable) {
    const age = document.createElement('strong');
    age.className = 'draft-age';
    age.dataset.draftReceivedAt = draft.receivedAt;
    item.append(age);
    updateDraftAges();
    if (draft.action === 'cancel') {
      if (IS_EXTENSION_CONTEXT) {
        const openTradovateButton = document.createElement('button');
        openTradovateButton.type = 'button';
        openTradovateButton.textContent = 'Open Tradovate';
        openTradovateButton.addEventListener('click', async () => {
          openTradovateButton.disabled = true;
          try {
            await openTradovate();
          } catch {
            setStatus('Could not open Tradovate.', true);
          } finally {
            openTradovateButton.disabled = false;
          }
        });
        item.append(openTradovateButton);
      }
      const handled = document.createElement('button');
      handled.type = 'button';
      handled.textContent = 'Mark reminder handled';
      handled.addEventListener('click', async () => {
        handled.disabled = true;
        try {
          await markReviewed(settings, draft);
          await loadDrafts();
        } catch (error) {
          handled.disabled = false;
          setStatus(error instanceof Error ? error.message : 'Could not mark reminder handled.', true);
        }
      });
      item.append(handled);
      return item;
    }
    appendTradovateReuseControls(item, draft, 'Open and fill Tradovate');
    const submitted = document.createElement('button');
    submitted.type = 'button';
    submitted.textContent = 'Mark as submitted';
    submitted.addEventListener('click', async () => {
      submitted.disabled = true;
      try {
        await markSubmitted(settings, draft);
        await loadDrafts();
      } catch (error) {
        submitted.disabled = false;
        setStatus(error instanceof Error ? error.message : 'Could not mark draft submitted.', true);
      }
    });
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.textContent = 'Reject draft';
    reject.addEventListener('click', async () => {
      reject.disabled = true;
      try {
        await rejectDraft(settings, draft);
        await loadDrafts();
      } catch (error) {
        reject.disabled = false;
        setStatus(error instanceof Error ? error.message : 'Could not reject draft.', true);
      }
    });
    // item.append(submitted, reject);
    return item;
  }
  if (options.reusable) {
    if (draft.action === 'cancel') {
      if (IS_EXTENSION_CONTEXT) {
        const openTradovateButton = document.createElement('button');
        openTradovateButton.type = 'button';
        openTradovateButton.textContent = 'Open Tradovate again';
        openTradovateButton.addEventListener('click', async () => {
          openTradovateButton.disabled = true;
          try {
            await openTradovate();
          } catch {
            setStatus('Could not open Tradovate.', true);
          } finally {
            openTradovateButton.disabled = false;
          }
        });
        item.append(openTradovateButton);
      }
      return item;
    }
    appendTradovateReuseControls(item, draft, 'Open and fill Tradovate again');
  }
  return item;
}

async function markReviewed(settings: ExtensionSettings, draft: Draft): Promise<void> {
  const response = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/api/drafts/${draft.id}/reviewed`, {
    method: 'POST',
    headers: { 'x-extension-token': settings.extensionToken },
  });
  if (!response.ok) throw new Error(`Could not mark reminder handled (${response.status})`);
}

async function syncBackgroundDraftIndicator(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'poll-now' });
  } catch (error) {
    console.warn('[bridge] Could not sync draft indicator', error);
  }
}

let accountIdToName = new Map<string, string>();

function currentRecentDraftFilters(): RecentDraftHistoryOptions {
  const sinceHours = Number(recentDraftSinceField.value);
  return {
    limit: RECENT_DRAFT_LIMIT,
    sinceHours: Number.isFinite(sinceHours) && sinceHours > 0 ? sinceHours : RECENT_DRAFT_SINCE_HOURS,
    query: recentDraftQueryField.value.trim() || undefined,
    accountId: recentDraftAccountField.value || undefined,
  };
}

function updateRecentDraftSummary(filters: RecentDraftHistoryOptions, range: string, count: number): void {
  const notes = [`Showing the last ${filters.sinceHours ?? RECENT_DRAFT_SINCE_HOURS} hours.`];
  if (range !== 'all') notes.push(`Range: ${range}.`);
  if (filters.query) notes.push(`Filter: "${filters.query}".`);
  if (filters.accountId && filters.accountId !== 'all') {
    notes.push(`Account: ${accountIdToName.get(filters.accountId) ?? filters.accountId}.`);
  }
  notes.push(`${count} result${count === 1 ? '' : 's'}.`);
  recentDraftSummary.textContent = notes.join(' ');
}

function updateAccountOptions(drafts: Draft[]): void {
  accountIdToName = new Map<string, string>();
  for (const draft of drafts) {
    if (draft.accountId && draft.accountName) {
      accountIdToName.set(draft.accountId, draft.accountName);
    }
  }
  const current = recentDraftAccountField.value;
  const sorted = [...accountIdToName.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  recentDraftAccountField.replaceChildren(
    new Option('All accounts', 'all'),
    ...sorted.map(([id, name]) => new Option(name, id)),
  );
  recentDraftAccountField.value = accountIdToName.has(current) ? current : 'all';
}

function updateRangeOptions(drafts: Draft[]): void {
  const rangeNames = [...new Set(drafts.map((draft) => draft.rangeName).filter((name): name is string => Boolean(name)))].sort();
  const current = recentDraftRangeField.value;
  recentDraftRangeField.replaceChildren(
    new Option('All ranges', 'all'),
    ...rangeNames.map((name) => new Option(name, name)),
  );
  recentDraftRangeField.value = rangeNames.includes(current) ? current : 'all';
}

async function loadRecentDraftHistory(settings: ExtensionSettings): Promise<void> {
  const filters = currentRecentDraftFilters();
  const allRecentDrafts = await fetchRecentDrafts(settings, { ...filters, accountId: 'all' });
  updateAccountOptions(allRecentDrafts);
  updateRangeOptions(allRecentDrafts);
  const activeFilters = currentRecentDraftFilters();
  const range = recentDraftRangeField.value;
  const recentDrafts = allRecentDrafts
    .filter((draft) => (!activeFilters.accountId || activeFilters.accountId === 'all' || draft.accountId === activeFilters.accountId)
      && (range === 'all' || draft.rangeName === range))
    .sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );
  recentDraftsContainer.replaceChildren(...(
    recentDrafts.length
      ? recentDrafts.map((draft) => renderDraft(settings, draft, {
        actionable: false,
        reusable: true,
      }))
      : [renderEmptyState('No completed drafts match this filter in the last 12 hours.')]
  ));
  updateRecentDraftSummary(activeFilters, range, recentDrafts.length);
}

async function loadDrafts(): Promise<void> {
  const settings = await getReviewSettings();
  if (!settings) {
    setStatus('Open the extension popup and save your bridge connection first.', true);
    return;
  }
  try {
    const drafts = (await fetchDrafts(settings)).sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );
    draftsContainer.replaceChildren(...(
      drafts.length
        ? drafts.map((draft) => renderDraft(settings, draft, { actionable: true }))
        : [renderEmptyState('No pending drafts or reminders right now.')]
    ));
    await loadRecentDraftHistory(settings);
    setStatus(drafts.length === 0 ? 'No pending order drafts.' : `${drafts.length} order draft(s) require review.`);
    await syncBackgroundDraftIndicator();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not load drafts.', true);
  }
}

recentDraftFilters.addEventListener('submit', (event) => {
  event.preventDefault();
  void loadDrafts();
});

recentDraftQueryField.addEventListener('input', () => {
  if (recentDraftReloadTimer) window.clearTimeout(recentDraftReloadTimer);
  recentDraftReloadTimer = window.setTimeout(() => {
    void loadDrafts();
  }, 150);
});

recentDraftRangeField.addEventListener('change', () => {
  if (recentDraftReloadTimer) window.clearTimeout(recentDraftReloadTimer);
  void loadDrafts();
});

recentDraftSinceField.addEventListener('change', () => {
  if (recentDraftReloadTimer) window.clearTimeout(recentDraftReloadTimer);
  void loadDrafts();
});

recentDraftAccountField.addEventListener('change', () => {
  if (recentDraftReloadTimer) window.clearTimeout(recentDraftReloadTimer);
  void loadDrafts();
});

void loadDrafts();
setInterval(updateDraftAges, 1000);
