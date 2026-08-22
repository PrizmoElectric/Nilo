// clones.js — spawns lightweight "clone" bot instances of Nilo.
//
// Each clone is a SEPARATE Minecraft connection (its own offline-mode
// username — the server is cracked, so any name works). Clones are
// deliberately minimal: no Letta, no Discord, no viewers, no HUD API —
// running 20 of those in one process would be far too heavy. A clone only
// connects, survives the modded-server handshake, and continuously mirrors
// the shared Freyr toggle (state.freyrCloneToggle): summon its sword when
// "freyr on", return it to inventory when "freyr off".
//
// Each clone needs a Freyr Sword already in its inventory (user supplies —
// see agent/CHECKLIST.txt "Clone army" section for the manual-supply step).

const http          = require('http');
const mineflayer    = require('mineflayer');
const { pathfinder, goals: { GoalNear } } = require('./pathfinder-compat');
const armorManager  = require('mineflayer-armor-manager');

const { installLoginHandshake } = require('./registry-patch');
const { installEasyAuth } = require('./easyauth');
const { buildOpenableIds, createMovements, installDoorOpener, applyServerBlockOverrides } = require('./movement');
const { installFreyrListeners, findFreyrEntity, summonFreyr, returnFreyr, hasFreyrItem } = require('./freyr');
const { isHostileMob, equipBestMeleeWeapon } = require('./combat');
const { getServerConfig, BOT_USERNAME } = require('./config');
const { pushModeToSolsai } = require('./api');
const state = require('./state');

// Solsai HTTP API (server-side Fabric mod) — gives us instant, server-authoritative
// inventory queries and transfers between players, no physical toss/walk/pickup needed.
const SOLSAI_HOST = process.env.CONTEXT_MOD_HOST || '127.0.0.1';
const SOLSAI_PORT = parseInt(process.env.CONTEXT_MOD_PORT || '8080', 10);
function solsaiGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: SOLSAI_HOST, port: SOLSAI_PORT, path }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('Bad JSON from Solsai: ' + buf.slice(0, 80))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Solsai timeout')); });
  });
}

// Path to Nilo's real skin PNG as seen by the Minecraft server process inside
// its container (volume-mounted ./data -> /data). FabricTailor's
// "/skin set upload <variant> <path>" reads this file directly off the
// server's disk — see the comment at the call site for why URL-based methods
// don't work on a LAN-only bridge.
const NILO_SKIN_SERVER_PATH = '/data/SerialDesignation_N-V2.png';

const FREYR_POLL_MS    = 4000; // how often each clone checks the shared Freyr toggle
const BEHAVIOR_TICK_MS = 800;  // how often each clone re-evaluates follow/fight
const SPAWN_STAGGER_MS = 2500; // delay between successive clone connections — avoid hammering the server
const MELEE_RANGE      = 3;
const COMBAT_SCAN_RANGE = 16;
const MAX_CLONES       = 20;
const FORMATION_RADIUS = 6;   // ring radius (blocks) where idle clones take up position around Nilo
const PERSONAL_SPACE   = 1.6; // min comfortable distance between two clones before one steps aside
const TELEPORT_SCATTER_MIN = 2;  // blocks from Nilo when teleporting a clone in
const TELEPORT_SCATTER_MAX = 6;
const MAX_DIST_FROM_NILO   = 50; // clones get yanked back to Nilo's side past this
const ITEM_PICKUP_RANGE    = 6;  // dropped-item detection radius for clone auto-pickup
const DISTRIBUTE_POLL_MS = 15000; // how often Nilo checks for spares (Freyr Swords, food) to hand out
const MODE_PUSH_POLL_MS  = 2000;  // how often each clone's behavior mode is pushed to Solsai for the HUD

const FOOD_ITEM_ID   = 'minecraft:bread';
const FOOD_MIN_COUNT = 10; // clones get topped up once they fall to/below this
const FOOD_KEEP_BACK = 10; // Nilo always keeps at least this much bread for himself
const FOOD_TOPUP_TO  = 16; // target bread count per clone after a top-up

const clones = new Map(); // index (1-20) -> bot

function cloneUsername(index) {
  // Minecraft usernames cap at 16 chars — "NILO_CLONE20" is 12, safe.
  return `${BOT_USERNAME}_CLONE${index}`;
}

