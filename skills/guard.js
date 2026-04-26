// Skill: guard
// Description: guard current position, attacking nearby hostile mobs using combatTick autonomy
// Handcrafted: true

const { goals: { GoalBlock } } = require('mineflayer-pathfinder');
const state = require('../state');
const { setBehavior } = require('../behavior');
const { createMovements } = require('../movement');
const { combatTick, equipShield, equipBestMeleeWeapon, isHostileMob, MELEE_RANGE, RETREAT_HP } = require('../combat');

async function niloSkill(bot) {
  const guardPos = bot.entity.position.clone();
  setBehavior(bot, 'guard', null);
  equipShield(bot);
  equipBestMeleeWeapon(bot);
  bot.chat('Guarding this spot. Say stop to cancel.');

  const movements = createMovements(bot);
  bot.pathfinder.setMovements(movements);

  let shieldUp = false;
  const lower = () => { if (shieldUp) { bot.deactivateItem(); shieldUp = false; } };
  const raise = () => { if (!shieldUp) { bot.activateItem(true); shieldUp = true; } };

  state.behaviorInterval = setInterval(async () => {
    if (state.behaviorMode !== 'guard') { lower(); return; }

    if (bot.health <= RETREAT_HP) {
      lower();
      bot.pathfinder.setGoal(null);
      bot.chat('Taking too much damage — falling back!');
      setBehavior(bot, 'idle', null);
      return;
    }

    // Search for targets around guard post, not bot's current position
    const engaged = await combatTick(bot, guardPos);

    if (engaged) {
      const inMelee = bot.nearestEntity(e => isHostileMob(e) && e.position.distanceTo(bot.entity.position) <= MELEE_RANGE);
      if (inMelee) raise(); else lower();
    } else {
      // No threats — return to post
      lower();
      const dist = bot.entity.position.distanceTo(guardPos);
      if (dist > 2) {
        bot.pathfinder.setGoal(
          new GoalBlock(Math.floor(guardPos.x), Math.floor(guardPos.y), Math.floor(guardPos.z))
        );
      } else {
        bot.pathfinder.setGoal(null);
      }
    }
  }, 200);

  return 'guarding current position';
}

module.exports = niloSkill;
