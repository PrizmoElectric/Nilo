// logger.js — routes console output to per-category log files under logs/YYYY-MM-DD/
//
// All existing [TAG] prefixes ([NILO], [REGISTRY], [SKILL], etc.) are detected
// automatically — no changes needed in other modules.
//
// Output structure:
//   logs/YYYY-MM-DD/nilo.log       ← [NILO] messages
//   logs/YYYY-MM-DD/registry.log   ← [REGISTRY] messages
//   logs/YYYY-MM-DD/skill.log      ← [SKILL] messages
//   logs/YYYY-MM-DD/discord.log    ← [DISCORD] messages
//   logs/YYYY-MM-DD/error.log      ← ALL errors, regardless of tag
//   logs/YYYY-MM-DD/main.log       ← untagged messages
//   (new categories appear automatically as new [TAG] prefixes are used)

const fs   = require('fs');
const path = require('path');

const LOG_BASE = path.join(__dirname, 'logs');

let currentDate = '';
let streams     = {};  // category → WriteStream

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getStream(category) {
  const date = today();

  if (date !== currentDate) {
    for (const s of Object.values(streams)) try { s.end(); } catch (_) {}
    streams     = {};
    currentDate = date;
  }

  if (!streams[category]) {
    const dir = path.join(LOG_BASE, date);
    fs.mkdirSync(dir, { recursive: true });
    streams[category] = fs.createWriteStream(
      path.join(dir, `${category}.log`), { flags: 'a' }
    );
  }

  return streams[category];
}

function route(level, args) {
  const ts   = new Date().toLocaleTimeString();
  const text = args
    .map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'object' ? JSON.stringify(a) : String(a)))
    .join(' ');
  const line = `[${ts}] ${text}`;

  // Detect [TAG] prefix — first bracket group of all-caps letters/digits/underscores
  const match    = text.match(/^\[([A-Z][A-Z_0-9]*)\]/);
  const category = match ? match[1].toLowerCase() : 'main';

  getStream(category).write(line + '\n');

  // Errors always get a second copy in error.log for easy triage
  if (level === 'error' && category !== 'error') {
    getStream('error').write(line + '\n');
  }
}

function install() {
  const orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args) => {
    route('log', args);
    orig.log(`[${new Date().toLocaleTimeString()}]`, ...args);
  };
  console.warn = (...args) => {
    route('warn', args);
    orig.warn(`[${new Date().toLocaleTimeString()}]`, ...args);
  };
  console.error = (...args) => {
    route('error', args);
    orig.error(`[${new Date().toLocaleTimeString()}]`, ...args);
  };

  // Flush streams cleanly on exit
  process.on('exit',    closeAll);
  process.on('SIGINT',  () => { closeAll(); process.exit(0); });
  process.on('SIGTERM', () => { closeAll(); process.exit(0); });
}

function closeAll() {
  for (const s of Object.values(streams)) try { s.end(); } catch (_) {}
}

module.exports = { install };
