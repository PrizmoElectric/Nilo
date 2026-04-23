// behavior.js — behavior mode state management

const state = require('./state');

// mode: idle | follow | wander | sit | attack | defensive | passive | fishing | bow | building | dance

function clearBehavior(bot) {
  if (state.behaviorInterval) {
    if (typeof state.behaviorInterval._cleanup === 'function') {
      state.behaviorInterval._cleanup(); // listener-based cleanup (mineflayer-movement)
    } else {
      clearInterval(state.behaviorInterval);
    }
    state.behaviorInterval = null;
  }
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  state.behaviorOwner = null;
}

function setBehavior(bot, mode, username) {
  clearBehavior(bot);
  state.behaviorMode = mode;
  state.behaviorOwner = username || null;
  console.log(`[NILO] Behavior -> ${mode}${username ? ` (for ${username})` : ''}`);
}

module.exports = { clearBehavior, setBehavior };
