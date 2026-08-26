const Vec3 = require('vec3');
const { goals: { GoalBlock, GoalNear } } = require('../pathfinder-compat');
const state  = require('../state');
const { setBehavior } = require('../behavior');
const { createMovements, startFollow, tryUnstuck } = require('../movement');
const { startAssist } = require('../combat');
const { MASTER, getActiveServerName } = require('../config');
const { cmd } = require('./_util');
const { getPlayerGazeTarget } = require('../gaze');
const db = require('../db');

// ── Location DB helpers ───────────────────────────────────────────────────────
const stmtSaveLoc    = db.prepare('INSERT INTO locations (x, y, z, label, notes) VALUES (?, ?, ?, ?, ?)');
const stmtGetLoc     = db.prepare("SELECT * FROM locations WHERE LOWER(label) = LOWER(?) ORDER BY created_at DESC LIMIT 1");
const stmtListLocs   = db.prepare('SELECT label, x, y, z FROM locations ORDER BY created_at DESC LIMIT 20');
const stmtNearLoc    = db.prepare('SELECT *, ((x-?)*(x-?) + (z-?)*(z-?)) AS dist2 FROM locations ORDER BY dist2 ASC LIMIT 1');
const stmtDeleteLoc  = db.prepare("DELETE FROM locations WHERE LOWER(label) = LOWER(?)");
const stmtCpSave     = db.prepare('INSERT INTO checkpoints (server, dimension, label, x, y, z) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(server, dimension, label) DO UPDATE SET x=excluded.x, y=excluded.y, z=excluded.z, created_at=strftime(\'%s\',\'now\')');
const stmtCpGet      = db.prepare('SELECT x, y, z FROM checkpoints WHERE server=? AND dimension=? AND label=? COLLATE NOCASE');
const stmtCpDel      = db.prepare('DELETE FROM checkpoints WHERE server=? AND dimension=? AND label=? COLLATE NOCASE');
const stmtCpList     = db.prepare('SELECT label, x, y, z FROM checkpoints WHERE server=? AND dimension=? ORDER BY label ASC');

const CP_SET  = /(?:set|save|mark|salvar?|marcar?|definir?)\s+(?:checkpoint|cp|waypoint|ponto|marco)\s+(.+)/;
const CP_TP   = /(?:tp|teleport|teleporta(?:-te)?|vai\s+para?)\s+(?:(?:to\s+)?(?:checkpoint|cp|waypoint|ponto|marco))\s+(.+)/;
const CP_TMP  = /(?:tp\s+me|me\s+(?:tp|teleporta|leva))\s+(?:to\s+)?(?:checkpoint|cp|waypoint|ponto|marco)\s+(.+)/;
const CP_DEL  = /(?:delete|remove|del|apagar?|remover?)\s+(?:checkpoint|cp|waypoint|ponto|marco)\s+(.+)/;
const CP_LIST = /(?:list|show|listar?|mostrar?)\s+(?:checkpoints|waypoints|pontos|marcos|cps?)\b/;

