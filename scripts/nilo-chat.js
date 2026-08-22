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

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}`);

  ws.on('open', () => {
    process.stdout.write(G('[nilo connected]\n'));
    rl.setPrompt('> ');
    rl.prompt();
  });

  ws.on('message', msg => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(C(`nilo: ${msg}\n`));
    rl.prompt();
  });

  ws.on('close', () => {
    process.stdout.write(Y('[disconnected — retrying in 3s]\n'));
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
