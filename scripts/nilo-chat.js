#!/usr/bin/env node
// Interactive CLI chat session with Nilo over WebSocket (port 4000).
// Auto-reconnects on disconnect. Run via: nilo chat  (or: nilo)

const WebSocket = require('ws');
const readline  = require('readline');

const PORT = parseInt(process.env.CLI_PORT || '4000', 10);

const G  = s => `\x1b[32m${s}\x1b[0m`;  // green
const Y  = s => `\x1b[33m${s}\x1b[0m`;  // yellow
const C  = s => `\x1b[36m${s}\x1b[0m`;  // cyan
const DIM = s => `\x1b[2m${s}\x1b[0m`;  // dim

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.on('close', () => process.exit(0));

let ws;

// Rate-limit the "[disconnected]" notice so a flapping connection (e.g. the
// service restarting, or being down for a while) doesn't spam the terminal —
// reconnect attempts themselves are unaffected and keep firing every 3s.
const DISCONNECT_NOTICE_MIN_GAP_MS = 60_000;  // max 1/min
const DISCONNECT_NOTICE_MAX_PER_HOUR = 6;
let disconnectNoticeTimes = [];

function notifyDisconnected() {
  const now = Date.now();
  disconnectNoticeTimes = disconnectNoticeTimes.filter(t => now - t < 3_600_000);
  const last = disconnectNoticeTimes[disconnectNoticeTimes.length - 1] ?? -Infinity;
  if (now - last < DISCONNECT_NOTICE_MIN_GAP_MS) return;
  if (disconnectNoticeTimes.length >= DISCONNECT_NOTICE_MAX_PER_HOUR) return;
  disconnectNoticeTimes.push(now);
  process.stdout.write(Y('[disconnected — retrying in 3s]\n'));
}

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

  ws.on('open', () => {
    process.stdout.write(G('[nilo connected]\n'));
    rl.setPrompt('> ');
    rl.prompt();
  });

  ws.on('message', raw => {
    let text = raw.toString();
    let color = C;
    try {
      const payload = JSON.parse(text);
      text = payload.text ?? text;
      if (payload.type === 'error') color = Y;
      else if (payload.type === 'status') color = DIM;
    } catch (_) { /* not JSON — print as-is */ }

    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(color(`nilo: ${text}\n`));
    rl.prompt();
  });

  ws.on('close', () => {
    notifyDisconnected();
    setTimeout(connect, 3000);
  });

  ws.on('error', () => {});
}

rl.on('line', line => {
  const text = line.trim();
  if (!text) { rl.prompt(); return; }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(text);
    rl.prompt();
  } else {
    process.stdout.write(DIM('[not connected yet]\n'));
    rl.prompt();
  }
});

process.stdout.write(DIM(`Connecting to nilo on port ${PORT}...\n`));
connect();
