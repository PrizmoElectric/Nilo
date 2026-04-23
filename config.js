// config.js — constants and config file I/O

const fs = require('fs');

const BOT_USERNAME = 'NILO';
const MASTER       = 'PrizmoElectric'; // owner — change here if username ever changes
const HOST         = 'localhost';
const PORT         = 25565;
const MC_VERSION   = '1.20.1';
const LETTA_URL    = 'http://localhost:8283/v1/agents/agent-9fb13e9e-f9ce-4802-b90d-ffb5eceb5434/messages';
const LOG_PATH     = '/home/prizmo/mc-prominence2/data/logs/latest.log';
const CONFIG_PATH  = '/home/prizmo/nilo/config.json';

// Discord bridge — set these in environment variables or edit directly here
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN      || '';
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';  // main bridge channel
const DISCORD_MASTER_ID  = process.env.DISCORD_MASTER_ID  || '';  // your Discord user ID

// Mature crop states: block name -> required metadata/age
const MATURE_CROPS = {
  'wheat':     { age: 7 },
  'carrots':   { age: 7 },
  'potatoes':  { age: 7 },
  'beetroots': { age: 3 },
};

// Minecraft death message verbs — matches "<player> <verb> ..."
const DEATH_VERBS = /^(.+?) (was slain|was shot|was killed|was blown up|was poked|was impaled|was stung|was fireballed|drowned|burned to death|blew up|fell from|fell off|fell out|fell into|fell while|hit the ground|flew into|went up in flames|walked into|died|starved to death|suffocated|was struck by lightning|froze to death|was squished|tried to swim in lava|discovered the floor|experienced kinetic energy)/;
const ADVANCEMENT_RE = /^(.+?) has (made the advancement|completed the challenge|reached the goal) \[(.+?)\]/;
const JOIN_RE  = /^(.+?) joined the game$/;
const LEAVE_RE = /^(.+?) left the game$/;

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
  BOT_USERNAME, MASTER, HOST, PORT, MC_VERSION, LETTA_URL, LOG_PATH, CONFIG_PATH,
  DISCORD_TOKEN, DISCORD_CHANNEL_ID, DISCORD_MASTER_ID,
  MATURE_CROPS, DEATH_VERBS, ADVANCEMENT_RE, JOIN_RE, LEAVE_RE,
  loadConfig, saveConfig,
};
