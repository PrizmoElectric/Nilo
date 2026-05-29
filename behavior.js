// behavior.js — behavior mode state management

const state  = require('./state');

// mode: idle | follow | wander | sit | attack | assist | guard | defensive | passive | fishing | bow | building | dance | tunneling

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
  if (state.isSneaking) bot.setControlState('sneak', true);
  state.behaviorOwner = null;
}

// Modes that represent "stop what you're doing" — always allowed even during active tasks
const STOP_MODES = new Set(['idle', 'passive', 'defensive', 'sit']);

function setBehavior(bot, mode, username) {
  if ((state.isLooting || state.isMining) && !STOP_MODES.has(mode)) {
    console.log(`[NILO] setBehavior(${mode}) skipped — active task (looting=${state.isLooting} mining=${state.isMining})`);
    return false;
  }
  // Stop modes during active tasks cancel them immediately
  if (STOP_MODES.has(mode)) {
    state.isLooting = false;
    state.isMining  = false;
  }
  clearBehavior(bot);
  state.behaviorMode = mode;
  state.behaviorOwner = username || null;
  console.log(`[NILO] Behavior -> ${mode}${username ? ` (for ${username})` : ''}`);
  return true;
}

module.exports = { clearBehavior, setBehavior };
