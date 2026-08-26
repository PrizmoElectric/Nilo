// shield.js — Shield Manifestation bridge (Nilo → Solsai)
//
// The actual shield entities are ArmorStandEntity instances managed server-side
// by ShieldManifestManager in Solsai (port 8080). Nilo's role is to relay
// chat commands from the player to Solsai's HTTP endpoints.
//
// Endpoints used:
//   GET /manifest-shield?player=X                            — summon one more shield
//   GET /manifest-dome?player=X&count=N                     — instant N-shield dome
//   GET /split-shield?player=X&count=N                      — consume shield, split durability
//   GET /dismiss-shields?player=X                           — remove all shields
//   GET /shield-state?player=X                              — {"count":N,"split":bool,...}
//   GET /shield-focus?player=X&mode=stacked|distributed&track=true|false
//   GET /shield-unfocus?player=X                            — return to Fibonacci dome

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
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

async function summon(username) {
  const body = await solsaiGet(`/manifest-shield?player=${encodeURIComponent(username)}`);
  if (!body) return '(Solsai unreachable)';
  try {
    const j = JSON.parse(body);
    return j.error ? `Error: ${j.error}` : `Shield manifested. Total: ${j.count}`;
  } catch { return body; }
}

async function summonDome(username, count = 6) {
  const body = await solsaiGet(`/manifest-dome?player=${encodeURIComponent(username)}&count=${count}`);
  if (!body) return '(Solsai unreachable)';
  try {
    const j = JSON.parse(body);
    return j.error ? `Error: ${j.error}` : `Dome formed. ${j.count} shields active.`;
  } catch { return body; }
}

async function splitSummon(username, count = 6) {
  const body = await solsaiGet(`/split-shield?player=${encodeURIComponent(username)}&count=${count}`);
  if (!body) return '(Solsai unreachable)';
  try {
    const j = JSON.parse(body);
    if (j.error) return `Error: ${j.error}`;
    return `Shield split into ${j.count}. Shared durability: ${j.pool}.`;
  } catch { return body; }
}

async function dismissAll(username) {
  await solsaiGet(`/dismiss-shields?player=${encodeURIComponent(username)}`);
  return 'Shields dismissed.';
}

async function getState(username) {
  const body = await solsaiGet(`/shield-state?player=${encodeURIComponent(username)}`);
  if (!body) return null;
  try { return JSON.parse(body); } catch { return null; }
}

/**
 * Activate focus mode.
 * mode:  'stacked' | 'distributed'
 * track: true = follow nearest living entity each tick
 *        false = lock to player's current look direction
 */
async function focus(username, mode = 'distributed', track = true) {
  const body = await solsaiGet(
    `/shield-focus?player=${encodeURIComponent(username)}&mode=${mode}&track=${track}`
  );
  if (!body) return '(Solsai unreachable)';
  try {
    const j = JSON.parse(body);
    if (j.error) return `Error: ${j.error}`;
    const trackStr = j.tracking ? ', tracking nearest target' : ', locked to look direction';
    return `Shields focused (${j.mode})${trackStr}.`;
  } catch { return body; }
}

/** Return shields to Fibonacci dome. */
async function unfocus(username) {
  await solsaiGet(`/shield-unfocus?player=${encodeURIComponent(username)}`);
  return 'Shields returned to dome formation.';
}

module.exports = { summon, summonDome, splitSummon, dismissAll, getState, focus, unfocus };
