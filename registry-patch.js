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
  passable:              { boundingBox: 'empty', transparent: true,  shapes: [] },
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
  // Modded blocks (contain ':') default to solid — wrong physics is less harmful than being invisible.
  // The player can override with "X is passable" teaching.
  if (name.includes(':')) {
    return {
      boundingBox: 'block',
      transparent: name.includes('glass'),
      shapes:      [[0, 0, 0, 1, 1, 1]],
    };
  }
  // Vanilla heuristic: common solid name patterns
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

// ── VarInt / String reader+writer ────────────────────────────────────────────

function writeVarInt(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return Buffer.from(bytes);
}

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

// ── Early-registration helpers ────────────────────────────────────────────────
// The server sends fabric-networking-api-v1:early_registration during the login
// phase with a list of channels it supports. We parse it and respond with only
// the registry-sync channels — nothing else, to avoid triggering verification
// that Nilo can't pass.

const REGISTRY_SYNC_CHANNELS = [
  'fabric:registry/sync/direct',   // Fabric API v2 play-phase (1.20.1 Prominence 2)
  'fabric:registry/sync/full',
  'fabric:registry_sync',
  'fabric-registry-sync-v1:registry_sync',
  'fabric-registry-sync-v0:registry_sync',
  'fabric-registry-sync-v0:registry/sync',
];

function parseEarlyRegistrationChannels(buf) {
  // Format: null-separated UTF-8 channel names (same as minecraft:register).
  // No count prefix, no length prefixes — just "ch1\0ch2\0ch3".
  if (!buf || !buf.length) return [];
  return buf.toString('utf8').split('\0').map(s => s.trim()).filter(Boolean);
}

function buildEarlyRegistrationResponse(packetData) {
  const serverChannels = parseEarlyRegistrationChannels(packetData);
  const registryCh = serverChannels.filter(ch => ch.includes('registry') || ch.includes('sync'));
  console.log(`[REGISTRY] early_registration: ${serverChannels.length} channels total, registry-related: [${registryCh.join(', ') || 'none'}]`);
  const want = serverChannels.filter(ch => REGISTRY_SYNC_CHANNELS.includes(ch));
  if (want.length === 0) return Buffer.from([0x00]);
  console.log('[REGISTRY] Requesting login channels:', want.join(', '));
  const parts = [writeVarInt(want.length)];
  for (const ch of want) {
    const enc = Buffer.from(ch, 'utf8');
    parts.push(writeVarInt(enc.length), enc);
  }
  return Buffer.concat(parts);
}

function handleLoginRegistrySync(packetData) {
  const data     = parseFabricRegistrySync(packetData);
  const blockKey = Object.keys(data).find(k => k.includes('block'));
  const itemKey  = Object.keys(data).find(k => k.includes('item'));

  if (blockKey) {
    moddedBlocks = Object.entries(data[blockKey])
      .filter(([name]) => !name.startsWith('minecraft:'))
      .map(([name, blockId]) => ({ name, blockId }))
      .sort((a, b) => a.blockId - b.blockId);
    console.log(`[REGISTRY] Login sync: ${moddedBlocks.length} modded block names`);
  }

  if (itemKey) {
    const moddedItems = Object.entries(data[itemKey])
      .filter(([name]) => !name.startsWith('minecraft:'))
      .map(([name, itemId]) => ({ name, itemId }))
      .sort((a, b) => a.itemId - b.itemId);
    console.log(`[REGISTRY] Login sync: ${moddedItems.length} modded item names`);
  }

  if (!blockKey) {
    console.warn('[REGISTRY] Login sync: no block registry found. Keys:', Object.keys(data).join(', ') || '(none parsed)');
  }
}

// ── Fabric registry sync parser ───────────────────────────────────────────────

function parseFabricRegistrySync(buf) {
  // Try parsing from offset 0 first. If the first VarInt looks like a boolean
  // flag byte (0x00 or 0x01 followed by a plausible registry count), try offset 1.
  for (const startOffset of [0, 1]) {
    const result = _tryParseRegistries(buf, startOffset);
    if (result !== null) return result;
  }
  console.warn('[REGISTRY] Parse failed at both offset 0 and 1');
  return {};
}

function _tryParseRegistries(buf, startOffset) {
  const registries = {};
  let offset = startOffset;
  try {
    const countR = readVarInt(buf, offset); offset = countR.offset;
    const count  = countR.value;
    if (count <= 0 || count > 50000) return null; // sanity check
    for (let r = 0; r < count; r++) {
      const regName    = readString(buf, offset); offset = regName.offset;
      const entryCount = readVarInt(buf, offset);  offset = entryCount.offset;
      if (entryCount.value < 0 || entryCount.value > 1000000) return null;
      const entries = {};
      for (let e = 0; e < entryCount.value; e++) {
        const name = readString(buf, offset); offset = name.offset;
        const id   = readVarInt(buf, offset);  offset = id.offset;
        entries[name.value] = id.value;
      }
      registries[regName.value] = entries;
    }
    return registries;
  } catch (_) {
    return null;
  }
}