function spawnClone(index) {
  if (clones.has(index)) return clones.get(index);

  const { host, port, version, auth } = getServerConfig();
  const username = cloneUsername(index);
  // Used to compute this clone's stable formation slot (see startCloneBehavior)
  // — keeps each clone in its own spot in the ring around Nilo instead of
  // every clone converging on the same GoalFollow point and stacking up.
  const formationAngle = ((index - 1) / MAX_CLONES) * Math.PI * 2;
  const bot = mineflayer.createBot({
    host, port, username, version, auth: auth || 'offline',
    // CRITICAL: without this, protodef's FullPacketParser does
    // `console.log(e.stack)` for EVERY PartialReadError — and a fresh player
    // joining this heavily-modded server triggers thousands of those per
    // second while the giant declare_recipes/declare_commands/chunk packets
    // stream in (verified: ~100K-380K log lines/30s, journald rate-limited
    // them all to "Suppressed N messages", which is what showed up as the
    // mysterious "[48K blob data]" entries). hideErrors -> noErrorLogging
    // on the deserializer, killing the flood. Our own bot.on('error', ...)
    // below still logs concise messages, so nothing is lost.
    hideErrors: true,
  });
  bot._formationAngle = formationAngle;
  // Pushed to Solsai's /bot-mode by the shared interval below — lets
  // prizmo-system's HUD mode-color ESP boxes work for clones too, not just NILO.
  bot._mode = 'idle';

  bot.loadPlugin(pathfinder);
  bot.loadPlugin(armorManager);

  installLoginHandshake(bot);
  // CRITICAL — without this, EasyAuth freezes/blinds the account until it
  // /register's and /login's: the clone connects and "spawns" but literally
  // cannot move, see entities, or be /tp'd anywhere — which looks exactly
  // like "fails to follow Nilo". Each clone is its own account/username so
  // each must register itself; same shared password as Nilo (NILO_PASSWORD
  // env var / 'nilo123' default) is fine — these are throwaway bot accounts.
  installEasyAuth(bot);

  bot.once('login', () => {
    console.log(`[CLONE] ${username} connected to ${host}:${port}.`);
  });

  let freyrTimer    = null;
  let behaviorTimer = null;
  // NOTE: deliberately NOT using bot.once('spawn', ...) here — on this server,
  // fresh player connections never receive an `update_health` packet (verified
  // live with scripts/test-clone-spawn.js: bot.health stayed `undefined` and
  // 'spawn' never fired even 60s after joining), so mineflayer's health-based
  // 'spawn' detection (lib/plugins/health.js) never emits for clones. Likely
  // a side effect of this heavily-modded server's huge declare_recipes/
  // declare_commands payloads desyncing the packet stream for new players —
  // it does NOT happen for Nilo's account (existing player data). 'forcedMove'
  // (the initial position/teleport-confirm packet, which DOES always arrive
  // and is what actually populates bot.entity) is the reliable readiness
  // signal here — fires once on join, then again on every later forced
  // teleport (e.g. our own /tp), so .once() captures only the initial spawn.
  bot.once('forcedMove', () => {
    installFreyrListeners(bot);
    bot.pathfinder.thinkingTimeout = 5000;
    // Without these, pathfinder uses generic vanilla Movements on this
    // heavily-modded terrain — it misclassifies modded fences/walls as
    // impassable and can't open most doors (Fabric's door executor is known
    // broken), so clones get stuck mid-path and "fail to follow". These are
    // the exact same one-time, synchronous setup calls Nilo makes at spawn —
    // cheap (registry scan + a physicsTick listener), safe to run ×20.
    applyServerBlockOverrides(bot);
    bot._openableIds = buildOpenableIds(bot);
    bot.pathfinder.setMovements(createMovements(bot));
    installDoorOpener(bot);
    teleportNearMaster(bot);
    // "/skin set NILO" only copies whatever skin the NILO *account* currently
    // has server-side (the default Steve — Nilo's look is a viewer-only
    // cosmetic swap, not a real FabricTailor skin). "/skin set <url>" also
    // doesn't work here: FabricTailor hands the URL to mineskin.org, which
    // then has to fetch it itself — and 192.168.1.100 is a private LAN IP
    // mineskin.org's servers can't reach (confirmed: command ran with no
    // error but never actually changed the skin). FabricTailor's
    // "/skin set upload <classic|slim> <local file path>" instead reads the
    // file straight off the SERVER's disk and uploads its bytes directly —
    // verified working live with the file already sitting at
    // /data/SerialDesignation_N-V2.png inside the server container (the same
    // PNG Nilo's viewer cosmetic uses). Run by the clone itself — skin
    // commands always target the sender, so rcon/console can't do this for it.
    bot.chat(`/skin set upload slim ${NILO_SKIN_SERVER_PATH}`);
    freyrTimer    = setInterval(() => tickFreyr(bot).catch(() => {}), FREYR_POLL_MS);
    behaviorTimer = startCloneBehavior(bot);
  });

  bot.on('kicked', (reason) => console.warn(`[CLONE] ${username} kicked: ${reason}`));
  bot.on('error',  (err)    => console.warn(`[CLONE] ${username} error: ${err.message}`));
  bot.on('end',    () => {
    if (freyrTimer)    clearInterval(freyrTimer);
    if (behaviorTimer) clearInterval(behaviorTimer);
    clones.delete(index);
    console.log(`[CLONE] ${username} disconnected.`);
  });

  clones.set(index, bot);
  return bot;
}

