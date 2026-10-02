import { Database } from '../src/database.js';
import { writeFile } from 'node:fs/promises';

const database = new Database();
const configurations = database.listRangeConfigurations();
const subcategories = database.listRangeSubcategories();
const assignments = database.listRangeSubcategoryAssignments();
const sharedRangeDetails = database.listSharedRangeDetails();

const rangeCalendars: Record<string, ReturnType<Database['getRangeTradeCalendarMonth']>> = {};
for (const detail of sharedRangeDetails) {
  rangeCalendars[detail.rangeName] = database.getRangeTradeCalendarMonth(detail.rangeName);
}

const output = `import type {
  RangeConfiguration,
  RangeSubcategory,
  RangeSubcategoryAssignment,
  SharedRangeDetail,
  TradeCalendarMonthView,
} from '../types';

export const rangeConfigurations: RangeConfiguration[] = ${JSON.stringify(configurations)};

export const rangeSubcategories: RangeSubcategory[] = ${JSON.stringify(subcategories)};

export const rangeSubcategoryAssignments: RangeSubcategoryAssignment[] = ${JSON.stringify(assignments)};

export const sharedRangeDetails: SharedRangeDetail[] = ${JSON.stringify(sharedRangeDetails)};

export const rangeCalendars: Record<string, TradeCalendarMonthView> = ${JSON.stringify(rangeCalendars)};
`;

await writeFile('./client/src/data/ranges.ts', output);
console.info('Dumped ranges data to client/src/data/ranges.ts');
