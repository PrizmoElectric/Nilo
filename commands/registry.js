const Vec3 = require('vec3');
const state = require('../state');
const db    = require('../db');
const { getModdedBlockName, setManualOverride, getStateIdsByName, setManualBlockPhysics } = require('../registry-patch');
const { getPlayerGazeTarget } = require('../gaze');
const { runScan } = require('../skills/scan');
const { cmd } = require('./_util');

const IS_SCAN_BLOCKS = cmd([
  /\bscan\b/,
  /\bwhat (blocks?|is around|do you see|can you see)\b/,
  /\bescaneie?\b/, /\bvarre(r|ia)?\b/, /\bo que (tem|h[aá]) ao redor\b/,
  /\bquais blocos\b/, /\bblocks? (ao redor|perto)\b/,
]);
const IS_ECHO       = cmd([/\becho\b/, /\brepeat (?:the )?last\b/, /\brepete\b/]);
const IS_BLOCK_MAP  = cmd([/\bblockmap\b/, /\bmap stateId\b/, /\bidentify block\b/, /\bmapeia bloco\b/]);
const IS_ID_LOCATE  = cmd([/\bid\s+\d+/, /\bwhere is\s+(id|stateid)\s+\d+/, /\b(find|locate)\s+(id|stateid)\s+\d+/]);

// "X is [actually] hostile" / "X is not hostile" / "X is friendly"
const IS_ENTITY_LEARN = cmd([
  /\bis\s+(?:actually\s+)?hostile\b/,
  /\bis\s+(?:not|friendly|passive|safe)\b/,
  /\b(?:hostile|friendly|passive)\s+mob\b/,
]);

// "what do you know about X"
const IS_KNOW_ABOUT = cmd([
  /\bwhat do you know about\b/,
  /\btell me about\b/,
  /\bdo you know\b.+\?/,
  /\bo que (você )?sabe sobre\b/,
]);

// "X is solid" / "X is passable" / "X is walkable" / "X is not solid"
const IS_BLOCK_PHYSICS = cmd([
  /\bis\s+(?:actually\s+)?solid\b/,
  /\bis\s+(?:actually\s+)?(?:passable|walkable|not solid)\b/,
]);

// Block alias: "<source> is [actually] <target>"
const BLOCK_NAME     = /[a-z][a-z_]*(?::[a-z][a-z_]*)*/;
const IS_BLOCK_ALIAS = new RegExp(
  `(${BLOCK_NAME.source})\\s+is\\s+(?:actually\\s+)?(${BLOCK_NAME.source})`
);

const stmtLearn  = db.prepare('INSERT INTO learned (category, key, value, taught_by) VALUES (?, ?, ?, ?)');
const stmtUpsertEntity = db.prepare(`
  INSERT INTO entities (name, is_hostile, source, confidence, taught_by, updated_at)
  VALUES (?, ?, 'player', 'manual', ?, strftime('%s', 'now'))
  ON CONFLICT(name) DO UPDATE SET
    is_hostile = excluded.is_hostile,
    source     = excluded.source,
    confidence = excluded.confidence,
    taught_by  = excluded.taught_by,
    updated_at = excluded.updated_at
`);