// Teleports a clone to a scattered point near Nilo's current position. Uses
// Nilo's own connection to issue the /tp — Nilo is OP'd (level 4) on this
// server, clones are not, so they can't /tp themselves.
//
// Retracts a summoned Freyr Sword first — teleporting with it out leaves the
// sword entity stranded at the old position — then re-summons it afterwards
// so the warp is only a brief, invisible blip rather than a lasting change.
async function teleportNearMaster(bot) {
  const nilo = state.activeBotRef;
  if (!nilo?.entity) return;

  const wasOut = !!findFreyrEntity(bot);
  if (wasOut) {
    try { await returnFreyr(bot); } catch (_) {}
    await new Promise(r => setTimeout(r, 800)); // give the recall a moment to land before warping
  }

  const p = nilo.entity.position;
  const angle = Math.random() * Math.PI * 2;
  const r     = TELEPORT_SCATTER_MIN + Math.random() * (TELEPORT_SCATTER_MAX - TELEPORT_SCATTER_MIN);
  const x = (p.x + Math.cos(angle) * r).toFixed(2);
  const z = (p.z + Math.sin(angle) * r).toFixed(2);
  nilo.chat(`/tp ${bot.username} ${x} ${p.y.toFixed(2)} ${z}`);

  if (wasOut && state.freyrCloneToggle && hasFreyrItem(bot)) {
    setTimeout(() => { summonFreyr(bot).catch(() => {}); }, 1000);
  }
}

