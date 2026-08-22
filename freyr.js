// freyr.js — Freyr Sword companion entity control
//
// Reverse engineered from soulslike-weaponry-1.3.1-1.20.1-fabric.jar
//
// Interactions (all C2S custom_payload packets carry EMPTY payload):
//   Summon:  equip soulsweapons:freyr_sword → bot.activateItem()
//   Return:  channel soulsweapons:check_can_freyr_return
//   Toggle:  channel soulsweapons:switch_stationary_freyr
//            (FreyrSwordEntity.setStationaryPos() is a real toggle:
//             if IS_STATIONARY → sets STATIONARY=NULLISH_POS, IS_STATIONARY=false (follow)
//             if !IS_STATIONARY → sets STATIONARY=player.pos, IS_STATIONARY=true)
//
// Server syncs our bound sword's UUID via S2C soulsweapons:freyr_sword_summon_uuid_sync
// (16-byte raw UUID). We intercept this so we can find the entity reliably.

const db = require('./db');
const { resolveItemName } = require('./items');
const { getModdedEntityName } = require('./registry-patch');

const CHANNEL_RETURN    = 'soulsweapons:check_can_freyr_return';
const CHANNEL_TOGGLE    = 'soulsweapons:switch_stationary_freyr';
const CHANNEL_UUID_SYNC = 'soulsweapons:freyr_sword_summon_uuid_sync';
const ITEM_NAME         = 'freyr_sword';

// Mark the Freyr entity as non-hostile so Nilo never attacks his own sword.
try {
  db.prepare("INSERT OR IGNORE INTO entities (name, is_hostile) VALUES ('freyr_sword_entity', 0)").run();
} catch (_) {}

// Per-bot state — each bot (Nilo, each clone) binds to its own sword and has
// its own stationary toggle. Keyed by bot instance so multiple concurrent
// connections (clones) never clobber each other's UUID/toggle state.
const stateByBot = new Map();

function stateFor(bot) {
  let s = stateByBot.get(bot);
  if (!s) {
    s = { freyrUUID: null, freyrStationary: false };
    stateByBot.set(bot, s);
  }
  return s;
}

