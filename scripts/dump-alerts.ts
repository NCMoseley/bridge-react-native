import { Database } from '../src/database.js';
import { writeFile } from 'node:fs/promises';

const database = new Database();
const summary = database.getAlertFeedSummary(undefined, 'all');
const feed = database.listAlertFeed(undefined, 'all', undefined, undefined, 100, 0);
const rangeNames = database.listAlertFeedRangeNames(undefined);

const output = `import type { AlertFeedEntry, AlertFeedSummary } from '../types';

export const alertSummary: AlertFeedSummary = ${JSON.stringify(summary)};

export const alertFeed: { alerts: AlertFeedEntry[]; totalCount: number } = ${JSON.stringify(feed)};

export const alertRangeNames: string[] = ${JSON.stringify(rangeNames)};
`;

await writeFile('./client/src/data/alerts.ts', output);
console.info('Dumped alerts data to client/src/data/alerts.ts');
