const mirror     = require('./mirror');
const navigation = require('./navigation');
const freyrCmd   = require('./freyr');
const shieldCmd  = require('./shield');
const cloneCmd   = require('./clone');
const clonesCmd  = require('./clones');
const internet   = require('./internet');
const combat     = require('./combat');
const activities = require('./activities');
const physical   = require('./physical');
const inventory  = require('./inventory');
const crafting   = require('./crafting');
const skills     = require('./skills');
const trust      = require('./trust');
const registry   = require('./registry');
const misc       = require('./misc');

// Quick handlers — movement, behavior, basic interaction. Still require the #
// prefix like everything else (see handleNaturalCommand below); "quick" here
// just means these are the common/fast commands, as opposed to prefixHandlers'
// destructive/slow/rarely-used ones.
// freyrCmd first: it early-exits unless the message contains "freyr", so it must
// run before navigation's bare /\bfollow\b/ etc. would otherwise swallow
// "freyr follow" / "freyr hold" as ordinary movement commands.
const quickHandlers = [
  freyrCmd,
  shieldCmd,
  cloneCmd,   // before clonesCmd — handles "clone me" / "dismiss my clone"
  clonesCmd,  // handles "clone army" / "clones on"
  internet,
  navigation,
  activities,
];

// Prefix handlers — destructive, slow, or rarely-used commands.
const prefixHandlers = [
  mirror,
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

// ALL command matching requires prefixed:true (i.e. the caller already
// stripped a leading # off the message). Without the prefix, nothing here
// ever runs — the caller falls through to Letta for plain conversation.
async function handleNaturalCommand(bot, lower, raw, username, { prefixed = false } = {}) {
  if (!prefixed) return false;
  for (const h of quickHandlers) {
    const result = await h.handle(bot, lower, raw, username);
    if (result) return true;
  }
  for (const h of prefixHandlers) {
    const result = await h.handle(bot, lower, raw, username);
    if (result) return true;
  }
  return false;
}

module.exports = { handleNaturalCommand };
