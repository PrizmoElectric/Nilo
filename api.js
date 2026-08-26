// api.js — lightweight HTTP state API for the HUD overlay
// GET http://localhost:3008/api/state → JSON snapshot of the live bot state

const http = require('http');
const fs   = require('fs');
const path = require('path');
const state = require('./state');
const { BOT_USERNAME, getSolsaiBase } = require('./config');

const COCKPIT_PATH = path.join(__dirname, 'public', 'cockpit.html');

const API_PORT = parseInt(process.env.HUD_API_PORT || '3008', 10);
let _server = null;

const HOSTILE_KEYWORDS = [
  'zombie','skeleton','spider','creeper','enderman','blaze','witch','phantom',
  'drowned','pillager','vindicator','ravager','wither','ghast','slime','magma',
  'guardian','elder_guardian','piglin_brute','hoglin','zoglin','vex','evoker',
  'shulker','silverfish','endermite','husk','stray','bogged','breeze',
];

function entityType(e) {
  if (e.type === 'player') return 'player';
  const n = (e.name || e.username || '').toLowerCase();
  if (HOSTILE_KEYWORDS.some(k => n.includes(k))) return 'hostile';
  return 'passive';
}

// Lightweight inventory snapshot for the clone army — reuses this same HTTP
// server/port instead of spinning up a mineflayer-web-inventory instance per
// clone (would mean up to 20 extra servers/ports just to show the same data).
// Lazy-required to avoid a require cycle (clones.js needs api.SKIN_URL).
function buildClonesState() {
  const { clones } = require('./clones');
  const out = [];
  for (const [index, bot] of clones) {
    if (!bot.entity) continue;
    out.push({
      index,
      name: bot.username,
      position: { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) },
      health: bot.health ?? null,
      inventory: (bot.inventory?.items() ?? []).map(item => ({
        slot: item.slot,
        name: item.name,
        displayName: item.displayName || item.name,
        count: item.count,
      })),
      // getEquipmentDestSlot asserts/throws on a destination the server
      // version doesn't support (e.g. 'off-hand') — guard per-slot so one
      // bad lookup can't break the whole snapshot.
      armor: ['head', 'torso', 'legs', 'feet', 'off-hand'].flatMap(dest => {
        try {
          const item = bot.inventory?.slots?.[bot.getEquipmentDestSlot(dest)];
          return item ? [{ name: item.name, displayName: item.displayName || item.name }] : [];
        } catch (_) { return []; }
      }),
    });
  }
  return out;
}

function buildState(bot) {
  if (!bot || !bot.entity) return { connected: false };

  const pos = bot.entity.position;
  const dim = (bot.game?.dimension ?? 'overworld').replace('minecraft:', '');

  const entities = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && (e.type === 'mob' || e.type === 'player'))
    .map(e => {
      const dx   = e.position.x - pos.x;
      const dy   = e.position.y - pos.y;
      const dz   = e.position.z - pos.z;
      const dist = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz));
      return {
        name: e.username || e.name || '?',
        type: entityType(e),
        dx:   Math.round(dx),
        dy:   Math.round(dy),
        dz:   Math.round(dz),
        dist,
      };
    })
    .filter(e => e.dist > 0 && e.dist <= 64)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 20);

  const inventory = (bot.inventory?.items() ?? []).map(item => ({
    slot:        item.slot,
    name:        item.name,
    displayName: item.displayName || item.name,
    count:       item.count,
  }));

  return {
    connected:    true,
    position:     { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 },
    health:       bot.health ?? 20,
    food:         bot.food ?? 20,
    dimension:    dim,
    behaviorMode: state.behaviorMode,
    entities,
    gameTime:     bot.time?.timeOfDay ?? 0,
    inventory,
  };
}

// Pushes a bot's behavior mode (+ a short free-text "current action" line) to
// Solsai's /bot-mode endpoint, keyed by player name — this is what lets
// prizmo-system's HUD mode-color ESP boxes (and the inventory peek, which
// polls /bot-inventory per name) work for any bot, not just NILO. Exported so
// clones.js can push their own modes the same way (action optional there).
function pushModeToSolsai(player, mode, action) {
  const p = encodeURIComponent(player || 'NILO');
  const m = encodeURIComponent(mode || 'idle');
  const a = encodeURIComponent(action || '');
  const { host, port } = getSolsaiBase();
  http.get(`http://${host}:${port}/bot-mode?player=${p}&mode=${m}&action=${a}`, res => res.resume())
      .on('error', () => {});
}

// Cheap, best-effort one-liner for the status/chat screen's ACTION field —
// deliberately not a fully modeled "current task" system, just the handful
// of states that are already tracked and worth surfacing.
function deriveCurrentAction(bot) {
  if (state.isMining) return 'Mining';
  if (state.isFarming) return 'Farming';
  if (state.isLooting) return 'Looting';
  if (state.combatTarget) return `Fighting ${state.combatTarget}`;
  if (state.behaviorMode === 'tunneling') return 'Tunneling';
  if (state.behaviorMode === 'follow') return 'Following';
  if (state.behaviorMode === 'wander') return 'Wandering';
  if (bot.pathfinder?.goal) return 'Moving';
  return 'Idle';
}

function startApi(bot) {
  if (_server) {
    _server.close();
    _server = null;
  }

  let _bot = bot;

  _server = http.createServer((req, res) => {
    if (req.url === '/cockpit') {
      fs.readFile(COCKPIT_PATH, 'utf8', (err, html) => {
        if (err) { res.writeHead(500); return res.end('cockpit.html missing'); }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.writeHead(200);
        res.end(html);
      });
      return;
    }
    if (req.url === '/api/clones') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      return res.end(JSON.stringify(buildClonesState()));
    }
    if (req.url !== '/api/state') {
      res.writeHead(404);
      return res.end('Not found');
    }
    // Allow HUD overlay (different origin) to fetch
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(buildState(_bot)));
  });

  _server.listen(API_PORT, '0.0.0.0', () => {
    console.log(`[API] HUD state → http://localhost:${API_PORT}/api/state`);
  });

  _server.on('error', err => {
    console.error('[API] Server error:', err.message);
  });

  // Push behavior mode to Solsai every 2s so the client HUD doesn't need port 3008
  const pushInterval = setInterval(() => {
    if (_bot && _bot.entity) pushModeToSolsai(BOT_USERNAME, state.behaviorMode, deriveCurrentAction(_bot));
  }, 2000);
  _server.on('close', () => clearInterval(pushInterval));

  // Allow callers to update the bot reference after reconnect
  return {
    setBot: (newBot) => { _bot = newBot; },
  };
}

module.exports = { startApi, pushModeToSolsai };
