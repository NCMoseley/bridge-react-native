import { readFileSync, writeFileSync } from 'node:fs';

function parse(path) {
  return readFileSync(path, 'utf8').trim().split('\n').reduce((acc, line) => {
    const [key, ...valueParts] = line.split('=');
    if (!key) return acc;
    const value = valueParts
      .join('=')
      .replace(/^['"]|['"]$/g, '');
    acc[key.trim()] = value;
    return acc;
  }, {});
}

const tt = parse('tt.env');
const current = parse('.env');

const merged = {
  ...tt,
  ...current,
  DATABASE_PATH: './data/bridge.sqlite',
  PUBLIC_BASE_URL: 'http://localhost:3000',
};

writeFileSync(
  '.env',
  Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
);

console.log('Merged env files');
