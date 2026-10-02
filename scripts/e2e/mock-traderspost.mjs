// Controllable mock TradersPost endpoint for the local e2e suite.
//   POST /tp/<book>     -> records call, responds per current mode (one order
//                        book per path so two test accounts stay independent)
//   POST /__mode        -> { mode: 'ok'|'reject'|'error'|'timeout'|'connreset', status?, delayMs? }
//                          ('connreset' destroys the socket once, then reverts to 'ok')
//   GET  /__calls       -> every recorded call
//   GET  /__state       -> derived broker state (positions + working orders per book:ticker)
//   POST /__fill        -> mark a working order filled: { book, ticker, bracketId }
//   POST /__reset       -> clears recorded calls and fills
import { assertIsolation } from './isolation.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

assertIsolation();
const PORT = Number(process.env.MOCK_PORT);
const LOG = path.join(process.env.PT_WORKDIR || '/tmp/pt-e2e', 'tp-calls.jsonl');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, '');

const calls = [];
// Working orders the driver has marked as filled: `${book}:${ticker}:${bracketId}`.
// Without this every fill exists only as a Pine lifecycle alert to the Bridge,
// so mock positions stay null and the exit-flat checks are vacuous.
const fills = new Set();
let mode = { mode: 'ok', status: 503, delayMs: 0 };

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = req.url.split('?')[0];
    if (url === '/__identity') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ runId: process.env.PT_RUN_ID }));
      return;
    }
    if (url === '/__mode' && req.method === 'POST') {
      mode = { ...mode, ...JSON.parse(body || '{}') };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mode));
      return;
    }
    if (url === '/__calls') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ calls }));
      return;
    }
    if (url === '/__fill' && req.method === 'POST') {
      const f = JSON.parse(body || '{}');
      fills.add(`${f.book}:${f.ticker}:${f.bracketId}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ filled: `${f.book}:${f.ticker}:${f.bracketId}` }));
      return;
    }
    if (url === '/__reset' && req.method === 'POST') {
      calls.length = 0;
      fills.clear();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"reset":true}');
      return;
    }
    if (url === '/__state') {
      const tickers = {};
      for (const call of calls) {
        if (!call.accepted) continue;
        const p = call.payload;
        const t = p?.ticker;
        if (!t) continue;
        const key = `${call.book}:${t}`;
        const s = tickers[key] ??= { position: null, workingOrders: [], actions: [] };
        if (p.action === 'cancel') s.workingOrders = [];
        else if (p.action === 'exit') { s.workingOrders = []; s.position = null; }
        else if (p.action === 'buy' || p.action === 'sell') {
          const qty = typeof p.quantity === 'number' ? p.quantity : 1;
          const signed = p.action === 'buy' ? qty : -qty;
          const filled = p.orderType === 'market' || fills.has(`${call.book}:${t}:${p.bracketId}`);
          if (filled) {
            const cur = s.position ? (s.position.side === 'long' ? s.position.quantity : -s.position.quantity) : 0;
            const net = cur + signed;
            s.position = net === 0 ? null : { side: net > 0 ? 'long' : 'short', quantity: Math.abs(net) };
          } else {
            s.workingOrders.push({ bracketId: p.bracketId, action: p.action, price: p.stopPrice ?? p.limitPrice });
          }
        }
        s.actions.push(p.action);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tickers }));
      return;
    }
    if (!url.startsWith('/tp/')) { res.writeHead(404); res.end(); return; }
    const book = url.slice(4);
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = { raw: body }; }
    const call = { receivedAt: new Date().toISOString(), book, payload, accepted: false, mode: mode.mode };
    calls.push(call);

    if (mode.mode === 'connreset') {
      // Kill the socket mid-exchange so the client's fetch throws a transport
      // error (TypeError 'fetch failed'), then revert to ok — exercises the
      // bridge's single transport retry: the retried send lands normally.
      mode.mode = 'ok';
      fs.appendFileSync(LOG, JSON.stringify({ ...call, responseStatus: null, note: 'socket destroyed (connreset mode)' }) + '\n');
      req.socket.destroy();
      return;
    }
    if (mode.mode === 'timeout') {
      // Never respond — the caller's timeout decides. Record a receipt so the
      // artifact is not silently missing the request.
      fs.appendFileSync(LOG, JSON.stringify({ ...call, responseStatus: null, note: 'no response sent (timeout mode)' }) + '\n');
      return;
    }
    const respond = () => {
      let status = 200;
      let out = { success: true, message: 'mock: accepted' };
      if (mode.mode === 'reject') out = { success: false, failureMessage: 'mock: rejected' };
      else if (mode.mode === 'error') { status = mode.status; out = { success: false, failureMessage: `mock: HTTP ${status}` }; }
      call.accepted = status >= 200 && status < 300 && out.success !== false;
      call.responseStatus = status;
      // Persist only the finalized record — earlier versions logged before
      // classification, leaving every artifact at accepted:false.
      fs.appendFileSync(LOG, JSON.stringify(call) + '\n');
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    };
    if (mode.delayMs > 0) setTimeout(respond, mode.delayMs);
    else respond();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock TP on :${PORT}`));