// "Operational" baseline behavior — mirrors what Nilo does on his own:
// fight nearby hostiles, otherwise follow NILO around (Nilo is the clones'
// master — he in turn follows the true master, PrizmoElectric — so the
// army naturally trails behind both in a chain). Deliberately self-contained
// (own cooldowns, no shared `state.behaviorMode`/combat.js `_cd` cache) so
// 20 clones running this concurrently never clobber Nilo's or each other's
// combat/follow state.
//
// Safety net: if a clone ever ends up more than MAX_DIST_FROM_NILO blocks
// from Nilo (got lost, fell down a ravine, pathfinder gave up, etc.), Nilo
// /tp's it back to his side rather than letting it wander off forever.
function startCloneBehavior(bot) {
  const cd = {};
  const hasCd = (name, ms) => Date.now() - (cd[name] || 0) < ms;
  const setCd = (name) => { cd[name] = Date.now(); };

  const timer = setInterval(async () => {
    if (!bot.entity) return;

    const nilo = bot.players[BOT_USERNAME]?.entity;
    if (nilo) {
      const niloDist = bot.entity.position.distanceTo(nilo.position);
      if (niloDist > MAX_DIST_FROM_NILO && !hasCd('rescue', 10000)) {
        bot._mode = 'follow';
        setCd('rescue');
        await teleportNearMaster(bot);
        return;
      }
    }

    const target = bot.nearestEntity(e =>
      isHostileMob(e) && e.position.distanceTo(bot.entity.position) < COMBAT_SCAN_RANGE
    );

    if (target) {
      bot._mode = 'attack';
      const dist = target.position.distanceTo(bot.entity.position);
      if (dist <= MELEE_RANGE) {
        if (!hasCd('melee', 600)) {
          setCd('melee');
          equipBestMeleeWeapon(bot);
          try {
            await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.9, 0), true);
            bot.attack(target);
          } catch (_) {}
        }
      } else if (!hasCd('chase', 400)) {
        setCd('chase');
        bot.pathfinder.setGoal(new GoalNear(target.position.x, target.position.y, target.position.z, 2), true);
      }
      return;
    }

    // Mirrors Nilo's inventory-management baseline: walk over nearby dropped
    // items so the server's vanilla pickup-on-contact does the rest (no
    // explicit "collect" packet needed). Short range + cooldown keeps this
    // cheap and stops clones from wandering off the follow path chasing loot
    // across the map.
    const droppedItem = bot.nearestEntity(e =>
      e.name === 'item' && e.position.distanceTo(bot.entity.position) < ITEM_PICKUP_RANGE
    );
    if (droppedItem && !hasCd('pickup', 3000)) {
      bot._mode = 'follow';
      setCd('pickup');
      bot.pathfinder.setGoal(new GoalNear(droppedItem.position.x, droppedItem.position.y, droppedItem.position.z, 1), true);
      return;
    }

    if (!nilo) return;

    // Personal space: if another clone is crowding us, step away from it
    // rather than letting both pathfinders converge on the same point and
    // stack on top of each other. Cheap O(n) scan over the shared `clones`
    // map (n <= 20) — every clone runs this independently with no shared
    // mutable state, so they can never clobber each other's decision.
    let nearestClone = null, nearestCloneDist = Infinity;
    for (const other of clones.values()) {
      if (other === bot || !other.entity) continue;
      const d = bot.entity.position.distanceTo(other.entity.position);
      if (d < nearestCloneDist) { nearestCloneDist = d; nearestClone = other; }
    }
    if (nearestClone && nearestCloneDist < PERSONAL_SPACE && !hasCd('space', 1500)) {
      bot._mode = 'follow';
      setCd('space');
      let dx = bot.entity.position.x - nearestClone.entity.position.x;
      let dz = bot.entity.position.z - nearestClone.entity.position.z;
      const mag = Math.sqrt(dx * dx + dz * dz) || 1;
      dx /= mag; dz /= mag;
      const tx = bot.entity.position.x + dx * 2.5;
      const tz = bot.entity.position.z + dz * 2.5;
      bot.pathfinder.setGoal(new GoalNear(tx, bot.entity.position.y, tz, 1));
      return;
    }

    // Formation: each clone holds a stable angular slot in a ring around
    // Nilo (its army index maps to a fixed angle, set once at spawn time —
    // see _formationAngle) instead of every clone running GoalFollow toward
    // the same point. This is what was causing them to converge and stack
    // "inside each other" when idle — now they spread out in unison and
    // naturally rotate around Nilo as he moves.
    const fx = nilo.position.x + Math.cos(bot._formationAngle) * FORMATION_RADIUS;
    const fz = nilo.position.z + Math.sin(bot._formationAngle) * FORMATION_RADIUS;
    const dx = bot.entity.position.x - fx;
    const dz = bot.entity.position.z - fz;
    const distToSlot = Math.sqrt(dx * dx + dz * dz);
    if (distToSlot > 2) {
      bot._mode = 'follow';
      bot.pathfinder.setGoal(new GoalNear(fx, nilo.position.y, fz, 1.5), true);
    } else {
      bot._mode = 'idle';
      bot.pathfinder.setGoal(null);
    }
  }, BEHAVIOR_TICK_MS);

  return timer;
}

// Mirrors the shared Freyr toggle: summon if "on" and not already out,
// return if "off" and currently out. Both summonFreyr/findFreyrEntity already
// guard against redundant actions once the UUID has synced.
async function tickFreyr(bot) {
  if (!bot.entity) return;
  const out = !!findFreyrEntity(bot);
  if (state.freyrCloneToggle) {
    if (!out && hasFreyrItem(bot)) await summonFreyr(bot);
  } else if (out) {
    await returnFreyr(bot);
  }
}

// Distribution system: if Nilo is carrying spare Freyr Swords (more than the
// one he keeps for himself), hand one to a clone that doesn't currently have
// one — neither in inventory nor summoned. Uses Solsai's /item-transfer for an
// instant, server-authoritative inventory-to-inventory move (no physical toss/
// walk/pickup, so nothing can be lost or stolen by mobs en route). One hand-out
// per poll keeps it gentle on the server and easy to reason about.
async function distributeFreyrSwords() {
  const nilo = state.activeBotRef;
  if (!nilo?.entity) return;

  let inv;
  try { inv = await solsaiGet('/bot-inventory?player=' + BOT_USERNAME); }
  catch (_) { return; }

  const swords = (inv.inventory ?? []).filter(i => i.id.includes('freyr_sword'));
  const total  = swords.reduce((sum, i) => sum + i.count, 0);
  if (total <= 1) return; // keep at least one for himself

  for (const [, clone] of clones) {
    if (!clone.entity) continue;
    if (hasFreyrItem(clone) || findFreyrEntity(clone)) continue;

    try {
      await solsaiGet(`/item-transfer?from=${BOT_USERNAME}&to=${clone.username}&slot=${swords[0].slot}&count=1`);
    } catch (_) {}
    return; // one distribution per poll — let the next poll handle the rest
  }
}

