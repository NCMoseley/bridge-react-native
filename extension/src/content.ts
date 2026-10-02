import { formatPrice, percentAsDecimal, priceIncrement, resolveContinuousTicker, roundPrice, strategyStopPresentation, type Draft, type OverlayPosition } from './shared.js';

const PANEL_ID = 'tradovate-bridge-handoff';
const TICKET_MISMATCH_CLASS = 'tradovate-bridge-mismatch';
let clearTicketMismatchHighlights: (() => void) | undefined;

interface TicketControl {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  className?: string;
  position: { x: number; y: number; width: number; height: number };
  disabled: boolean;
}

const resolveTradovateTicker = resolveContinuousTicker;

function ensureTicketMismatchStyles(): void {
  const style = document.getElementById('tradovate-bridge-mismatch-styles') ?? document.createElement('style');
  style.id = 'tradovate-bridge-mismatch-styles';
  style.textContent = `
    .${TICKET_MISMATCH_CLASS} {
      background-color: rgb(80 42 108 / 30%) !important;
      color: #d5a8ff !important;
    }
  `;
  if (!style.isConnected) (document.head ?? document.documentElement).append(style);
}

function clearAllTicketMismatchHighlights(): void {
  for (const input of Array.from(document.querySelectorAll<HTMLInputElement>(`.${TICKET_MISMATCH_CLASS}`))) {
    input.classList.remove(TICKET_MISMATCH_CLASS);
  }
}

