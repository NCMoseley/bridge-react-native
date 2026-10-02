import { Database } from '../src/database.js';
import { writeFile } from 'node:fs/promises';

const database = new Database();
const users = database.listUsers();

let selectedUserId: string | undefined;
for (const user of users) {
  const accounts = database.listAccounts(user.id);
  if (accounts.length > 0) {
    selectedUserId = user.id;
    break;
  }
}

if (!selectedUserId) {
  console.error('No user with accounts found');
  process.exit(1);
}

const now = new Date();
const tradeJournal = database.getTradeJournal(selectedUserId, now);
const calendar = database.getTradeCalendarMonth(selectedUserId, now);

const journalDayEntries = calendar.days
  .filter((day) => day.closedCount > 0)
  .map((day) => [day.date, database.getTradeJournalDay(selectedUserId, day.date)] as const);

const accountIds = tradeJournal.accounts.map((aj) => aj.account.id);
const accountAlertSummaries = Object.fromEntries(
  accountIds.map((accountId) => [
    accountId,
    database.getAccountAlertSummary(selectedUserId, accountId),
  ]),
);
const traderspostDestinations = Object.fromEntries(
  accountIds
    .map((accountId) => [accountId, database.getTradersPostAccountDestination(accountId)] as const)
    .filter(([, destination]) => destination != null),
);

const output = `import type { AccountAlertSummary, TradeCalendarMonthView, TradeJournal, TradeJournalDay, TradersPostAccountDestination } from '../types';

export const tradeJournal: TradeJournal = ${JSON.stringify(tradeJournal)};

export const calendar: TradeCalendarMonthView = ${JSON.stringify(calendar)};

export const journalDays: Record<string, TradeJournalDay> = ${JSON.stringify(Object.fromEntries(journalDayEntries))};

export const accountAlertSummaries: Record<string, AccountAlertSummary> = ${JSON.stringify(accountAlertSummaries)};

export const traderspostDestinations: Record<string, TradersPostAccountDestination> = ${JSON.stringify(traderspostDestinations)};
`;

await writeFile('./client/src/data/journal.ts', output);
console.info('Dumped journal data to client/src/data/journal.ts');