// Food distribution: if Nilo is carrying more bread than he needs to keep for
// himself, top up any clone whose bread count has fallen to/below FOOD_MIN_COUNT
// back up toward FOOD_TOPUP_TO, via the same instant Solsai /item-transfer.
// One clone topped up per poll — same gentle, easy-to-reason-about cadence as
// the Freyr distribution.
async function distributeFood() {
  const nilo = state.activeBotRef;
  if (!nilo?.entity) return;

  let inv;
  try { inv = await solsaiGet('/bot-inventory?player=' + BOT_USERNAME); }
  catch (_) { return; }

  const bread = (inv.inventory ?? []).find(i => i.id === FOOD_ITEM_ID);
  if (!bread || bread.count <= FOOD_KEEP_BACK) return;

  const spare = bread.count - FOOD_KEEP_BACK;

  for (const [, clone] of clones) {
    if (!clone.entity) continue;
    const have = clone.inventory.items()
      .filter(i => i.name === 'bread')
      .reduce((sum, i) => sum + i.count, 0);
    if (have > FOOD_MIN_COUNT) continue;

    const give = Math.min(FOOD_TOPUP_TO - have, spare);
    if (give <= 0) continue;

    try {
      await solsaiGet(`/item-transfer?from=${BOT_USERNAME}&to=${clone.username}&slot=${bread.slot}&count=${give}`);
    } catch (_) {}
    return; // one top-up per poll
  }
}

// Spawns clones 1..count that aren't already connected, staggered to avoid
// the server rate-limiting/rejecting a burst of simultaneous logins.
function spawnClones(count) {
  const toSpawn = [];
  for (let i = 1; i <= count; i++) {
    if (!clones.has(i)) toSpawn.push(i);
  }
  toSpawn.forEach((i, idx) => setTimeout(() => spawnClone(i), idx * SPAWN_STAGGER_MS));
  return toSpawn;
}

// Shared teardown for disbanding clones: retract any summoned Freyr Swords
// before disconnecting (quitting with the sword still out would strand its
// entity in the world with no owner around to call it back), give the server
// a moment to process the recall, then quit. Used by both full and partial
// army disbanding.
async function disbandClones(bots) {
  await Promise.all(bots.map(async (bot) => {
    if (!bot.entity || !findFreyrEntity(bot)) return;
    try { await returnFreyr(bot); } catch (_) {}
  }));
  await new Promise(r => setTimeout(r, 1500)); // give the server a moment to process the recall

  for (const bot of bots) {
    try { bot.quit(); } catch (_) {}
  }
}

async function despawnAllClones() {
  const n = clones.size;
  const bots = [...clones.values()];
  await disbandClones(bots);
  clones.clear();
  return n;
}

// Shrinks the army down to `target` clones by disbanding the highest-indexed
// ones first — keeps the low-numbered "core" roster intact, which matches how
// you'd naturally expect "clone 3" to scale a 6-clone army down to 3 (drop
// clones 4-6, not an arbitrary subset).
async function despawnClones(target) {
  const toRemove = [...clones.keys()].filter(i => i > target).sort((a, b) => b - a);
  const bots = toRemove.map(i => clones.get(i));
  await disbandClones(bots);
  for (const i of toRemove) clones.delete(i);
  return toRemove.length;
}

// Cheap to leave running even with no clones connected — both functions bail
// immediately if Nilo isn't spawned or has no spares, and clones.size is a
// trivial check.
setInterval(() => {
  if (clones.size === 0) return;
  distributeFreyrSwords().catch(() => {});
  distributeFood().catch(() => {});
}, DISTRIBUTE_POLL_MS);

// Pushes each clone's current behavior mode (set throughout startCloneBehavior's
// tick — 'attack'/'follow'/'idle') to Solsai's /bot-mode, the same way api.js
// does for Nilo. This is what makes prizmo-system's HUD (mode-colored ESP boxes,
// inventory peek via /bot-inventory) work for the clone army too — previously
// every clone showed up as the 'idle' default since nothing pushed their mode.
setInterval(() => {
  for (const bot of clones.values()) {
    if (bot.entity) pushModeToSolsai(bot.username, bot._mode || 'idle');
  }
}, MODE_PUSH_POLL_MS);

module.exports = { spawnClone, spawnClones, despawnAllClones, despawnClones, clones, cloneUsername };
