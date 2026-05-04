// items.js — inventory and item helpers

const { GoalNear } = require('mineflayer-pathfinder').goals;
const { createMovements } = require('./movement');

// ── Equipment slot detection ──────────────────────────────────────────────────

function getEquipDestination(item) {
  const n = item.name;
  // Head — vanilla + common modded keywords
  if (['helmet','cap','skull','hat','hood','mask','helm','crown','circlet',
       'coif','casque','bascinet','barbute','morion','headband','headgear',
       'goggles','tiara','crest'].some(k => n.includes(k))) return 'head';
  // Torso
  if (['chestplate','tunic','elytra','breastplate','vest','jacket','hauberk',
       'chestguard','cuirass','coat','brigandine','jerkin','surcoat',
       'chest_armor','body_armor'].some(k => n.includes(k))) return 'torso';
  // Legs
  if (['leggings','pants','trousers','greaves','cuisses','chausses',
       'legguard','leg_armor','kilt','skirt'].some(k => n.includes(k))) return 'legs';
  // Feet
  if (['boots','shoes','sabatons','sollerets','sandals','slippers',
       'greave'].some(k => n.includes(k))) return 'feet';
  // Off-hand
  if (n.includes('shield') || n.includes('buckler') || n.includes('offhand')) return 'off-hand';
  return 'hand';
}

function isWeapon(item) {
  // Broad weapon check — covers vanilla and common modded weapons
  return ['sword','axe','mace','trident','scythe','dagger','spear','glaive',
    'halberd','rapier','hammer','club','saber','claymore','katana','tachi',
    'blade','staff','wand','scepter','tome','spellbook','casting',
    'bow','crossbow','gun','rifle','pistol','musket','flintlock',
    'whip','flail','maul','quarterstaff','lance'].some(k => item.name.includes(k));
}

function isEquippable(item) {
  if (isWeapon(item)) return true;
  return getEquipDestination(item) !== 'hand'; // armor / shield / off-hand items
}

// ── Inventory summary ─────────────────────────────────────────────────────────

function getInventorySummary(bot) {
  const items = bot.inventory.items();
  if (items.length === 0) return 'empty';
  return items.map(i => `${i.count}x ${i.name}`).join(', ');
}

// ── Dropped-item pickup ───────────────────────────────────────────────────────

// Walk to nearest dropped item within maxDist, wait for pickup
async function pickupNearestItem(bot, maxDist = 8) {
  const dropped = Object.values(bot.entities).filter(e =>
    e.name === 'item' && e.position.distanceTo(bot.entity.position) < maxDist
  ).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));

  if (dropped.length === 0) return false;
  const item = dropped[0];
  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);
  await bot.pathfinder.goto(new GoalNear(item.position.x, item.position.y, item.position.z, 1));
  await new Promise(r => setTimeout(r, 600)); // let inventory update
  return true;
}

// ── Buildable block detection ─────────────────────────────────────────────────

const BUILDABLE_KEYWORDS = [
  'planks','cobblestone','stone','dirt','log','wood','brick','sand','gravel',
  'deepslate','tuff','andesite','granite','diorite','basalt','blackstone','mud',
];

function isBuildable(item) {
  return BUILDABLE_KEYWORDS.some(k => item.name.includes(k));
}

module.exports = {
  getEquipDestination, isWeapon, isEquippable,
  getInventorySummary, pickupNearestItem,
  isBuildable,
};