// ── Gap-analysis assignment ───────────────────────────────────────────────────
//
// Fabric assigns block IDs and state IDs in the same registration order.
// Unknown state IDs above vanillaMax arrive in the same order as moddedBlocks.
// Consecutive-ID runs suggest a single block type; gaps are block boundaries.

function resolveMapping(bot) {
  if (!moddedBlocks.length || !vanillaMax) return;

  // Include all discovered modded IDs, even ones already in the registry.
  // !bot.registry.blocksByStateId[id] would wrongly exclude previously-patched
  // IDs (the registry is shared across reconnects), preventing re-analysis.
  const unknownIds = [...discovered]
    .filter(id => id > vanillaMax)
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

// ── Ground-truth source (context mod) ────────────────────────────────────────

function applyGroundTruth(bot, mappings) {
  // mappings: {stateId (string) → name (string)} from the server-side Fabric mod.
  // Confidence 'ground_truth' beats all heuristic tiers but not 'manual'.
  let applied = 0;
  let mismatches = 0;

  for (const [idStr, name] of Object.entries(mappings)) {
    const id = parseInt(idStr);
    if (!id || !name) continue;
    if (manualOverrides[id]) continue; // manual always wins

    const existing = resolved[id];
    if (existing && existing.confidence !== 'ground_truth' && existing.name !== name) {
      console.log(
        `[CTX-MOD] Mismatch stateId ${id}: gap-analysis="${existing.name}" (${existing.confidence}) → ground-truth="${name}"`
      );
      mismatches++;
    }

    if (!existing || existing.name !== name || existing.confidence !== 'ground_truth') {
      resolved[id] = { name, confidence: 'ground_truth' };
      applied++;
    }
  }

  if (applied > 0) {
    stmtUpsertMany(
      Object.entries(mappings)
        .filter(([idStr]) => !manualOverrides[parseInt(idStr)])
        .map(([idStr, name]) => [parseInt(idStr), { name, source: 'ground_truth', confidence: 'ground_truth' }])
    );
    patchRegistryFromResolved(bot);
    console.log(`[CTX-MOD] Ground truth: ${applied} applied, ${mismatches} corrected gap-analysis mismatches`);
  }
}

function getDiscovered() { return discovered; }
function getResolved()   { return resolved; }

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

// ── Block interaction learner ─────────────────────────────────────────────────
// Watches blockUpdate events. Any stateId > vanillaMax that isn't already
// resolved or manually mapped gets added to discovered, then resolveMapping()
// runs (debounced) to try to name it via gap-analysis.
// No held-item data — only the block's own stateId is used.

// ── Proximity passive scan ────────────────────────────────────────────────────
// While following or moving, samples stateIds from a small radius around Nilo
// in already-loaded chunks every 5 seconds. Any unknown modded stateId gets
// added to discovered and triggers resolveMapping().
// Radius is intentionally small (6 blocks) — this is not a scan, just
// incidental discovery as Nilo walks through the world.

// ── findBlocksByName ──────────────────────────────────────────────────────────
// Registry-independent block search. Reads stateIds directly from the world
// (same approach as scan.js) so it works for any modded block regardless of
// whether it has been patched into bot.registry yet.
// keyword: substring to match against block name (e.g. 'chest', 'barrel')
// Returns: array of Vec3 positions (up to maxCount), sorted nearest-first.

function findBlocksByName(bot, keyword, maxDistance = 32, maxCount = 20) {
  const kw  = keyword.toLowerCase();
  const pos = bot.entity.position.floored();
  const hits = [];

  for (let x = pos.x - maxDistance; x <= pos.x + maxDistance && hits.length < maxCount; x++) {
    for (let y = Math.max(-64, pos.y - maxDistance); y <= Math.min(320, pos.y + maxDistance) && hits.length < maxCount; y++) {
      for (let z = pos.z - maxDistance; z <= pos.z + maxDistance && hits.length < maxCount; z++) {
        const vec = { x, y, z };
        const sid = bot.world.getBlockStateId(vec);
        if (!sid) continue;

        const b    = bot.blockAt(vec);
        const name = (b?.name && b.name !== '' && b.name !== 'unknown')
          ? b.name
          : (getModdedBlockName(sid) || '');

        if (name && name.toLowerCase().includes(kw)) hits.push({ x, y, z });
      }
    }
  }

  hits.sort((a, b) => {
    const da = Math.hypot(a.x - pos.x, a.y - pos.y, a.z - pos.z);
    const db = Math.hypot(b.x - pos.x, b.y - pos.y, b.z - pos.z);
    return da - db;
  });

  const Vec3 = require('vec3');
  return hits.map(({ x, y, z }) => new Vec3(x, y, z));
}

function installProximityLearner(bot, state) {
  const RADIUS   = 6;
  const INTERVAL = 5000;

  setInterval(() => {
    if (!vanillaMax) return;
    if (state.behaviorMode === 'idle') return; // only learn while moving

    const pos = bot.entity.position.floored();
    let pendingResolve = false;

    for (let x = pos.x - RADIUS; x <= pos.x + RADIUS; x++) {
      for (let y = Math.max(-64, pos.y - RADIUS); y <= Math.min(320, pos.y + RADIUS); y++) {
        for (let z = pos.z - RADIUS; z <= pos.z + RADIUS; z++) {
          const sid = bot.world.getBlockStateId({ x, y, z });
          if (!sid || sid <= vanillaMax) continue;
          if (resolved[sid] || manualOverrides[sid] || discovered.has(sid)) continue;
          discovered.add(sid);
          pendingResolve = true;
        }
      }
    }

    if (pendingResolve) resolveMapping(bot);
  }, INTERVAL);
}

function installBlockUpdateLearner(bot) {
  let learnTimer    = null;
  let pendingResolve = false;

  function maybeDiscover(sid) {
    if (!sid || sid <= vanillaMax) return;
    if (resolved[sid] || manualOverrides[sid] || discovered.has(sid)) return;
    discovered.add(sid);
    pendingResolve = true;
  }

  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (!vanillaMax) return;
    if (oldBlock) maybeDiscover(oldBlock.stateId);
    maybeDiscover(newBlock.stateId);

    if (pendingResolve && !learnTimer) {
      learnTimer = setTimeout(() => {
        learnTimer      = null;
        pendingResolve  = false;
        resolveMapping(bot);
      }, 500);
    }
  });
}

