// registry-patch.js — Fabric modded block registry auto-mapper
// Persistent storage backed by nilo.db (via db.js).
// Manual overrides take priority over auto-resolved mappings.
//
// Pipeline (runs on every connect):
//   1. Load all state_ids from DB into in-memory caches
//   2. Capture modded block names from Fabric registry sync packet
//   3. After spawn: record vanilla max state ID, patch registry from DB entries
//   4. As chunks load: scan palettes for unknown state IDs > vanillaMax
//   5. Gap analysis: consecutive runs → block boundaries → assign + save to DB
//   6. patchRegistryFromResolved: build descriptors using DB blocks table for physics

const fs   = require('fs');
const path = require('path');
const db   = require('./db');

const UNCERTAIN_LOG = path.join(__dirname, 'modded-blocks-uncertain.log');

// ── In-memory caches ──────────────────────────────────────────────────────────

let moddedBlocks    = [];       // [{name, blockId}] sorted by blockId asc (registration order)
let discovered      = new Set(); // state IDs seen in chunk palettes
let resolved        = {};        // stateId → {name, confidence}
let manualOverrides = {};        // stateId → name
let vanillaMax      = 0;

// ── Block physics ─────────────────────────────────────────────────────────────
// Resolution order: blocks DB table → BLOCK_PHYSICS fallback → heuristic.
// DB entries always win so the player can teach Nilo correct physics conversationally.

