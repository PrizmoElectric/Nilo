const navigation = require('./navigation');
const combat     = require('./combat');
const activities = require('./activities');
const physical   = require('./physical');
const inventory  = require('./inventory');
const crafting   = require('./crafting');
const skills     = require('./skills');
const trust      = require('./trust');
const registry   = require('./registry');
const misc       = require('./misc');

const handlers = [
  navigation,
  combat,
  activities,
  physical,
  inventory,
  crafting,
  skills,
  trust,
  registry,
  misc,
];

async function handleNaturalCommand(bot, lower, raw, username) {
  for (const h of handlers) {
    const result = await h.handle(bot, lower, raw, username);
    if (result) return true;
  }
  return false;
}

module.exports = { handleNaturalCommand };