function showDraft(draft: Draft, overlayPosition: OverlayPosition): void {
  clearTicketMismatchHighlights?.();
  clearAllTicketMismatchHighlights();
  document.getElementById(PANEL_ID)?.remove();
  ensureTicketMismatchStyles();

  const host = document.createElement('section');
  host.id = PANEL_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    article { background: #172033; border: 2px solid #6ea8fe; border-radius: 8px; box-shadow: 0 8px 24px rgb(0 0 0 / 35%); color: #fff; font: 14px system-ui, sans-serif; max-width: 440px; padding: 16px; position: fixed; z-index: 2147483647; }
    article.bottom-right { bottom: 20px; right: 20px; }
    article.bottom-left { bottom: 20px; left: 20px; }
    article.top-right { top: 20px; right: 20px; }
    article.top-left { top: 20px; left: 20px; }
    h2 { font-size: 16px; margin: 0 0 10px; }
    p { line-height: 1.4; margin: 6px 0; }
    .action { font-size: 16px; font-weight: 800; margin: 0; }
    .action.buy { color: #91e6a2; }
    .action.sell { color: #ff9b9b; }
    strong { color: #91e6a2; }
    button { background: #6ea8fe; border: 0; border-radius: 4px; color: #061429; cursor: pointer; font: inherit; font-weight: 700; margin: 10px 8px 0 0; padding: 8px 10px; }
    button.secondary { background: transparent; color: #fff; outline: 1px solid #aab5c8; }
    .values { display: grid; gap: 8px; grid-template-columns: repeat(2, 1fr); margin: 12px 0; }
    .value { background: #24314a; border-radius: 6px; padding: 8px; }
    .value.mismatch { background: #47265e; box-shadow: inset 0 0 0 2px #bd85eb; }
    .value.mismatch span { color: #e7c9ff; }
    .value span { color: #b9c6dc; display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .value-row { align-items: center; display: flex; gap: 4px; }
    .value strong { font-size: 20px; margin: 3px 0; overflow: hidden; text-overflow: ellipsis; }
    .value small { color: #b9c6dc; display: block; font-size: 11px; line-height: 1.3; margin-top: 5px; }
    .value button { font-size: 12px; margin: 2px 0 0; padding: 5px 7px; }
    .value button.copy-value { align-items: center; background: transparent; color: #b9c6dc; display: inline-flex; margin: 0; padding: 3px; }
    .value button.copy-value.copied { color: #34d399; }
    .value button.copy-value svg { fill: currentColor; height: 14px; width: 14px; }
  `;

  const article = document.createElement('article');
  article.className = overlayPosition;
  const heading = document.createElement('h2');
  heading.textContent = `${draft.rangeName ?? 'Order draft'} Code`;
  const action = document.createElement('p');
  action.className = `action ${draft.action}`;
  action.textContent = draft.action.toUpperCase();
  const tradovateTicker = resolveTradovateTicker(draft.ticker);
  const values = document.createElement('div');
  values.className = 'values';
  const entry = entryPrice(draft);
  const strategyStop = strategyStopPresentation(draft);
  const valueItems: Array<{ label: string; value: string; field?: TicketField; note?: string }> = [
    { label: 'Instrument', value: tradovateTicker, field: 'symbol', note: 'Select this symbol in Tradovate manually.' },
    { label: 'Quantity', value: String(draft.quantity), field: 'quantity' },
    { label: 'Entry', value: formatPrice(draft.ticker, entry), field: 'entry' },
    { label: 'Take profit', value: formatPrice(draft.ticker, protectionPrice(draft, 'takeProfit')), field: 'takeProfit' },
    ...(strategyStop
      ? [{
        label: strategyStop.label,
        value: formatPrice(draft.ticker, strategyStop.price),
        note: 'Informational only — not filled into Tradovate.',
      }]
      : [{ label: 'Stop loss', value: formatPrice(draft.ticker, protectionPrice(draft, 'stopLoss')), field: 'stopLoss' as const }]),
  ];
  const valueCards = new Map<TicketField, HTMLElement>();
  const watchedInputs = new WeakSet<HTMLInputElement>();
  const highlightedInputs = new Set<HTMLInputElement>();
  let mismatchTrackingActive = true;
  let mismatchRefreshInterval: number | undefined;

  function clearHighlights(): void {
    for (const input of highlightedInputs) input.classList.remove(TICKET_MISMATCH_CLASS);
    highlightedInputs.clear();
    clearAllTicketMismatchHighlights();
  }

  function stopMismatchTracking(): void {
    mismatchTrackingActive = false;
    if (mismatchRefreshInterval != null) window.clearInterval(mismatchRefreshInterval);
    clearHighlights();
  }

  clearTicketMismatchHighlights = stopMismatchTracking;

  function refreshMismatches(): void {
    if (!mismatchTrackingActive) return;
    const ticket = ticketInputs();
    if (!ticket.symbol) {
      clearHighlights();
      for (const card of valueCards.values()) card.classList.remove('mismatch');
      return;
    }
    for (const input of Object.values(ticket)) {
      if (!input || watchedInputs.has(input)) continue;
      input.addEventListener('input', refreshMismatches);
      input.addEventListener('change', refreshMismatches);
      watchedInputs.add(input);
    }

    const entryValue = entry == null ? undefined : roundPrice(tradovateTicker, entry);
    const takeProfit = protectionPrice(draft, 'takeProfit');
    const stopLoss = protectionPrice(draft, 'stopLoss');
    const matchesNumber = (input: HTMLInputElement | undefined, expected: number | undefined): boolean =>
      input != null && expected != null && Math.abs(Number(input.value) - expected) < 0.000001;
    const protectionMatches = (
      priceInput: HTMLInputElement | undefined,
      protection: number | undefined,
    ): boolean => {
      if (entryValue == null || protection == null) return true;
      const roundedProtection = roundPrice(tradovateTicker, protection);
      return matchesNumber(priceInput, roundedProtection);
    };
    const mismatchByField: Record<TicketField, boolean> = {
      symbol: ticket.symbol.value.trim().toUpperCase() !== tradovateTicker.toUpperCase(),
      quantity: !matchesNumber(ticket.quantity, draft.quantity),
      entry: !matchesNumber(ticket.entry, entryValue),
      takeProfit: !protectionMatches(ticket.takeProfitPrice, takeProfit),
      stopLoss: !protectionMatches(ticket.stopLossPrice, stopLoss),
    };
    const inputsByField: Record<TicketField, Array<HTMLInputElement | undefined>> = {
      symbol: [ticket.symbol],
      quantity: [ticket.quantity],
      entry: [ticket.entry],
      takeProfit: [ticket.takeProfitPrice],
      stopLoss: [ticket.stopLossPrice],
    };
    for (const [field, card] of valueCards) {
      card.classList.toggle('mismatch', mismatchByField[field]);
    }
    clearHighlights();
    for (const [field, inputs] of Object.entries(inputsByField) as Array<[TicketField, Array<HTMLInputElement | undefined>]>) {
      if (!mismatchByField[field]) continue;
      for (const input of inputs) {
        if (!input) continue;
        input.classList.add(TICKET_MISMATCH_CLASS);
        highlightedInputs.add(input);
      }
    }
  }

  mismatchRefreshInterval = window.setInterval(refreshMismatches, 250);

  for (const { label, value, field, note } of valueItems) {
    const item = document.createElement('div');
    item.className = 'value';
    const labelElement = document.createElement('span');
    labelElement.textContent = label;
    const valueRow = document.createElement('div');
    valueRow.className = 'value-row';
    const valueElement = document.createElement('strong');
    valueElement.textContent = value;
    const copyValue = document.createElement('button');
    copyValue.className = 'copy-value';
    copyValue.setAttribute('aria-label', `Copy ${label.toLowerCase()}`);
    copyValue.title = `Copy ${label.toLowerCase()}`;
    const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
    const checkIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
    copyValue.innerHTML = copyIcon;
    copyValue.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        copyValue.classList.add('copied');
        copyValue.innerHTML = checkIcon;
        window.setTimeout(() => {
          copyValue.classList.remove('copied');
          copyValue.innerHTML = copyIcon;
        }, 1500);
      } catch { /* clipboard unavailable — leave the icon unchanged */ }
    });
    valueRow.append(valueElement, copyValue);
    item.append(labelElement, valueRow);
    if (note) {
      const noteElement = document.createElement('small');
      noteElement.textContent = note;
      item.append(noteElement);
    }
    if (field) {
      valueCards.set(field, item);
      // The instrument card is display + mismatch highlight only — the ticket's
      // symbol is never changed programmatically (a symbol swap re-scopes the
      // whole ticket, including price fields already filled).
      if (field !== 'symbol') {
        const fillValue = document.createElement('button');
        fillValue.textContent = 'Fill';
        fillValue.addEventListener('click', async () => {
          fillValue.disabled = true;
          try {
            await fillTicketField(draft, field);
            refreshMismatches();
          } catch (error) {
            console.warn('[bridge] Could not fill Tradovate ticket field', { field, error });
          } finally {
            fillValue.textContent = 'Fill';
            fillValue.disabled = false;
          }
        });
        item.append(fillValue);
      }
    }
    values.append(item);
  }
  const autofill = document.createElement('button');
  autofill.textContent = 'Autofill';
  autofill.addEventListener('click', async () => {
    autofill.disabled = true;
    try {
      await fillTicketPass(draft);
      refreshMismatches();
    } catch (error) {
      console.warn('[bridge] Could not autofill Tradovate ticket', error);
    } finally {
      autofill.disabled = false;
    }
  });
  const dismiss = document.createElement('button');
  dismiss.className = 'secondary';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => {
    stopMismatchTracking();
    host.remove();
  });

  article.append(heading, action, values, autofill, dismiss);
  shadow.append(style, article);
  document.documentElement.append(host);
  refreshMismatches();
}

function visibleInputs(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input'))
    .filter((input) => {
      const bounds = input.getBoundingClientRect();
      const allowedTypes = new Set(['text', 'number', 'tel', 'search', 'url', 'email', 'password']);
      return allowedTypes.has(input.type) && bounds.width > 0 && bounds.height > 0;
    });
}

function textElements(text: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('body *'))
    .filter((element) => element.children.length === 0 && element.textContent?.trim().toUpperCase() === text)
    .filter((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    });
}

interface TicketInputs {
  symbol?: HTMLInputElement;
  quantity?: HTMLInputElement;
  entry?: HTMLInputElement;
  takeProfitDelta?: HTMLInputElement;
  takeProfitPrice?: HTMLInputElement;
  stopLossDelta?: HTMLInputElement;
  stopLossPrice?: HTMLInputElement;
}

function ticketInputs(): TicketInputs {
  const inputs = visibleInputs();
  const symbol = inputs
    .filter((input) => input.classList.contains('search-box--input'))
    .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
  if (!symbol) return {};

  const symbolBounds = symbol.getBoundingClientRect();
  const ticketFields = inputs
    .filter((input) => input.getBoundingClientRect().y > symbolBounds.y + symbolBounds.height)
    .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
  const leftColumnX = Math.min(...ticketFields.map((input) => input.getBoundingClientRect().x));
  const leftFields = ticketFields
    .filter((input) => Math.abs(input.getBoundingClientRect().x - leftColumnX) < 20)
    .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
  const protectionFields = ticketFields
    .filter((input) => input.getBoundingClientRect().x > leftColumnX + 150)
    .sort((a, b) => {
      const vertical = a.getBoundingClientRect().y - b.getBoundingClientRect().y;
      return vertical || a.getBoundingClientRect().x - b.getBoundingClientRect().x;
    });

  return {
    symbol,
    quantity: leftFields[0],
    entry: leftFields[1],
    takeProfitDelta: protectionFields[0],
    takeProfitPrice: protectionFields[1],
    stopLossDelta: protectionFields[2],
    stopLossPrice: protectionFields[3],
  };
}

async function waitForTicketInputs(): Promise<TicketInputs> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ticket = ticketInputs();
    if (ticket.symbol && ticket.quantity && ticket.entry) return ticket;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return ticketInputs();
}

function activateOrderTicket(): void {
  const ticketTab = textElements('ORDER TICKET')
    .sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
  ticketTab?.click();
}

function setInputValue(input: HTMLInputElement, value: string, blur = true): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Could not update ticket input');
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value.at(-1) ?? '' }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.at(-1) ?? '' }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  if (blur) input.blur();
}

function entryPrice(draft: Draft): number | undefined {
  return draft.stopPrice ?? draft.limitPrice ?? draft.signalPrice;
}

function protectionPrice(draft: Draft, field: 'takeProfit' | 'stopLoss'): number | undefined {
  const protection = draft[field];
  if (!protection) return undefined;
  const direct = field === 'takeProfit' ? protection.limitPrice : protection.stopPrice;
  if (typeof direct === 'number') return direct;
  const percent = protection.percent;
  const entry = entryPrice(draft);
  if (typeof percent !== 'number' || entry == null) return undefined;
  const decimal = percentAsDecimal(percent);
  const isBuy = draft.action === 'buy';
  if (field === 'takeProfit') return entry * (isBuy ? 1 + decimal : 1 - decimal);
  return entry * (isBuy ? 1 - decimal : 1 + decimal);
}

function setSide(draft: Draft, filled: string[], skipped: string[]): void {
  const candidates = textElements(draft.action === 'buy' ? 'BUY' : 'SELL');
  const button = candidates.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y)[0];
  if (!button) {
    skipped.push('side');
    return;
  }
  button.click();
  filled.push('side');
}

type TicketField = 'symbol' | 'quantity' | 'entry' | 'takeProfit' | 'stopLoss';

async function fillTicketField(draft: Draft, field: TicketField): Promise<void> {
  activateOrderTicket();
  const ticket = await waitForTicketInputs();
  const entry = entryPrice(draft);
  const tradovateTicker = resolveTradovateTicker(draft.ticker);

  if (field === 'symbol') {
    throw new Error('Instrument selection is manual — match the ticker shown on the instrument card');
  }
  if (field === 'quantity') {
    if (!ticket.quantity) throw new Error('Could not find the quantity field');
    setInputValue(ticket.quantity, String(draft.quantity));
    return;
  }
  if (field === 'entry') {
    if (entry == null || !ticket.entry) throw new Error('Could not find the entry field');
    setInputValue(ticket.entry, formatPrice(tradovateTicker, entry));
    return;
  }

  const protection = protectionPrice(draft, field);
  if (entry == null || protection == null) throw new Error(`No ${field === 'takeProfit' ? 'take-profit' : 'stop-loss'} value was supplied`);
  const roundedEntry = roundPrice(tradovateTicker, entry);
  const roundedProtection = roundPrice(tradovateTicker, protection);
  const delta = String(Math.round(Math.abs(roundedProtection - roundedEntry) / priceIncrement(tradovateTicker)));
  const price = formatPrice(tradovateTicker, roundedProtection);
  if (field === 'takeProfit') {
    if (!ticket.takeProfitDelta || !ticket.takeProfitPrice) throw new Error('Could not find the take-profit fields');
    setInputValue(ticket.takeProfitDelta, delta);
    setInputValue(ticket.takeProfitPrice, price);
    return;
  }
  if (!ticket.stopLossDelta || !ticket.stopLossPrice) throw new Error('Could not find the stop-loss fields');
  setInputValue(ticket.stopLossDelta, delta);
  setInputValue(ticket.stopLossPrice, price);
}

async function fillTicketPass(draft: Draft): Promise<{ filled: string[]; skipped: string[]; observedValues: string[] }> {
  const filled: string[] = [];
  const skipped: string[] = [];
  activateOrderTicket();
  const ticket = await waitForTicketInputs();
  if (!ticket.quantity || !ticket.entry) {
    skipped.push('side', 'quantity', 'entry', 'take profit', 'stop loss', 'order type requires manual verification');
    return {
      filled,
      skipped,
      observedValues: [
        `symbol=${ticket.symbol?.value ?? '<not found>'}`,
        'quantity=<not found>',
        'entry=<not found>',
        'takeProfitDelta=<not found>',
        'takeProfitPrice=<not found>',
        'stopLossDelta=<not found>',
        'stopLossPrice=<not found>',
      ],
    };
  }
  setSide(draft, filled, skipped);
  const entry = entryPrice(draft);
  const tradovateTicker = resolveTradovateTicker(draft.ticker);
  // The instrument is never changed programmatically and is not reported as
  // skipped — the draft card's mismatch highlight is the only prompt when the
  // ticket's symbol differs from the expected contract.
  if (ticket.quantity) {
    setInputValue(ticket.quantity, String(draft.quantity));
    filled.push('quantity');
  } else {
    skipped.push('quantity');
  }
  if (entry != null && ticket.entry) {
    setInputValue(ticket.entry, formatPrice(tradovateTicker, entry));
    filled.push('entry');
  } else {
    skipped.push('entry');
  }

  const takeProfit = protectionPrice(draft, 'takeProfit');
  if (takeProfit != null && ticket.takeProfitDelta && ticket.takeProfitPrice && entry != null) {
    const roundedEntry = roundPrice(tradovateTicker, entry);
    const roundedTakeProfit = roundPrice(tradovateTicker, takeProfit);
    setInputValue(ticket.takeProfitDelta, String(Math.round(Math.abs(roundedTakeProfit - roundedEntry) / priceIncrement(tradovateTicker))));
    setInputValue(ticket.takeProfitPrice, formatPrice(tradovateTicker, roundedTakeProfit));
    filled.push('take profit');
  } else {
    skipped.push('take profit');
  }

  const stopLoss = protectionPrice(draft, 'stopLoss');
  if (stopLoss != null && ticket.stopLossDelta && ticket.stopLossPrice && entry != null) {
    const roundedEntry = roundPrice(tradovateTicker, entry);
    const roundedStopLoss = roundPrice(tradovateTicker, stopLoss);
    setInputValue(ticket.stopLossDelta, String(Math.round(Math.abs(roundedStopLoss - roundedEntry) / priceIncrement(tradovateTicker))));
    setInputValue(ticket.stopLossPrice, formatPrice(tradovateTicker, roundedStopLoss));
    filled.push('stop loss');
  } else {
    skipped.push('stop loss');
  }
  skipped.push('order type requires manual verification');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const observedValues = [
    `symbol=${ticket.symbol?.value ?? '<not found>'}`,
    `quantity=${ticket.quantity?.value ?? '<not found>'}`,
    `entry=${ticket.entry?.value ?? '<not found>'}`,
    `takeProfitDelta=${ticket.takeProfitDelta?.value ?? '<not found>'}`,
    `takeProfitPrice=${ticket.takeProfitPrice?.value ?? '<not found>'}`,
    `stopLossDelta=${ticket.stopLossDelta?.value ?? '<not found>'}`,
    `stopLossPrice=${ticket.stopLossPrice?.value ?? '<not found>'}`,
  ];
  console.info('[bridge] Tradovate ticket fill result', { filled, skipped, observedValues });
  return { filled, skipped, observedValues };
}

async function fillDraft(draft: Draft): Promise<{ filled: string[]; skipped: string[]; observedValues: string[] }> {
  return fillTicketPass(draft);
}

function inspectTicketControls(): TicketControl[] {
  return Array.from(document.querySelectorAll<HTMLElement>('input, select, textarea, button, [role="button"]'))
    .map((element) => {
      const input = element instanceof HTMLInputElement ? element : undefined;
      const id = element.id || undefined;
      const label = id
        ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim()
        : undefined;
      const bounds = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        ...(id ? { id } : {}),
        ...(input?.name ? { name: input.name } : {}),
        ...(input?.type ? { type: input.type } : {}),
        ...(element.getAttribute('role') ? { role: element.getAttribute('role')! } : {}),
        ...(element.getAttribute('aria-label') ?? label ? { label: element.getAttribute('aria-label') ?? label } : {}),
        ...(element instanceof HTMLButtonElement && element.textContent?.trim() ? { text: element.textContent.trim().slice(0, 80) } : {}),
        ...(input?.placeholder ? { placeholder: input.placeholder } : {}),
        ...(typeof element.className === 'string' && element.className ? { className: element.className } : {}),
        position: {
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        },
        disabled: 'disabled' in element && Boolean(element.disabled),
      };
    })
    .slice(0, 100);
}

chrome.runtime.onMessage.addListener((message: { type: string; draft?: Draft; overlayPosition?: OverlayPosition }, _sender, sendResponse) => {
  if ((message.type !== 'show-draft' && message.type !== 'fill-draft') || !message.draft) return;
  void (async () => {
    const fillResult = message.type === 'fill-draft' ? await fillDraft(message.draft!) : undefined;
    showDraft(message.draft!, message.overlayPosition ?? 'bottom-right');
    const controls = inspectTicketControls();
    console.info('[bridge] Tradovate ticket controls discovered', controls);
    sendResponse({ displayed: true, controls, fillResult });
  })();
  return true;
});