const BLOCK_PHYSICS = {
  grass:                 { boundingBox: 'empty', transparent: true,  shapes: [] },
  tall_grass:            { boundingBox: 'empty', transparent: true,  shapes: [] },
  fern:                  { boundingBox: 'empty', transparent: true,  shapes: [] },
  large_fern:            { boundingBox: 'empty', transparent: true,  shapes: [] },
  dead_bush:             { boundingBox: 'empty', transparent: true,  shapes: [] },
  vine:                  { boundingBox: 'empty', transparent: true,  shapes: [] },
  podzol:                { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  mycelium:              { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  coarse_dirt:           { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  rooted_dirt:           { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  mud:                   { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  pumpkin_stem:          { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  attached_pumpkin_stem: { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  melon_stem:            { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
  attached_melon_stem:   { boundingBox: 'block', transparent: false, shapes: [[0,0,0,1,1,1]] },
};

const stmtGetBlock      = db.prepare('SELECT * FROM blocks WHERE name = ?');
const stmtGetAllBlocks  = db.prepare('SELECT name, bounding_box, transparent, shapes_json FROM blocks');
const stmtUpsertBlock   = db.prepare(`
  INSERT INTO blocks (name, bounding_box, is_solid, transparent, passable, shapes_json, source, confidence, taught_by, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, 'player', 'manual', ?, strftime('%s', 'now'))
  ON CONFLICT(name) DO UPDATE SET
    bounding_box = excluded.bounding_box,
    is_solid     = excluded.is_solid,
    transparent  = excluded.transparent,
    passable     = excluded.passable,
    shapes_json  = excluded.shapes_json,
    source       = excluded.source,
    confidence   = excluded.confidence,
    taught_by    = excluded.taught_by,
    updated_at   = excluded.updated_at
`);

function getPhysicsForName(name) {
  const row = stmtGetBlock.get(name);
  if (row) {
    return {
      boundingBox: row.bounding_box,
      transparent: !!row.transparent,
      shapes: row.shapes_json ? JSON.parse(row.shapes_json) : [],
    };
  }
  if (BLOCK_PHYSICS[name]) return BLOCK_PHYSICS[name];
  // Heuristic: common solid block name patterns
  const isSolid = name.includes('brick') || name.includes('stone') || name.includes('plank')
    || (name.includes('glass') && !name.includes('pane'));
  return {
    boundingBox: isSolid ? 'block' : 'empty',
    transparent: !isSolid || name.includes('glass'),
    shapes:      isSolid ? [[0, 0, 0, 1, 1, 1]] : [],
  };
}

// ── DB persistence ────────────────────────────────────────────────────────────

const stmtUpsertStateId = db.prepare(`
  INSERT INTO state_ids (state_id, block_name, source, confidence, updated_at)
  VALUES (?, ?, ?, ?, strftime('%s', 'now'))
  ON CONFLICT(state_id) DO UPDATE SET
    block_name = excluded.block_name,
    source     = excluded.source,
    confidence = excluded.confidence,
    updated_at = excluded.updated_at
`);

const stmtUpsertMany = db.transaction((entries) => {
  for (const [stateId, info] of entries) {
    stmtUpsertStateId.run(stateId, info.name, info.source || 'auto', info.confidence);
  }
});

function loadFromDB() {
  const rows = db.prepare('SELECT * FROM state_ids').all();
  for (const row of rows) {
    if (row.source === 'manual') {
      manualOverrides[row.state_id] = row.block_name;
    } else {
      resolved[row.state_id] = { name: row.block_name, confidence: row.confidence };
    }
  }
  console.log(`[REGISTRY] Loaded ${Object.keys(manualOverrides).length} manual + ${Object.keys(resolved).length} auto from DB`);
}

function saveMapping() {
  const entries = Object.entries(resolved)
    .map(([id, info]) => [parseInt(id), { name: info.name, source: 'auto', confidence: info.confidence }]);
  if (entries.length) stmtUpsertMany(entries);
}

// ── Uncertain log ─────────────────────────────────────────────────────────────

function logUncertain(entries) {
  if (!entries.length) return;
  const ts = new Date().toISOString();
  const lines = entries.map(e =>
    `${ts} [${e.confidence.toUpperCase().padEnd(6)}] stateId=${String(e.stateId).padStart(6)}  name=${e.name}  reason: ${e.reason}`
  );
  try { fs.appendFileSync(UNCERTAIN_LOG, lines.join('\n') + '\n', 'utf8'); } catch (_) {}
}

// ── VarInt / String reader ────────────────────────────────────────────────────

function readVarInt(buf, offset) {
  let result = 0, shift = 0, byte;
  do {
    if (offset >= buf.length) throw new Error('VarInt read past end of buffer');
    byte = buf[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result, offset };
}

function readString(buf, offset) {
  const len = readVarInt(buf, offset);
  offset = len.offset;
  const str = buf.slice(offset, offset + len.value).toString('utf8');
  return { value: str, offset: offset + len.value };
}

// ── Fabric registry sync parser ───────────────────────────────────────────────

function parseFabricRegistrySync(buf) {
  const registries = {};
  let offset = 0;
  try {
    const peek = readVarInt(buf, 0);
    let count = peek.value;
    offset = peek.offset;
    if (count > 1000) {
      offset = 1;
      const retry = readVarInt(buf, offset);
      count = retry.value;
      offset = retry.offset;
    }
    for (let r = 0; r < count; r++) {
      const regName    = readString(buf, offset); offset = regName.offset;
      const entryCount = readVarInt(buf, offset);  offset = entryCount.offset;
      const entries = {};
      for (let e = 0; e < entryCount.value; e++) {
        const name = readString(buf, offset); offset = name.offset;
        const id   = readVarInt(buf, offset);  offset = id.offset;
        entries[name.value] = id.value;
      }
      registries[regName.value] = entries;
    }
  } catch (err) {
    console.warn('[REGISTRY] Parse error (partial data may still work):', err.message);
  }
  return registries;
}

// ── Gap-analysis assignment ───────────────────────────────────────────────────
//
// Fabric assigns block IDs and state IDs in the same registration order.
// Unknown state IDs above vanillaMax arrive in the same order as moddedBlocks.
// Consecutive-ID runs suggest a single block type; gaps are block boundaries.

function resolveMapping(bot) {
  if (!moddedBlocks.length || !vanillaMax) return;

  const unknownIds = [...discovered]
    .filter(id => id > vanillaMax && !bot.registry.blocksByStateId[id])
    .sort((a, b) => a - b);

  if (!unknownIds.length) return;

  const segments = [];
  let cur = [unknownIds[0]];
  for (let i = 1; i < unknownIds.length; i++) {
    if (unknownIds[i] === unknownIds[i - 1] + 1) {
      cur.push(unknownIds[i]);
    } else {
      segments.push(cur);
      cur = [unknownIds[i]];
    }
  }
  segments.push(cur);

  const nBlocks   = moddedBlocks.length;
  const nSegments = segments.length;
  const uncertain = [];
  const fresh     = {};

  if (nSegments === nBlocks) {
    for (let i = 0; i < nBlocks; i++) {
      for (const id of segments[i]) {
        fresh[id] = { name: moddedBlocks[i].name, confidence: 'high' };
      }
    }
  } else if (nSegments < nBlocks) {
    for (let i = 0; i < nSegments; i++) {
      const block = moddedBlocks[i];
      for (const id of segments[i]) {
        fresh[id] = { name: block.name, confidence: 'medium' };
        uncertain.push({ stateId: id, name: block.name, confidence: 'medium',
          reason: `${nSegments} segments observed, ${nBlocks} modded blocks — explore more to improve accuracy` });
      }
    }
  } else {
    for (let i = 0; i < unknownIds.length; i++) {
      const bi    = Math.min(Math.floor((i / unknownIds.length) * nBlocks), nBlocks - 1);
      const block = moddedBlocks[bi];
      fresh[unknownIds[i]] = { name: block.name, confidence: 'low' };
      uncertain.push({ stateId: unknownIds[i], name: block.name, confidence: 'low',
        reason: `${nSegments} segments > ${nBlocks} blocks — use blockmap command to correct` });
    }
  }

  let patched = 0;
  for (const [idStr, info] of Object.entries(fresh)) {
    const id = parseInt(idStr);
    if (manualOverrides[id]) continue;
    if (resolved[id]?.confidence === 'high' && info.confidence !== 'high') continue;
    if (!resolved[id] || resolved[id].name !== info.name) { resolved[id] = info; patched++; }
  }

  if (patched > 0) {
    logUncertain(uncertain);
    saveMapping();
    patchRegistryFromResolved(bot);
    console.log(`[REGISTRY] Resolved ${Object.keys(resolved).length} state IDs (${patched} updated, ${nSegments} segments vs ${nBlocks} blocks)`);
  }
}

// ── Registry patcher ──────────────────────────────────────────────────────────

function patchRegistryFromResolved(bot) {
  const byName   = {};
  const manualIds = new Set(Object.keys(manualOverrides).map(Number));

  const add = (stateId, name) => {
    if (!byName[name]) byName[name] = [];
    byName[name].push(stateId);
  };

  for (const [id, info] of Object.entries(resolved))       add(parseInt(id), info.name);
  for (const [id, name] of Object.entries(manualOverrides)) add(parseInt(id), name);

  for (const [name, stateIds] of Object.entries(byName)) {
    const sorted  = stateIds.sort((a, b) => a - b);
    const physics = getPhysicsForName(name);

    const descriptor = {
      id:           sorted[0],
      name,
      displayName:  name,
      hardness:     physics.boundingBox === 'block' ? 1.5 : 1,
      resistance:   physics.boundingBox === 'block' ? 6 : 1,
      stackSize:    64,
      diggable:     true,
      transparent:  physics.transparent,
      emitLight:    0,
      filterLight:  15,
      defaultState: sorted[0],
      minStateId:   sorted[0],
      maxStateId:   sorted[sorted.length - 1],
      states:       [],
      shapes:       physics.shapes,
      boundingBox:  physics.boundingBox,
    };

    for (const id of sorted) {
      if (manualIds.has(id) || resolved[id]) {
        bot.registry.blocksByStateId[id] = descriptor;
      } else if (!bot.registry.blocksByStateId[id]) {
        bot.registry.blocksByStateId[id] = descriptor;
      }
    }

    if (!bot.registry.blocksByName[name]) bot.registry.blocksByName[name] = descriptor;
  }

  // Apply BLOCK_PHYSICS corrections to vanilla descriptors (not already handled via DB).
  // These are vanilla block names — their registry entries exist but have wrong physics.
  for (const [name, fix] of Object.entries(BLOCK_PHYSICS)) {
    const bbn = bot.registry.blocksByName[name];
    if (bbn) Object.assign(bbn, fix);
  }

  // Apply player-taught block physics (blocks DB table) to vanilla descriptors.
  // DB entries override BLOCK_PHYSICS so manual teaching always wins.
  for (const row of stmtGetAllBlocks.all()) {
    const bbn = bot.registry.blocksByName[row.name];
    if (!bbn) continue;
    const shapes = row.shapes_json ? JSON.parse(row.shapes_json)
      : (row.bounding_box === 'block' ? [[0, 0, 0, 1, 1, 1]] : []);
    const fix = { boundingBox: row.bounding_box, transparent: !!row.transparent, shapes };
    Object.assign(bbn, fix);
    for (let id = bbn.minStateId; id <= bbn.maxStateId; id++) {
      if (bot.registry.blocksByStateId[id]) Object.assign(bot.registry.blocksByStateId[id], fix);
    }
  }
}

// ── Chunk palette scanner ─────────────────────────────────────────────────────

function scanColumn(column) {
  let found = 0;
  if (!column?.sections) return found;
  for (const section of column.sections) {
    if (!section) continue;
    if (Array.isArray(section.palette)) {
      for (const id of section.palette) {
        if (id > vanillaMax && !discovered.has(id)) { discovered.add(id); found++; }
      }
    }
    const sv = section.data?.value;
    if (typeof sv === 'number' && sv > vanillaMax && !discovered.has(sv)) {
      discovered.add(sv); found++;
    }
  }
  return found;
}

// ── Public API ────────────────────────────────────────────────────────────────

function getModdedBlockName(stateId) {
  if (manualOverrides[stateId]) return manualOverrides[stateId];
  if (resolved[stateId])        return resolved[stateId].name;
  return null;
}

function getConfidence(stateId) {
  if (manualOverrides[stateId]) return 'manual';
  return resolved[stateId]?.confidence ?? null;
}

function setManualOverride(bot, stateId, name) {
  manualOverrides[stateId] = name;
  stmtUpsertStateId.run(stateId, name, 'manual', 'manual');
  patchRegistryFromResolved(bot);
  console.log(`[REGISTRY] Manual override: stateId ${stateId} → ${name}`);
}

function getStateIdsByName(bot, name) {
  const ids = new Set();
  for (const [id, n] of Object.entries(manualOverrides)) {
    if (n === name) ids.add(parseInt(id));
  }
  for (const [id, info] of Object.entries(resolved)) {
    if (info.name === name) ids.add(parseInt(id));
  }
  const vanilla = bot.registry.blocksByName[name];
  if (vanilla) {
    for (let id = vanilla.minStateId; id <= vanilla.maxStateId; id++) ids.add(id);
  }
  return [...ids];
}

function setManualBlockPhysics(bot, name, boundingBox, taughtBy) {
  const isSolid  = boundingBox === 'block' ? 1 : 0;
  const transp   = boundingBox === 'block' ? 0 : 1;
  const passable = boundingBox === 'block' ? 0 : 1;
  const shapes   = JSON.stringify(isSolid ? [[0, 0, 0, 1, 1, 1]] : []);
  stmtUpsertBlock.run(name, boundingBox, isSolid, transp, passable, shapes, taughtBy || null);
  patchRegistryFromResolved(bot);
  console.log(`[REGISTRY] Block physics taught: ${name} → boundingBox=${boundingBox}`);
}

// ── Install ───────────────────────────────────────────────────────────────────

const SYNC_CHANNELS = [
  'fabric-registry-sync-v0:registry_sync',
  'fabric-registry-sync-v1:registry_sync',
  'fabric:registry_sync',
  'fabric-registry-sync-v0:registry/sync',
];

function installRegistryPatch(bot) {
  loadFromDB();

  bot._client.on('custom_payload', (packet) => {
    if (!SYNC_CHANNELS.some(ch => packet.channel === ch)) return;
    const data = packet.data;
    if (!data?.length) return;

    console.log(`[REGISTRY] Sync packet on ${packet.channel} (${data.length} bytes)`);
    const registries = parseFabricRegistrySync(data);
    const blockKey   = Object.keys(registries).find(k => k.includes('block'));
    if (!blockKey) {
      console.warn('[REGISTRY] No block registry in packet. Keys:', Object.keys(registries).join(', '));
      return;
    }

    moddedBlocks = Object.entries(registries[blockKey])
      .filter(([name]) => !name.startsWith('minecraft:'))
      .map(([name, blockId]) => ({ name, blockId }))
      .sort((a, b) => a.blockId - b.blockId);

    console.log(`[REGISTRY] Captured ${moddedBlocks.length} modded block names`);
  });

  bot.once('spawn', () => {
    vanillaMax = Math.max(...Object.keys(bot.registry.blocksByStateId).map(Number));
    console.log(`[REGISTRY] Vanilla ceiling: stateId ${vanillaMax} | tracking ${moddedBlocks.length} modded blocks`);

    if (Object.keys(manualOverrides).length || Object.keys(resolved).length) {
      patchRegistryFromResolved(bot);
    }

    let total = 0;
    for (const { column } of bot.world.getColumns()) total += scanColumn(column);
    if (total > 0) {
      console.log(`[REGISTRY] Found ${total} unknown state IDs from initial chunks`);
      resolveMapping(bot);
    }

    let resolveTimer = null;
    bot.world.on('chunkColumnLoad', (pos) => {
      const column = bot.world.getColumn(pos.x >> 4, pos.z >> 4);
      if (!column) return;
      const found = scanColumn(column);
      if (found > 0 && !resolveTimer) {
        resolveTimer = setTimeout(() => { resolveTimer = null; resolveMapping(bot); }, 3000);
      }
    });
  });

  console.log('[REGISTRY] Registry patch installed — waiting for Fabric sync + spawn');
}

module.exports = { installRegistryPatch, getModdedBlockName, getConfidence, setManualOverride, getStateIdsByName, setManualBlockPhysics };
