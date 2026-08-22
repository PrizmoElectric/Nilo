// soul.js — loads soul.txt and pushes it to the Letta agent: the SYSTEM
// section becomes agent.system, PERSONA and HUMAN become the matching
// core-memory blocks. soul.txt is the single source of truth; Letta's live
// state is just a copy of it.

const fs = require('fs');
const path = require('path');
const { LETTA_URL } = require('./config');

const SOUL_PATH  = path.join(__dirname, 'soul.txt');
const AGENT_BASE = LETTA_URL.replace(/\/messages$/, '');

const SECTION_RE = /^## (SYSTEM|PERSONA|HUMAN)\s*$/;

// Parses soul.txt into { system, persona, human }. Text before the first
// recognized header is ignored (notes/instructions for humans).
function loadSoul() {
  const raw = fs.readFileSync(SOUL_PATH, 'utf8');
  const sections = {};
  let current = null;
  let buf = [];

  for (const line of raw.split('\n')) {
    const m = line.match(SECTION_RE);
    if (m) {
      if (current) sections[current] = buf.join('\n').trim();
      current = m[1].toLowerCase();
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) sections[current] = buf.join('\n').trim();
  return sections;
}

// Pushes soul.txt to the live Letta agent. Returns the list of parts synced.
async function syncSoul() {
  const { default: fetch } = await import('node-fetch');
  const soul = loadSoul();
  const synced = [];

  if (soul.system) {
    const res = await fetch(AGENT_BASE, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: soul.system }),
    });
    if (!res.ok) throw new Error(`system PATCH failed: HTTP ${res.status}`);
    synced.push('system');
  }

  for (const label of ['persona', 'human']) {
    if (!soul[label]) continue;
    const res = await fetch(`${AGENT_BASE}/core-memory/blocks/${label}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: soul[label] }),
    });
    if (!res.ok) throw new Error(`${label} block PATCH failed: HTTP ${res.status}`);
    synced.push(label);
  }

  return synced;
}

module.exports = { loadSoul, syncSoul, SOUL_PATH };