// Parse 16-byte raw UUID buffer → standard UUID string
function parseUUID(buf) {
  if (!buf || buf.length < 16) return null;
  const h = buf.slice(0, 16).toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function sendPacket(bot, channel) {
  bot._client.write('custom_payload', { channel, data: Buffer.alloc(0) });
}

// Call once per bot instance at login.
function installFreyrListeners(bot) {
  const s = stateFor(bot);

  // Intercept the server's UUID sync — gives us the UUID of our sword entity.
  bot._client.on('custom_payload', (packet) => {
    if (packet.channel !== CHANNEL_UUID_SYNC) return;
    const uuid = parseUUID(packet.data);
    if (uuid) {
      s.freyrUUID = uuid;
      console.log(`[FREYR] (${bot.username}) Bound sword UUID: ${s.freyrUUID}`);
    }
  });

  // Reset stationary flag when the entity disappears (returned or killed).
  bot.on('entityGone', (entity) => {
    if (s.freyrUUID && entity.uuid === s.freyrUUID) {
      s.freyrStationary = false;
      // Don't null freyrUUID — the binding persists in server-side player NBT.
    }
  });

  stateByBot.set(bot, s);
  bot.once('end', () => stateByBot.delete(bot));
}

// Any freyr_sword_entity in the world, regardless of who summoned it. Matches
// by name (vanilla path) or by entityType -> all-entities-cache.json lookup
// (modded entities have e.name === undefined in mineflayer).
function findNearbyFreyrSwordEntities(bot) {
  return Object.values(bot.entities).filter(e => {
    if (typeof e.name === 'string' && e.name.toLowerCase().includes('freyr_sword')) return true;
    if (e.entityType != null) {
      const resolved = getModdedEntityName(e.entityType);
      if (resolved && resolved.includes('freyr_sword')) return true;
    }
    return false;
  });
}

// freyr_sword_entity nearby that aren't accounted for — not our own confirmed
// sword, and not bound to any UUID in `knownUUIDs` (pass the bound UUIDs of
// currently-online clones so their active swords aren't flagged as strays).
// What's left is most likely a sword a clone left behind by dying or
// disconnecting without retracting it first (see retractBeforeDisconnect) —
// though it could also belong to some other player; ownership can't be
// confirmed from outside without the UUID sync.
function findStraySwords(bot, knownUUIDs = []) {
  const s = stateFor(bot);
  const exclude = new Set(knownUUIDs.filter(Boolean));
  if (s.freyrUUID) exclude.add(s.freyrUUID);
  return findNearbyFreyrSwordEntities(bot).filter(e => !exclude.has(e.uuid));
}

// CONFIRMED match for *our* bound sword — UUID only. A freyr_sword_entity can
// belong to any player who owns the item, so entityType alone can't prove
// ownership (this caused Nilo to claim the player's own placed sword as his).
// Returns null if the UUID hasn't synced yet, even if a sword is visible nearby —
// callers needing a "might be mine" guess should use findNearbyFreyrSwordEntities.
function findFreyrEntity(bot) {
  const s = stateFor(bot);
  if (!s.freyrUUID) return null;
  return Object.values(bot.entities).find(e => e.uuid === s.freyrUUID) || null;
}

function hasFreyrItem(bot) {
  return bot.inventory.items().some(i => resolveItemName(i).includes(ITEM_NAME));
}

async function equipFreyr(bot) {
  const item = bot.inventory.items().find(i => resolveItemName(i).includes(ITEM_NAME));
  if (!item) return false;
  await bot.equip(item, 'hand');
  return true;
}

async function summonFreyr(bot) {
  const s = stateFor(bot);
  // Only a confirmed (UUID-matched) entity proves OUR sword is already out —
  // an unconfirmed nearby freyr_sword_entity could belong to another player.
  if (findFreyrEntity(bot)) return { ok: false, msg: 'Freyr Sword is already out.' };
  if (!hasFreyrItem(bot))   return { ok: false, msg: "I don't have the Freyr Sword." };
  if (!await equipFreyr(bot)) return { ok: false, msg: "Couldn't equip the Freyr Sword." };
  s.freyrStationary = false;
  bot.activateItem();
  return { ok: true, msg: 'Freyr Sword summoned.' };
}

async function returnFreyr(bot) {
  const s = stateFor(bot);
  sendPacket(bot, CHANNEL_RETURN);
  s.freyrStationary = false;
  return { ok: true, msg: 'Calling the Freyr Sword back.' };
}

// Best-effort, silent recall — call right before the bot disconnects for any
// reason (chat "leave", !nilo quit, service stop/restart). Never chats about
// it; this is housekeeping, not a conversation. Leaving the sword summoned
// across a logout strands it in the world bound to a UUID that persists in
// player NBT, which is what causes the "thinks it's out but it's not" stuck
// state on the next login. A short delay gives the C2S packet time to flush
// over the socket before the connection actually closes.
async function retractBeforeDisconnect(bot) {
  if (!findFreyrEntity(bot)) return;
  const s = stateFor(bot);
  try {
    sendPacket(bot, CHANNEL_RETURN);
    s.freyrStationary = false;
    await new Promise(resolve => setTimeout(resolve, 250));
  } catch (_) {}
}

// Sends the toggle packet. If you want a specific state, use setFreyrStationary().
async function toggleFreyrStationary(bot) {
  const s = stateFor(bot);
  sendPacket(bot, CHANNEL_TOGGLE);
  s.freyrStationary = !s.freyrStationary;
  const entity = findFreyrEntity(bot);
  const pos = entity
    ? `${Math.round(entity.position.x)}, ${Math.round(entity.position.y)}, ${Math.round(entity.position.z)}`
    : 'here';
  return {
    ok: true,
    msg: s.freyrStationary ? `Freyr Sword holding at (${pos}).` : 'Freyr Sword back to following.',
  };
}

// Set to a specific state without toggling unexpectedly.
async function setFreyrStationary(bot, wantStationary) {
  const s = stateFor(bot);
  if (wantStationary === s.freyrStationary) {
    return { ok: true, msg: wantStationary ? 'Already holding position.' : 'Already following.' };
  }
  return toggleFreyrStationary(bot);
}

function freyrStatus(bot) {
  const s       = stateFor(bot);
  const entity  = findFreyrEntity(bot);     // confirmed (UUID match) only
  const hasItem = hasFreyrItem(bot);

  if (entity) {
    const p = entity.position;
    const pos = `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
    return s.freyrStationary
      ? `Freyr Sword is holding position at ${pos}.`
      : `Freyr Sword is following me, currently at ${pos}.`;
  }

  const nearby = findNearbyFreyrSwordEntities(bot);
  const nearbyNote = nearby.length
    ? ` (I do see ${nearby.length === 1 ? 'a Freyr Sword' : `${nearby.length} Freyr Swords`} nearby — could be someone else's, I can't confirm ownership without my UUID sync.)`
    : '';

  if (hasItem) return `Freyr Sword is in my inventory (not summoned).${nearbyNote}`;
  return `Freyr Sword not found — not in inventory and not in the world.${nearbyNote}`;
}

module.exports = {
  installFreyrListeners,
  findFreyrEntity,
  findNearbyFreyrSwordEntities,
  findStraySwords,
  hasFreyrItem,
  summonFreyr,
  returnFreyr,
  retractBeforeDisconnect,
  toggleFreyrStationary,
  setFreyrStationary,
  freyrStatus,
  isStationary: (bot) => stateFor(bot).freyrStationary,
  getFreyrUUID: (bot) => stateFor(bot).freyrUUID,
};
