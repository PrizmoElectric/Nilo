// commands/freyr.js — natural language control of Freyr Sword companion
const { cmd } = require('./_util');
const { goals: { GoalNear } } = require('../pathfinder-compat');
const freyr = require('../freyr');
const { clones } = require('../clones');
const { getModdedEntityName } = require('../registry-patch');
const { MASTER } = require('../config');

const STRAY_COLLECT_RANGE = 48; // only chase strays within this distance — don't wander off across the map

const IS_FREYR_SCAN = cmd([
  /\bfreyr\b.{0,20}\b(scan|debug|detect|find|search|look)\b/,
  /\b(scan|debug|detect)\b.{0,20}\bfreyr\b/,
]);
const IS_FREYR_SUMMON = cmd([
  /\b(summon|call out|deploy|draw|use|activate)\b.{0,20}\bfreyr\b/,
  /\bfreyr\b.{0,20}\b(out|summon|go|come out|activate)\b/,
  /^freyr$/,
]);
const IS_FREYR_RETURN = cmd([
  /\b(return|recall|call back|retrieve|dismiss|put away)\b.{0,20}\bfreyr\b/,
  /\bfreyr\b.{0,20}\b(return|back|come back|recall|dismiss)\b/,
]);
const IS_FREYR_HOLD = cmd([
  /\bfreyr\b.{0,20}\b(hold|stay|stationary|guard|wait|stop|freeze)\b/,
  /\b(hold|stationary|freeze)\b.{0,20}\bfreyr\b/,
]);
const IS_FREYR_FOLLOW = cmd([
  /\bfreyr\b.{0,20}\b(follow|come|attack|fight|move)\b/,
  /\bfreyr follow\b/,
]);
const IS_FREYR_STATUS = cmd([
  /\bfreyr\b.{0,20}\b(status|where|info|check)\b/,
  /\bwhere.{0,10}\bfreyr\b/,
]);
const IS_FREYR_COLLECT = cmd([
  /\bcollectfreyr\b/,
  /\b(collect|gather|grab|pick up|recover|reclaim)\b.{0,20}\bfreyrs?\b/,
  /\bfreyrs?\b.{0,20}\b(collect|gather|recover|reclaim)\b/,
]);

// Stray Freyr Swords are companion entities a clone left behind by dying or
// disconnecting without retracting it first (see freyr.retractBeforeDisconnect).
// The mod lets ANY player reclaim an ownerless one with a simple right-click
// interaction (FreyrSwordEntity.interactMob inserts the stack into the
// interacting player's inventory and removes the entity) — the owner
// reference clears itself ~3s (60 ticks) after the original owner goes
// offline, so by the time something is flagged "stray" it's free to grab.
// We walk up to each one in turn and bot.activateEntity() it (right-click).
async function collectStraySwords(bot) {
  const onlineCloneUUIDs = [...clones.values()].map(c => freyr.getFreyrUUID(c));
  const strays = freyr.findStraySwords(bot, onlineCloneUUIDs)
    .filter(e => e.position.distanceTo(bot.entity.position) <= STRAY_COLLECT_RANGE);

  if (!strays.length) {
    bot.chat('No stray Freyr Swords nearby.');
    return;
  }

  bot.chat(`Found ${strays.length} stray Freyr Sword(s) — going to collect ${strays.length === 1 ? 'it' : 'them'}.`);

  let collected = 0;
  for (const e of strays) {
    if (!bot.entities[e.id]) continue; // gone since the scan (picked up, despawned, etc.)
    try {
      await bot.pathfinder.goto(new GoalNear(e.position.x, e.position.y, e.position.z, 1.5));
      if (!bot.entities[e.id]) continue;
      await bot.activateEntity(bot.entities[e.id]);
      collected++;
    } catch (_) {}
  }

  bot.chat(collected
    ? `Collected ${collected} stray Freyr Sword${collected === 1 ? '' : 's'}.`
    : "Couldn't reach any of them.");
}

async function handle(bot, lower, raw, username) {
  if (!lower.includes('freyr')) return false;
  if (username !== MASTER) return false;

  if (IS_FREYR_SCAN(lower)) {
    const nearby = Object.values(bot.entities).filter(e =>
      e !== bot.entity && e.position && e.position.distanceTo(bot.entity.position) < 32
    );

    console.log(`[FREYR SCAN] ${nearby.length} entities within 32 blocks:`);
    for (const e of nearby) {
      const dist     = Math.round(e.position.distanceTo(bot.entity.position));
      const meta     = e.metadata ? e.metadata.length : 'n/a';
      const resolved = e.entityType != null ? (getModdedEntityName(e.entityType) ?? '') : '';
      console.log(
        `  id=${e.id} entityType=${e.entityType} category=${e.type}` +
        ` name=${JSON.stringify(e.name)} resolved=${resolved || '(none)'}` +
        ` uuid=${e.uuid} kind=${e.kind} mobType=${e.mobType} meta=${meta} dist=${dist}`
      );
    }

    // Chat summary: group by whether name or resolved entity type is known
    const named   = nearby.filter(e => e.type !== 'player' && (
      (e.name && e.name !== 'unknown') ||
      (e.entityType != null && getModdedEntityName(e.entityType))
    ));
    const unknown = nearby.filter(e => e.type !== 'player' && !(
      (e.name && e.name !== 'unknown') ||
      (e.entityType != null && getModdedEntityName(e.entityType))
    ));
    const players = nearby.filter(e => e.type === 'player');

    const parts = [];
    if (players.length)  parts.push(`${players.length} player(s)`);
    if (named.length)    parts.push(`${named.length} known: ${[...new Set(named.map(e => e.name && e.name !== 'unknown' ? e.name : getModdedEntityName(e.entityType)))].slice(0,5).join(', ')}`);
    if (unknown.length)  parts.push(`${unknown.length} unknown entity(s) [entityType: ${unknown.map(e => e.entityType).join(',')}] — see logs`);

    bot.chat(parts.length ? `Nearby: ${parts.join(' | ')}` : 'Nothing nearby.');
    bot.chat(`Freyr UUID synced: ${freyr.getFreyrUUID(bot) ?? 'none yet'}`);
    return true;
  }

  if (IS_FREYR_STATUS(lower)) {
    bot.chat(freyr.freyrStatus(bot));
    return true;
  }
  if (IS_FREYR_COLLECT(lower)) {
    collectStraySwords(bot).catch(() => {});
    return true;
  }
  if (IS_FREYR_RETURN(lower)) {
    const r = await freyr.returnFreyr(bot);
    bot.chat(r.msg);
    return true;
  }
  if (IS_FREYR_HOLD(lower)) {
    const r = await freyr.setFreyrStationary(bot, true);
    bot.chat(r.msg);
    return true;
  }
  if (IS_FREYR_FOLLOW(lower)) {
    const r = await freyr.setFreyrStationary(bot, false);
    bot.chat(r.msg);
    return true;
  }
  if (IS_FREYR_SUMMON(lower)) {
    const r = await freyr.summonFreyr(bot);
    bot.chat(r.msg);
    return true;
  }
  return false;
}

module.exports = { handle };
