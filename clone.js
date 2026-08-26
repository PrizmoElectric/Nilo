// clone.js — Clone Manifestation bridge (Nilo → Solsai)
//
// The clone is a FakePlayerEntity (server-side ServerPlayerEntity subclass)
// with the summoner's skin textures, no gravity, and tick-driven AI that
// orbits the summoner when idle and flies at mobs when enemies are nearby.
//
// Endpoints:
//   GET /summon-clone?player=X   → spawn flying clone for X
//   GET /dismiss-clone?player=X  → remove it
//   GET /clone-state?player=X    → {"active":bool,"target":"name"|null}

const http = require('http');
const { getSolsaiBase } = require('./config');

function solsaiGet(path) {
  return new Promise(resolve => {
    const { host, port } = getSolsaiBase();
    const req = http.get({ host, port, path }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve(body));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

async function summon(username) {
  const body = await solsaiGet(`/summon-clone?player=${encodeURIComponent(username)}`);
  if (!body) return '(Solsai unreachable)';
  try {
    const j = JSON.parse(body);
    if (j.error) return `Error: ${j.error}`;
    return `Clone manifested as ${j.name}.`;
  } catch { return body; }
}

async function dismiss(username) {
  const body = await solsaiGet(`/dismiss-clone?player=${encodeURIComponent(username)}`);
  if (!body) return '(Solsai unreachable)';
  try {
    const j = JSON.parse(body);
    return j.error ? `Error: ${j.error}` : 'Clone dismissed.';
  } catch { return body; }
}

async function getState(username) {
  const body = await solsaiGet(`/clone-state?player=${encodeURIComponent(username)}`);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

module.exports = { summon, dismiss, getState };
