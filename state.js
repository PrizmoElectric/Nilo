// state.js — shared mutable bot state
// All modules read/write this object rather than scattering globals.

const state = {
  activeBotRef:          null,
  isFarming:             false,
  proximityInterval:     null,
  autonomousInterval:    null,
  exploringEnabled:      true,
  isLooting:             false,
  lastInteractionTime:   0,
  justDied:              false,
  behaviorOwner:         null,
  autonomousSkillsEnabled: false,
  skillLearnInProgress:  false,
  behaviorMode:          'idle',
  behaviorInterval:      null,
  intentionalDisconnect: false,
  customWeapon:          null,  // modded weapon name set by "use X as weapon"
  discordContext:        false, // true while handling a Discord message — bot.chat skips in-game
  scans:                 [],    // [{text, stamp, radius, rows}, ...] newest first — for echo
};

module.exports = state;
