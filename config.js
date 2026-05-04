// config.js — constants and config file I/O

const fs   = require('fs');
const path = require('path');

const BOT_USERNAME = 'NILO';
const MASTER       = process.env.MASTER || 'PrizmoElectric';
const LETTA_URL    = process.env.LETTA_URL || 'http://localhost:8283/v1/agents/agent-9fb13e9e-f9ce-4802-b90d-ffb5eceb5434/messages';
const CONFIG_PATH  = '/home/prizmo/nilo/config.json';
const SERVERS_PATH = path.join(__dirname, 'servers.json');

// Discord bridge — set in environment variables or edit directly
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN      || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const DISCORD_MASTER_ID  = process.env.DISCORD_MASTER_ID  || '';

// Mature crop states: block name → required age
const MATURE_CROPS = {
  'wheat':     { age: 7 },
  'carrots':   { age: 7 },
  'potatoes':  { age: 7 },
  'beetroots': { age: 3 },
};

// Minecraft log event patterns
const DEATH_VERBS    = /^(.+?) (was slain|was shot|was killed|was blown up|was poked|was impaled|was stung|was fireballed|drowned|burned to death|blew up|fell from|fell off|fell out|fell into|fell while|hit the ground|flew into|went up in flames|walked into|died|starved to death|suffocated|was struck by lightning|froze to death|was squished|tried to swim in lava|discovered the floor|experienced kinetic energy)/;
const ADVANCEMENT_RE = /^(.+?) has (made the advancement|completed the challenge|reached the goal) \[(.+?)\]/;
const JOIN_RE        = /^(.+?) joined the game$/;
const LEAVE_RE       = /^(.+?) left the game$/;

// ── Dynamic server config ─────────────────────────────────────────────────────
// Read at createBot() time so switching servers works mid-session.

const DEFAULT_SERVER_CONFIG = {
  host:        'localhost',
  port:        25565,
  version:     '1.20.1',
  auth:        'offline',
  log_path:    '/home/prizmo/mc-prominence2/data/logs/latest.log',
  description: '',
};

let _activeServer     = { ...DEFAULT_SERVER_CONFIG };
let _activeServerName = 'prominence2';

function loadServers() {
  try {
    return JSON.parse(fs.readFileSync(SERVERS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function getServerConfig() {
  return _activeServer;
}

function getActiveServerName() {
  return _activeServerName;
}

function setActiveServer(name) {
  const servers = loadServers();
  if (!servers[name]) {
    const available = Object.keys(servers).join(', ') || '(none)';
    throw new Error(`Unknown server: "${name}". Available: ${available}`);
  }
  _activeServer     = { ...DEFAULT_SERVER_CONFIG, ...servers[name] };
  _activeServerName = name;
  console.log(`[SERVER] Profile → ${name} (${_activeServer.host}:${_activeServer.port} v${_activeServer.version})`);
}

function addServer(name, profile) {
  const servers = loadServers();
  servers[name] = profile;
  fs.writeFileSync(SERVERS_PATH, JSON.stringify(servers, null, 2));
  console.log(`[SERVER] Saved profile: ${name}`);
}

// ── Config file helpers ───────────────────────────────────────────────────────

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

module.exports = {
  BOT_USERNAME, MASTER, LETTA_URL, CONFIG_PATH, SERVERS_PATH,
  DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_MASTER_ID,
  MATURE_CROPS, DEATH_VERBS, ADVANCEMENT_RE, JOIN_RE, LEAVE_RE,
  getServerConfig, setActiveServer, getActiveServerName, loadServers, addServer,
  loadConfig, saveConfig,
};
