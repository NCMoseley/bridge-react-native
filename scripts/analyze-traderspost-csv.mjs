import { readFileSync } from 'node:fs';

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/analyze-traderspost-csv.mjs <csv-file>');
  process.exit(1);
}

const text = readFileSync(path, 'utf-8');
const lines = text.split(/\r?\n/).filter((line) => line.trim());
const headers = parseCsvLine(lines[0]);
const payloadIndex = headers.indexOf('Payload');
const statusIndex = headers.indexOf('Status Code');
const messageIndex = headers.indexOf('Message Code');
const urlIndex = headers.indexOf('URL');
const createdAtIndex = headers.indexOf('Created At');

if (payloadIndex === -1 || statusIndex === -1) {
  console.error('CSV missing Payload or Status Code columns');
  process.exit(1);
}

const total = lines.length - 1;
let status200 = 0;
let status400 = 0;
let parseFailures = 0;
const messageCounts = {};
const urlStatus = {};
const actionCounts = {};
const actionStatus = {};
const sourceCounts = {};
const tickerCounts = {};
const rejectedExamples = [];
const sentimentRejections = [];

for (let i = 1; i < lines.length; i++) {
  const row = parseCsvLine(lines[i]);
  const status = Number(row[statusIndex]);
  const message = row[messageIndex] ?? '';
  const url = row[urlIndex] ?? '';
  if (status === 200) status200++;
  else status400++;

  messageCounts[message] = (messageCounts[message] || 0) + 1;
  urlStatus[url] = urlStatus[url] || {};
  urlStatus[url][status] = (urlStatus[url][status] || 0) + 1;

  let payload;
  try {
    payload = JSON.parse(row[payloadIndex]);
  } catch {
    parseFailures++;
    continue;
  }

  const action = payload.action ?? 'unknown';
  const source = payload.extras?.source ?? payload.source ?? 'unknown';
  const ticker = payload.ticker ?? 'unknown';
  const rangeName = payload.extras?.rangeName ?? 'unknown';

  actionCounts[action] = (actionCounts[action] || 0) + 1;
  actionStatus[`${action}:${status}`] = (actionStatus[`${action}:${status}`] || 0) + 1;
  sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  tickerCounts[ticker] = (tickerCounts[ticker] || 0) + 1;

  if (status !== 200) {
    rejectedExamples.push({ status, message, action, ticker, rangeName, payload, url });
    if (message === 'invalid-sentiment-action') {
      sentimentRejections.push({ action, ticker, sentiment: payload.sentiment, rangeName, createdAt: row[createdAtIndex], url });
    }
  }
}

function sort(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1]);
}

console.log('\n=== TradersPost Signal Report ===');
console.log(`Total rows: ${total}`);
console.log(`Status 200: ${status200}`);
console.log(`Status 400: ${status400}`);
console.log(`Success rate: ${((status200 / total) * 100).toFixed(1)}%`);
console.log(`JSON parse failures: ${parseFailures}`);

console.log('\n--- Status by webhook URL (top 10) ---');
for (const [url, counts] of sort(Object.fromEntries(Object.entries(urlStatus).map(([u, c]) => [u, `${c[200] || 0}/${(c[200] || 0) + (c[400] || 0)}`]))).slice(0, 10)) {
  console.log(`${url}: ${counts}`);
}

console.log('\n--- Status by action ---');
for (const [action, count] of sort(actionCounts)) {
  const ok = actionStatus[`${action}:200`] || 0;
  const fail = actionStatus[`${action}:400`] || 0;
  console.log(`${action}: ${count} (200: ${ok}, 400: ${fail})`);
}

console.log('\n--- 400 message codes ---');
for (const [message, count] of sort(messageCounts)) {
  const label = message || '(blank)';
  console.log(`${label}: ${count}`);
}

console.log('\n--- Sources ---');
for (const [source, count] of sort(sourceCounts).slice(0, 20)) {
  console.log(`${source}: ${count}`);
}

console.log('\n--- Tickers ---');
for (const [ticker, count] of sort(tickerCounts).slice(0, 20)) {
  console.log(`${ticker}: ${count}`);
}

console.log('\n--- invalid-sentiment-action samples ---');
for (const r of sentimentRejections.slice(0, 10)) {
  console.log(`  action=${r.action} sentiment=${r.sentiment} ticker=${r.ticker} range=${r.rangeName} at=${r.createdAt}`);
}

console.log('\n--- Other rejected samples (first 10 non-sentiment, non-ticker-missing) ---');
for (const r of rejectedExamples.filter((r) => r.message !== 'invalid-sentiment-action' && r.message !== 'ticker-does-not-exist').slice(0, 10)) {
  console.log(`  status=${r.status} message=${r.message || '(blank)'} action=${r.action} ticker=${r.ticker} range=${r.rangeName} source=${r.payload.extras?.source || r.payload.source || 'unknown'}`);
}