async function handle(bot, lower, raw, username) {
  // ── echo scan ──────────────────────────────────────────────────────────────
  if (IS_ECHO(lower) && /scan/.test(lower)) {
    if (!state.scans.length) { bot.chat('No scans this session. Run "scan" first.'); return true; }

    const rangeMatch  = lower.match(/scan\s+(\d+)-(\d+)/);
    const singleMatch = lower.match(/scan\s+(\d+)/);
    const chatLines   = [];

    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]);
      const to   = Math.min(parseInt(rangeMatch[2]), state.scans.length - 1);
      if (from >= state.scans.length) {
        bot.chat(`Only ${state.scans.length} scan(s) available (0–${state.scans.length - 1}).`);
        return true;
      }
      chatLines.push(`Scans ${from}–${to} (0=latest):`);
      for (let i = from; i <= to; i++) {
        const { rows, radius, stamp } = state.scans[i];
        const top = (rows || []).slice(0, 3).map(([n, c]) => `${n}:${c}`).join(', ');
        chatLines.push(`[${i}] r=${radius} ${stamp} — ${top || 'empty'}`);
      }
    } else {
      const idx = singleMatch ? parseInt(singleMatch[1]) : 0;
      if (idx >= state.scans.length) {
        bot.chat(`Only ${state.scans.length} scan(s) available (0–${state.scans.length - 1}).`);
        return true;
      }
      const { rows, radius, stamp } = state.scans[idx];
      const label = idx === 0 ? 'scan 0 (latest)' : `scan ${idx}`;
      chatLines.push(`${label} r=${radius} @ ${stamp}:`);
      (rows || []).slice(0, 20).forEach(([n, c]) => chatLines.push(`  ${n}: ${c}`));
    }

    let i = 0;
    const send = () => { if (i >= chatLines.length) return; bot.chat(chatLines[i++]); setTimeout(send, 250); };
    send();
    return true;
  }

  // ── scan ───────────────────────────────────────────────────────────────────
  if (IS_SCAN_BLOCKS(lower)) {
    runScan(bot, raw).catch(err => console.error('[SCAN] error:', err.message));
    return true;
  }

  // ── id <stateId> ───────────────────────────────────────────────────────────
  if (IS_ID_LOCATE(lower)) {
    const m = raw.match(/\b(\d+)\b/);
    if (!m) { bot.chat('Usage: id <stateId>'); return true; }
    const targetSid = parseInt(m[1]);

    const pos    = bot.entity.position.floored();
    const radius = 32;
    const hits   = [];

    for (let x = pos.x - radius; x <= pos.x + radius && hits.length < 20; x++) {
      for (let y = Math.max(-64, pos.y - radius); y <= Math.min(320, pos.y + radius) && hits.length < 20; y++) {
        for (let z = pos.z - radius; z <= pos.z + radius && hits.length < 20; z++) {
          const sid = bot.world.getBlockStateId(new Vec3(x, y, z));
          if (sid === targetSid) hits.push({ x, y, z });
        }
      }
    }

    if (!hits.length) {
      bot.chat(`No block with stateId ${targetSid} found within ${radius} blocks.`);
      return true;
    }

    hits.sort((a, b) => {
      const da = Math.hypot(a.x - pos.x, a.y - pos.y, a.z - pos.z);
      const db = Math.hypot(b.x - pos.x, b.y - pos.y, b.z - pos.z);
      return da - db;
    });

    const name    = getModdedBlockName(targetSid) || bot.blockAt(new Vec3(hits[0].x, hits[0].y, hits[0].z))?.name || 'unknown';
    const chatLines = [`stateId ${targetSid} (${name}) — ${hits.length} hit(s):`];
    for (const { x, y, z } of hits.slice(0, 10)) {
      const dist = Math.round(Math.hypot(x - pos.x, y - pos.y, z - pos.z));
      chatLines.push(`  ${x} ${y} ${z}  (${dist}m away)`);
    }
    if (hits.length > 10) chatLines.push(`  ...and ${hits.length - 10} more.`);

    let i = 0;
    const send = () => { if (i >= chatLines.length) return; bot.chat(chatLines[i++]); setTimeout(send, 250); };
    send();
    return true;
  }

  // ── blockmap <stateId> <mod:block> ─────────────────────────────────────────
  if (IS_BLOCK_MAP(lower)) {
    const m = raw.match(/(\d+)\s+(\S+:\S+)/);
    if (!m) { bot.chat('Usage: blockmap <stateId> <mod:block>'); return true; }
    const stateId = parseInt(m[1]);
    const name    = m[2];
    setManualOverride(bot, stateId, name);
    stmtLearn.run('state_id', String(stateId), name, username || null);
    bot.chat(`Mapped stateId ${stateId} → ${name}.`);
    return true;
  }

  // ── entity knowledge: "zombie_merchant is hostile" ─────────────────────────
  if (IS_ENTITY_LEARN(lower)) {
    // Extract entity name from before "is (hostile|not hostile|friendly|passive)"
    const hostileM  = lower.match(/^([a-z_:]+(?:\s+[a-z_]+)*?)\s+is\s+(?:actually\s+)?hostile\b/);
    const passiveM  = lower.match(/^([a-z_:]+(?:\s+[a-z_]+)*?)\s+is\s+(?:actually\s+)?(?:not hostile|friendly|passive|safe)\b/);

    const match     = hostileM || passiveM;
    const isHostile = !!hostileM;

    if (match) {
      const rawName = match[1].trim().replace(/\s+/g, '_');
      // Strip namespace if provided (store bare name for isHostileMob compatibility)
      const name = rawName.replace(/^[a-z_]+:/, '');
      if (name.length > 1) {
        stmtUpsertEntity.run(name, isHostile ? 1 : 0, username || null);
        stmtLearn.run('entity', name, isHostile ? 'hostile' : 'not_hostile', username || null);
        bot.chat(`Got it — ${name} is ${isHostile ? 'hostile' : 'not hostile'}.`);
        return true;
      }
    }
  }

  // ── "what do you know about X" ─────────────────────────────────────────────
  if (IS_KNOW_ABOUT(lower)) {
    // Extract subject after "about" / "sobre" / "tell me about"
    const m = lower.match(/(?:about|sobre|tell me about)\s+([a-z_:]+(?:\s+[a-z_]+)*)/);
    if (m) {
      const rawSubject = m[1].trim().replace(/\s+/g, '_');
      const subject    = rawSubject.replace(/^[a-z_]+:/, '');
      const lines      = [];

      // Check entities table
      const entity = db.prepare('SELECT * FROM entities WHERE name = ?').get(subject);
      if (entity) {
        const src = entity.source === 'player' ? `(taught by ${entity.taught_by || 'player'})` : '(auto)';
        lines.push(`${subject}: ${entity.is_hostile ? 'hostile' : 'not hostile'} ${src}`);
      }

      // Check blocks table
      const block = db.prepare('SELECT * FROM blocks WHERE name = ?').get(subject);
      if (block) {
        const src = block.source === 'player' ? `(taught by ${block.taught_by || 'player'})` : '(auto)';
        lines.push(`${subject}: bounding_box=${block.bounding_box} transparent=${!!block.transparent} ${src}`);
      }

      // Check state_ids
      const sids = db.prepare("SELECT state_id, confidence FROM state_ids WHERE block_name = ?").all(subject);
      if (sids.length) {
        const idList = sids.slice(0, 5).map(r => `${r.state_id}(${r.confidence[0]})`).join(' ');
        const more   = sids.length > 5 ? ` +${sids.length - 5} more` : '';
        lines.push(`${subject}: state IDs ${idList}${more}`);
      }

      if (lines.length) {
        let i = 0;
        const send = () => { if (i >= lines.length) return; bot.chat(lines[i++]); setTimeout(send, 250); };
        send();
      } else {
        bot.chat(`I don't know anything about "${subject}" yet.`);
      }
      return true;
    }
  }

  // ── gaze physics teaching: "this is solid" / "this is passable" ─────────────
  if (/^this\s+is\s+(?:actually\s+)?(?:solid|passable|walkable|not solid)\b/.test(lower)) {
    const { block } = getPlayerGazeTarget(bot);
    if (!block) { bot.chat("I don't see a block there."); return true; }
    const name        = block.name;
    const boundingBox = /solid/.test(lower) && !/not solid|passable|walkable/.test(lower) ? 'block' : 'empty';
    setManualBlockPhysics(bot, name, boundingBox, username);
    stmtLearn.run('block_physics', name, `boundingBox=${boundingBox}`, username || null);
    bot.chat(`Got it — ${name} is ${boundingBox === 'block' ? 'solid' : 'passable'}.`);
    return true;
  }

  // ── block physics teaching: "X is solid" / "X is passable" ──────────────────
  if (IS_BLOCK_PHYSICS(lower)) {
    const solidM    = lower.match(/^([a-z_:]+(?:\s+[a-z_]+)*?)\s+is\s+(?:actually\s+)?solid\b/);
    const passableM = lower.match(/^([a-z_:]+(?:\s+[a-z_]+)*?)\s+is\s+(?:actually\s+)?(?:passable|walkable|not solid)\b/);
    const match     = solidM || passableM;
    if (match) {
      const name        = match[1].trim().replace(/\s+/g, '_').replace(/^[a-z_]+:/, '');
      const boundingBox = solidM ? 'block' : 'empty';
      if (name.length > 1) {
        setManualBlockPhysics(bot, name, boundingBox, username);
        stmtLearn.run('block_physics', name, `boundingBox=${boundingBox}`, username || null);
        bot.chat(`Got it — ${name} is ${solidM ? 'solid' : 'passable'}.`);
        return true;
      }
    }
  }

  // ── conversational block remapping: "pumpkin_stem is stone_bricks" ──────────
  {
    const m = lower.match(IS_BLOCK_ALIAS);
    if (m) {
      const [, source, target] = m;
      const IGNORE = new Set(['this', 'that', 'it', 'nilo', 'he', 'she', 'a', 'the', 'here', 'there',
        'solid', 'passable', 'walkable', 'hostile', 'friendly', 'passive', 'safe', 'transparent', 'opaque']);
      if (!IGNORE.has(source) && !IGNORE.has(target)) {
        const ids = getStateIdsByName(bot, source);
        if (ids.length) {
          for (const id of ids) setManualOverride(bot, id, target);
          stmtLearn.run('block_alias', source, target, username || null);
          bot.chat(`Got it — ${source} (${ids.length} state ID${ids.length > 1 ? 's' : ''}) → ${target}.`);
          return true;
        }
      }
    }
  }

  return false;
}

module.exports = { handle };