const IS_FOLLOW = cmd([
  /\bfollow\b/,
  /\bme segue\b/, /\bvem comigo\b/, /\bme acompanha\b/, /\bfica comigo\b/,
]);
// Note: bare "help" is NOT here — #help is reserved for the command list (misc.js).
const IS_HELP = cmd([
  /\bassist\b/, /\bprotect me\b/, /\bwatch my back\b/, /\bi need help\b/,
  /\bdefend me\b/, /\bguard me\b/, /\bcover me\b/, /\bfight with me\b/, /\bfight for me\b/,
  /\bme ajuda\b/, /\bme ajude\b/, /\bme protege\b/, /\bpreciso de ajuda\b/, /\bme cobre\b/,
  /\bme defende\b/, /\bme escolta\b/,
]);
const IS_COME = cmd([
  /\bcome here\b/, /\bcome closer\b/, /\bget over here\b/, /\bcome to me\b/, /\bget here\b/,
  /\bvem aqui\b/, /\bvem c[aá]\b/, /\bchega aqui\b/, /\bvem at[eé] mim\b/,
  /\bchega mais\b/, /\bvem mais perto\b/, /\baproxima\b/,
]);
const IS_CLOSER = cmd([
  /\bcloser\b/, /\bkeep closer\b/, /\bstay closer\b/, /\bstick closer\b/, /\bget closer\b/,
  /\bfique mais perto\b/, /\bfica mais perto\b/, /\bmais perto\b/,
]);
const IS_UNSTUCK = cmd([
  /\bunstuck\b/, /\bmove away\b/, /\bget out of the way\b/, /\bget unstuck\b/,
  /\bdestravar\b/, /\bsai do caminho\b/, /\bse mexe\b/, /\bmove-te\b/,
]);
const IS_STOP = cmd([
  /\b(go away|leave me|get away|stop following|shoo|back off|give me space)\b/,
  /\b(vai embora|me deixa|sai daqui|vai fora|sai fora|para de me seguir)\b/,
]);
const IS_STOP_FISH = cmd([
  /\bstop fish(ing)?\b/, /\bstop casting\b/, /\bpara de pescar\b/,
]);
const IS_STOP_TUNNEL = cmd([
  /\bstop (tunneling|digging|mining)\b/, /\bcancel (tunnel|digging|mining)\b/,
  /\bpara de (cavar|tunelar|minar)\b/,
]);
const IS_STAY = cmd([
  /\bstay\b/, /\bstop\b/, /\bwait\b/, /\bhold on\b/, /\bdon'?t move\b/,
  /\bfica aqui\b/, /\bpara\b/, /\bespera\b/, /\bn[aã]o se mexa\b/, /\baguarda\b/,
]);
const IS_SIT    = cmd([/\bsit\b/, /\bsenta\b/]);
const IS_WANDER = cmd([/\bwander\b/, /\bvagabundeia\b/]);
const IS_TP_TO_ME = cmd([
  /\btp (to )?me\b/, /\btp here\b/, /\bteleport (to )?me\b/, /\bcome (here|to me) (now|fast|quick|instantly)\b/,
  /\bvem aqui agora\b/, /\btp para mim\b/, /\bteleporta para mim\b/, /\bse teleporta para mim\b/,
]);
const IS_TP_ME_TO_YOU = cmd([
  /\btp me to you\b/, /\bteleport me to you\b/, /\bring me (to you|here)\b/, /\bpull me (to you|here)\b/,
  /\btp eu para (você|vc)\b/, /\bteleporta eu para (você|vc)\b/, /\bme traz para (você|vc)\b/,
]);
const TP_PLAYER_TO_PLAYER = /\b(?:tp|teleport)\s+(\w+)\s+to\s+(\w+)\b/i;
const IS_STOP_EXPLORE = cmd([
  /\bstop exploring\b/, /\bdon'?t explore\b/, /\bstop wandering\b/, /\bdon'?t wander\b/,
  /\bpara de explorar\b/, /\bn[aã]o explora\b/, /\bfica parado\b/,
]);
const IS_GO_THERE = cmd([
  /\bgo there\b/, /\bwalk there\b/, /\bhead there\b/, /\bgo where i('?m| am) looking\b/,
  /\bvai (para )?(ali|l[aá])\b/, /\bvai onde estou olhando\b/,
]);
const IS_EXPLORE = cmd([
  /\bgo explore\b/, /\bstart exploring\b/, /\bgo wander\b/, /\bexplore\b/,
  /\bvai explorar\b/, /\bcome[cç]a a explorar\b/, /\bexplora\b/,
]);

async function handle(bot, lower, raw, username) {
  if (IS_FOLLOW(lower)) {
    state.exploringEnabled = true;
    startFollow(bot, MASTER, 2);
    bot.chat('On my way.');
    return true;
  }

  if (IS_HELP(lower)) {
    startAssist(bot, MASTER);
    return true;
  }

  if (IS_COME(lower)) {
    setBehavior(bot, 'idle', MASTER);
    state.exploringEnabled = false; // hold position after arriving — user is directing
    const target = bot.players[MASTER]?.entity;
    if (target) {
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      const pos = target.position;
      bot.pathfinder.setGoal(new GoalNear(pos.x, pos.y, pos.z, 2));
    }
    bot.chat('Coming.');
    return true;
  }

  if (IS_GO_THERE(lower)) {
    const { position } = getPlayerGazeTarget(bot);
    if (!position) { bot.chat("I don't see anywhere to go there."); return true; }
    setBehavior(bot, 'idle', MASTER);
    state.exploringEnabled = false; // hold once arrived, same as IS_COME
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalNear(position.x, position.y, position.z, 1));
    bot.chat('On my way there.');
    return true;
  }

  if (IS_CLOSER(lower)) {
    startFollow(bot, MASTER, 1);
    bot.chat('Got it, staying right with you.');
    return true;
  }

  if (IS_UNSTUCK(lower)) {
    bot.chat('Trying to get free...');
    tryUnstuck(bot)
      .then(ok => { if (!ok) bot.chat("Completely stuck. Can you give me a hand?"); })
      .catch(err => console.error('[NILO] Unstuck error:', err.message));
    return true;
  }

  if (IS_STOP(lower)) {
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Backing off.');
    return true;
  }

  // Must be checked before IS_STAY since "stop" matches both
  if (IS_STOP_FISH(lower)) {
    if (state.behaviorMode === 'fishing') {
      setBehavior(bot, 'idle', MASTER);
      bot.deactivateItem();
      bot.chat('Reeling in.');
    }
    return true;
  }

  if (IS_STOP_TUNNEL(lower) || (IS_STAY(lower) && state.behaviorMode === 'tunneling')) {
    if (state.behaviorMode === 'tunneling') {
      setBehavior(bot, 'idle', MASTER);
      bot.chat('Stopping tunnel.');
    }
    return true;
  }

  // Also must be checked before IS_STAY — "stop exploring"/"stop wandering" both
  // contain the bare word "stop", which IS_STAY itself matches. Without this
  // ahead of it, IS_STAY intercepted the phrase first and never actually
  // touched exploringEnabled, so "stop exploring" silently did nothing.
  if (IS_STOP_EXPLORE(lower)) {
    state.exploringEnabled = false;
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Stopping exploration.');
    return true;
  }

  if (IS_SIT(lower)) {
    setBehavior(bot, 'sit', MASTER);
    bot.setControlState('sneak', true);
    bot.chat('Sitting.');
    return true;
  }

  if (IS_STAY(lower)) {
    setBehavior(bot, 'idle', MASTER);
    // Without this, autonomous exploration (monitor.js) kicks in after an
    // 8-16s idle cooldown — behaviorMode 'idle' is exactly what it waits for
    // — and Nilo wanders off looking for containers, same as IS_COME already
    // guards against. "stay" needs to mean stay, not "idle for a while".
    state.exploringEnabled = false;
    bot.chat('Staying here.');
    return true;
  }

  if (IS_WANDER(lower)) {
    setBehavior(bot, 'wander', MASTER);
    bot.chat('Going for a wander.');
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    state.behaviorInterval = setInterval(() => {
      if (state.behaviorMode !== 'wander') return;
      const masterForWander = bot.players[MASTER]?.entity;
      if (!masterForWander || masterForWander.position.distanceTo(bot.entity.position) > 30) return;
      const pos = bot.entity.position;
      const rx  = pos.x + (Math.random() * 20 - 10);
      const rz  = pos.z + (Math.random() * 20 - 10);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(rx), Math.floor(pos.y), Math.floor(rz)));
    }, 5000);
    return true;
  }

  const tpMatch = TP_PLAYER_TO_PLAYER.exec(lower);
  if (tpMatch) {
    if (username !== MASTER) return false;
    const resolve = n => (n === 'me' ? MASTER : n === 'you' ? bot.username : n);
    const from = resolve(tpMatch[1]);
    const to   = resolve(tpMatch[2]);
    bot.chat(`/tp ${from} ${to}`);
    return true;
  }

  if (IS_TP_TO_ME(lower)) {
    if (username !== MASTER) return false;
    // Player-to-player /tp works cross-dimension natively in Minecraft.
    bot.chat(`/tp ${bot.username} ${MASTER}`);
    return true;
  }

  if (IS_TP_ME_TO_YOU(lower)) {
    if (username !== MASTER) return false;
    const p   = bot.entity.position;
    const dim = bot.game.dimension; // e.g. "minecraft:overworld"
    bot.chat(`/execute in ${dim} run tp ${MASTER} ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    return true;
  }

  // "tp <label>" shortcut — looks up checkpoint by name, no keyword needed
  {
    const m = /^(?:tp|teleport|teleporta)\s+(.+)$/.exec(lower);
    if (m) {
      const label = m[1].trim().replace(/^['"]|['"]$/g, '');
      const srv   = getActiveServerName();
      const dim   = bot.game?.dimension ?? 'unknown';
      const row   = stmtCpGet.get(srv, dim, label);
      if (row) {
        bot.chat(`/tp ${bot.username} ${row.x} ${row.y} ${row.z}`);
        return true;
      }
      // not a checkpoint — fall through to Letta
    }
  }

  if (IS_EXPLORE(lower)) {
    state.exploringEnabled = true;
    setBehavior(bot, 'idle', MASTER);
    bot.chat('Going exploring.');
    return true;
  }

  // Look at me
  if (/\b(look at me|look here|olha pra mim|me olha|olha aqui|olha pra c[aá])\b/.test(lower)) {
    const target = bot.players[MASTER]?.entity;
    if (target) await bot.lookAt(target.position.offset(0, target.height, 0));
    return true;
  }

  // Press/activate what MASTER is looking at — "press button", "press this", "push lever"
  if (/\b(press|push|click|activate|aperta|empurra)\b/.test(lower)
   && /\b(button|lever|switch|plate|it|this|that|bot[aã]o|alavanca)\b/.test(lower)
   && !/\d.*\d.*\d/.test(lower)) {  // no three numbers → not the coordinate-based handler
    const { block } = getPlayerGazeTarget(bot, 8);
    if (!block?.position) { bot.chat("I don't see anything to press."); return true; }
    const p = block.position;
    const movements = createMovements(bot);
    bot.pathfinder.setMovements(movements);
    try {
      await bot.pathfinder.goto(new GoalNear(p.x, p.y, p.z, 3));
      await bot.lookAt(p.offset(0.5, 0.5, 0.5), true);
      await bot.activateBlock(bot.blockAt(p));
      bot.chat('Done.');
    } catch (err) {
      console.error('[NILO] Press gaze target error:', err.message);
      bot.chat("Couldn't press that.");
    }
    return true;
  }

  // Click/activate block at coordinates — "click button at 100 64 200"
  {
    const m = lower.match(/(?:click|press|push|activate|use|aperta|clica|ativa|usa)\b.*?(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
    if (m) {
      const [bx, by, bz] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])];
      const block = bot.blockAt(new Vec3(bx, by, bz));
      if (!block || block.name === 'air') {
        bot.chat(`Nothing at ${bx} ${by} ${bz}.`);
      } else {
        const movements = createMovements(bot);
        bot.pathfinder.setMovements(movements);
        try {
          await bot.pathfinder.goto(new GoalNear(bx, by, bz, 3));
          await bot.lookAt(new Vec3(bx + 0.5, by + 0.5, bz + 0.5), true);
          await bot.activateBlock(block);
          bot.chat('Done.');
        } catch (err) {
          bot.chat("Couldn't reach that.");
          console.error('[NILO] ActivateBlock error:', err.message);
        }
      }
      return true;
    }
  }

  // ── Location index ────────────────────────────────────────────────────────
  // "remember this as X" / "lembra isso como X" / "save this place as X"
  {
    const m = lower.match(/(?:remember|lembra|save|mark)\s+(?:this|isso|this place|esse lugar)?\s*(?:as|como)\s+(.+)/);
    if (m) {
      const label = m[1].trim().replace(/['"]/g, '');
      const p = bot.entity.position;
      stmtSaveLoc.run(Math.round(p.x), Math.round(p.y), Math.round(p.z), label, null);
      bot.chat(`Saved location "${label}" at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}.`);
      return true;
    }
  }

  // "where is X?" / "where's X?"
  {
    const m = lower.match(/where(?:'s| is)\s+(.+?)(?:\?|$)/);
    if (m) {
      const label = m[1].trim();
      const row = stmtGetLoc.get(label);
      if (!row) { bot.chat(`I don't know where "${label}" is.`); }
      else {
        const dist = Math.round(Math.hypot(row.x - bot.entity.position.x, row.z - bot.entity.position.z));
        bot.chat(`"${row.label}" is at ${row.x}, ${row.y}, ${row.z} (~${dist}m away).`);
      }
      return true;
    }
  }

  // "go to X" / "take me to X" / "navigate to X"
  {
    const m = lower.match(/(?:go to|take me to|navigate to|vai para|vai at[eé]|leva(?:-me)? at[eé])\s+(.+)/);
    if (m) {
      const label = m[1].trim();
      const row = stmtGetLoc.get(label);
      if (!row) { bot.chat(`I don't know where "${label}" is.`); return true; }
      setBehavior(bot, 'idle', MASTER);
      const movements = createMovements(bot);
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new GoalNear(row.x, row.y, row.z, 2));
      bot.chat(`Heading to "${label}" (${row.x}, ${row.y}, ${row.z}).`);
      return true;
    }
  }

  // "list locations" / "what places do you know?"
  if (/(?:list (?:locations|places|saved)|what places|where have you been|lugares que conheces)/.test(lower)) {
    const rows = stmtListLocs.all();
    if (!rows.length) { bot.chat('No saved locations yet.'); }
    else { bot.chat('Known: ' + rows.map(r => `${r.label}(${r.x},${r.z})`).join(', ')); }
    return true;
  }

  // "nearest saved location"
  if (/nearest (?:saved )?(?:location|place|spot)/.test(lower)) {
    const p = bot.entity.position;
    const row = stmtNearLoc.get(p.x, p.x, p.z, p.z);
    if (!row) { bot.chat('No saved locations.'); }
    else {
      const dist = Math.round(Math.sqrt(row.dist2));
      bot.chat(`Nearest: "${row.label}" at ${row.x}, ${row.y}, ${row.z} (~${dist}m away).`);
    }
    return true;
  }

  // ── Checkpoints ──────────────────────────────────────────────────────────────

  {
    const m = CP_SET.exec(lower);
    if (m) {
      const label = m[1].trim().replace(/^['"]|['"]$/g, '');
      const p     = bot.entity.position;
      const srv   = getActiveServerName();
      const dim   = bot.game?.dimension ?? 'unknown';
      stmtCpSave.run(srv, dim, label, Math.round(p.x), Math.round(p.y), Math.round(p.z));
      bot.chat(`Checkpoint "${label}" saved at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}.`);
      return true;
    }
  }

  // "tp me to checkpoint X" — teleport player to checkpoint
  {
    const m = CP_TMP.exec(lower);
    if (m) {
      if (username !== MASTER) return false;
      const label = m[1].trim().replace(/^['"]|['"]$/g, '');
      const srv   = getActiveServerName();
      const dim   = bot.game?.dimension ?? 'unknown';
      const row   = stmtCpGet.get(srv, dim, label);
      if (!row) { bot.chat(`No checkpoint "${label}" on ${srv}/${dim}.`); return true; }
      bot.chat(`/tp ${MASTER} ${row.x} ${row.y} ${row.z}`);
      return true;
    }
  }

  // "tp checkpoint X" — teleport Nilo to checkpoint
  {
    const m = CP_TP.exec(lower);
    if (m) {
      const label = m[1].trim().replace(/^['"]|['"]$/g, '');
      const srv   = getActiveServerName();
      const dim   = bot.game?.dimension ?? 'unknown';
      const row   = stmtCpGet.get(srv, dim, label);
      if (!row) { bot.chat(`No checkpoint "${label}" on ${srv}/${dim}.`); return true; }
      bot.chat(`/tp ${bot.username} ${row.x} ${row.y} ${row.z}`);
      return true;
    }
  }

  // "delete checkpoint X"
  {
    const m = CP_DEL.exec(lower);
    if (m) {
      if (username !== MASTER) return false;
      const label = m[1].trim().replace(/^['"]|['"]$/g, '');
      const srv   = getActiveServerName();
      const dim   = bot.game?.dimension ?? 'unknown';
      const info  = stmtCpDel.run(srv, dim, label);
      bot.chat(info.changes > 0 ? `Checkpoint "${label}" deleted.` : `No checkpoint "${label}" on ${srv}/${dim}.`);
      return true;
    }
  }

  // "list checkpoints"
  if (CP_LIST.test(lower)) {
    const srv  = getActiveServerName();
    const dim  = bot.game?.dimension ?? 'unknown';
    const rows = stmtCpList.all(srv, dim);
    if (!rows.length) { bot.chat(`No checkpoints on ${srv}/${dim}.`); }
    else { bot.chat(`[${srv}/${dim.split(':')[1]}] ` + rows.map(r => `${r.label}(${r.x},${r.y},${r.z})`).join(', ')); }
    return true;
  }

  return false;
}

module.exports = { handle };
