// db.js — SQLite knowledge base (nilo.db)
// Single source of truth for block physics, state ID mappings, entity knowledge,
// named locations, and the full history of what the player has taught Nilo.

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = path.join(__dirname, 'nilo.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS state_ids (
    state_id   INTEGER PRIMARY KEY,
    block_name TEXT    NOT NULL,
    source     TEXT    NOT NULL DEFAULT 'auto',
    confidence TEXT    NOT NULL DEFAULT 'low',
    taught_by  TEXT,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS blocks (
    name         TEXT PRIMARY KEY,
    bounding_box TEXT,
    is_solid     INTEGER,
    transparent  INTEGER,
    passable     INTEGER,
    hardness     REAL,
    shapes_json  TEXT,
    source       TEXT NOT NULL DEFAULT 'auto',
    confidence   TEXT NOT NULL DEFAULT 'low',
    taught_by    TEXT,
    updated_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS entities (
    name        TEXT PRIMARY KEY,
    is_hostile  INTEGER,
    source      TEXT NOT NULL DEFAULT 'auto',
    confidence  TEXT NOT NULL DEFAULT 'low',
    taught_by   TEXT,
    updated_at  INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS locations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    x          REAL NOT NULL,
    y          REAL NOT NULL,
    z          REAL NOT NULL,
    label      TEXT NOT NULL,
    notes      TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS learned (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    taught_by  TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
  );
`);

// One-time migration: import manual overrides from modded-state-ids.json on first run
const OVERRIDE_FILE = path.join(__dirname, 'modded-state-ids.json');
const existing = db.prepare("SELECT COUNT(*) AS n FROM state_ids WHERE source = 'manual'").get();
if (existing.n === 0 && fs.existsSync(OVERRIDE_FILE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
    const entries = Object.entries(raw);
    if (entries.length) {
      const insert = db.prepare(`
        INSERT OR REPLACE INTO state_ids (state_id, block_name, source, confidence)
        VALUES (?, ?, 'manual', 'manual')
      `);
      db.transaction(() => { for (const [k, v] of entries) insert.run(parseInt(k), v); })();
      console.log(`[DB] Migrated ${entries.length} manual overrides from modded-state-ids.json`);
    }
  } catch (e) {
    console.warn('[DB] Migration from modded-state-ids.json failed:', e.message);
  }
}

module.exports = db;
