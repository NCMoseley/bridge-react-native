export interface ExtensionSettings {
  bridgeUrl: string;
  extensionToken: string;
  overlayPosition?: OverlayPosition;
}

export type OverlayPosition = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export type StrategyStopMode = 'close_confirmed' | 'intrabar';

export interface Draft {
  id: string;
  ticker: string;
  action: 'buy' | 'sell' | 'cancel';
  quantity: number;
  orderType: string;
  signalPrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  takeProfit?: Record<string, number>;
  stopLoss?: Record<string, string | number>;
  strategyStopPrice?: number;
  strategyStopMode?: StrategyStopMode;
  rangeName?: string;
  orderLeg?: string;
  cancellationMessage?: string;
  accountId?: string;
  accountName?: string;
  receivedAt: string;
  status: 'pending' | 'reviewed' | 'submitted' | 'rejected' | 'expired';
}

export type RecentDraftHistoryStatus = 'all' | Exclude<Draft['status'], 'pending'>;

export interface RecentDraftHistoryOptions {
  limit?: number;
  sinceHours?: number;
  status?: RecentDraftHistoryStatus;
  query?: string;
  accountId?: string;
}

export interface StrategyStopPresentation {
  label: 'Strategy stop' | 'Strategy stop (close-confirmed)';
  price: number;
}

export function strategyStopPresentation(
  draft: Pick<Draft, 'stopLoss' | 'strategyStopPrice' | 'strategyStopMode'>,
): StrategyStopPresentation | undefined {
  if (draft.stopLoss || draft.strategyStopPrice == null) return undefined;
  return {
    label: draft.strategyStopMode === 'close_confirmed' ? 'Strategy stop (close-confirmed)' : 'Strategy stop',
    price: draft.strategyStopPrice,
  };
}

export interface HandoffResponse {
  delivered: boolean;
  message: string;
}

export const SETTINGS_KEY = 'settings';
export const DEFAULT_BRIDGE_URL = 'https://tradovate-browser-bridge.onrender.com';

const QUARTERLY_CONTRACTS = new Set(['MNQ', 'NQ', 'MES', 'ES', 'MYM', 'YM']);
const GOLD_CONTRACTS = new Set(['MGC', 'GC']);
const MONTHLY_CONTRACTS = new Set(['MCL', 'CL', 'MBT', 'BT']);
const MICRO_ROOTS: Record<string, string> = {
  MNQ: 'MNQ',
  NQ: 'MNQ',
  MES: 'MES',
  ES: 'MES',
  MYM: 'MYM',
  YM: 'MYM',
  MGC: 'MGC',
  GC: 'MGC',
  MCL: 'MCL',
  CL: 'MCL',
  MBT: 'MBT',
  BT: 'MBT',
};

export function defaultMicroContinuousTicker(ticker: string): string {
  if (!ticker.endsWith('1!')) return ticker;
  const root = Object.keys(MICRO_ROOTS)
    .sort((left, right) => right.length - left.length)
    .find((candidate) => ticker.startsWith(candidate));
  return root ? `${MICRO_ROOTS[root]}${ticker.slice(root.length)}` : ticker;
}

export function resolveContinuousTicker(ticker: string, now = new Date()): string {
  if (!ticker.endsWith('1!')) return ticker;
  const root = [...QUARTERLY_CONTRACTS, ...GOLD_CONTRACTS, ...MONTHLY_CONTRACTS]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => ticker.startsWith(candidate));
  if (!root) return ticker;

  const months = QUARTERLY_CONTRACTS.has(root)
    ? [{ month: 3, code: 'H' }, { month: 6, code: 'M' }, { month: 9, code: 'U' }, { month: 12, code: 'Z' }]
    : MONTHLY_CONTRACTS.has(root)
      ? [{ month: 1, code: 'F' }, { month: 2, code: 'G' }, { month: 3, code: 'H' }, { month: 4, code: 'J' }, { month: 5, code: 'K' }, { month: 6, code: 'M' }, { month: 7, code: 'N' }, { month: 8, code: 'Q' }, { month: 9, code: 'U' }, { month: 10, code: 'V' }, { month: 11, code: 'X' }, { month: 12, code: 'Z' }]
    : [{ month: 2, code: 'G' }, { month: 4, code: 'J' }, { month: 6, code: 'M' }, { month: 8, code: 'Q' }, { month: 10, code: 'V' }, { month: 12, code: 'Z' }];
  const year = now.getFullYear();
  const contract = months.find((candidate) => candidate.month >= now.getMonth() + 1) ?? months[0];
  const contractYear = contract.month < now.getMonth() + 1 ? year + 1 : year;
  return `${root}${contract.code}${contractYear % 10}`;
}

export function priceIncrement(ticker: string): number {
  if (ticker.startsWith('MGC') || ticker.startsWith('GC')) return 0.1;
  if (ticker.startsWith('MCL') || ticker.startsWith('CL')) return 0.01;
  if (ticker.startsWith('MBT') || ticker.startsWith('BT')) return 5;
  return 0.25;
}

export function roundPrice(ticker: string, price: number): number {
  const increment = priceIncrement(ticker);
  return Math.round((price + Number.EPSILON) / increment) * increment;
}

export function formatPrice(ticker: string, price: number | undefined): string {
  if (price == null) return 'Not provided';
  const increment = priceIncrement(ticker);
  const decimals = increment >= 1 ? 0 : increment === 0.1 ? 1 : 2;
  return roundPrice(ticker, price).toFixed(decimals);
}

// Ultra v5.0 sends percent as a decimal fraction (e.g. 0.003373 = 0.337%);
// older versions send a percent value (e.g. 0.02 = 0.02%). Mirrors the
// server's percentAsDecimal heuristic in src/server.ts.
const PERCENT_FRACTION_THRESHOLD = 0.01;

export function percentAsDecimal(percent: number): number {
  return percent < PERCENT_FRACTION_THRESHOLD ? percent : percent / 100;
}

export function displayPercent(percent: number): number {
  return percent < PERCENT_FRACTION_THRESHOLD ? percent * 100 : percent;
}

export async function getSettings(): Promise<ExtensionSettings | undefined> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return result[SETTINGS_KEY] as ExtensionSettings | undefined;
}

export async function fetchDrafts(settings: ExtensionSettings): Promise<Draft[]> {
  const response = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/api/drafts`, {
    headers: { 'x-extension-token': settings.extensionToken },
  });
  if (!response.ok) throw new Error(`Bridge request failed (${response.status})`);
  const body = await response.json() as { drafts: Draft[] };
  return body.drafts;
}

export async function fetchRecentDrafts(
  settings: ExtensionSettings,
  options: RecentDraftHistoryOptions = {},
): Promise<Draft[]> {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 200));
  params.set('sinceHours', String(options.sinceHours ?? 12));
  params.set('status', options.status ?? 'all');
  if (options.query?.trim()) params.set('query', options.query.trim());
  if (options.accountId && options.accountId !== 'all') params.set('accountId', options.accountId);
  const response = await fetch(`${settings.bridgeUrl.replace(/\/$/, '')}/api/drafts/history?${params.toString()}`, {
    headers: { 'x-extension-token': settings.extensionToken },
  });
  if (!response.ok) throw new Error(`Bridge request failed (${response.status})`);
  const body = await response.json() as { drafts: Draft[] };
  return body.drafts;
}