// ── Install ───────────────────────────────────────────────────────────────────

const SYNC_CHANNELS = REGISTRY_SYNC_CHANNELS; // play-phase fallback = same set

const MOD_BLOCK_LIST = path.join(__dirname, 'mod-block-list.json');

function loadModBlockList() {
  if (moddedBlocks.length) return; // already populated by Fabric sync
  try {
    const names = JSON.parse(fs.readFileSync(MOD_BLOCK_LIST, 'utf8'));
    moddedBlocks = names.map((name, i) => ({ name, blockId: i }));
    console.log(`[REGISTRY] Loaded ${moddedBlocks.length} block names from mod-block-list.json`);
  } catch (_) {
    console.warn('[REGISTRY] mod-block-list.json not found — run: node scan-mod-blocks.js');
  }
}

function installRegistryPatch(bot) {
  loadFromDB();

  // Fabric registry sync (play-phase) — catches servers that do send block registry
  bot._client.on('custom_payload', (packet) => {
    if (!SYNC_CHANNELS.some(ch => packet.channel === ch)) return;
    const data = packet.data;
    if (!data?.length) return;
    console.log(`[REGISTRY] Sync packet on ${packet.channel} (${data.length} bytes)`);
    const registries = parseFabricRegistrySync(data);
    const blockKey   = Object.keys(registries).find(k => k.includes('block'));
    if (!blockKey) return;
    moddedBlocks = Object.entries(registries[blockKey])
      .filter(([name]) => !name.startsWith('minecraft:'))
      .map(([name, blockId]) => ({ name, blockId }))
      .sort((a, b) => a.blockId - b.blockId);
    console.log(`[REGISTRY] Captured ${moddedBlocks.length} modded block names from ${blockKey}`);
  });

  bot.once('spawn', () => {
    // Fall back to JAR-scanned list if no Fabric sync was received
    loadModBlockList();

    // Compute vanillaMax once from the unpatched registry. On reconnect the
    // registry object is shared (Node module cache) and already contains
    // patched modded state IDs — recomputing would give a wrong high value
    // that would exclude all modded IDs from gap analysis.
    if (!vanillaMax) {
      vanillaMax = Math.max(...Object.keys(bot.registry.blocksByStateId).map(Number));
    }
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

module.exports = { installRegistryPatch, installBlockUpdateLearner, installProximityLearner, findBlocksByName, getModdedBlockName, getConfidence, setManualOverride, getStateIdsByName, setManualBlockPhysics, buildEarlyRegistrationResponse, handleLoginRegistrySync, REGISTRY_SYNC_CHANNELS, applyGroundTruth, getDiscovered, getResolved };
