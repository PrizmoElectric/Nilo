// state.js — shared mutable bot state
// All modules read/write this object rather than scattering globals.

const state = {
  activeBotRef:          null,
  isFarming:             false,
  proximityInterval:     null,
  autonomousInterval:    null,
  exploringEnabled:      true,
  isLooting:             false,
  manualInteractLock:    false, // set by manual commands — autonomous behavior won't reset isLooting while this is true
  isMining:              false,
  deathPosition:         null,
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
  isSneaking:            false, // persists sneak across pathfinder resets and behavior changes

  // Clone army — see clones.js / commands/clones.js
  cloneModeActive:       false, // gate: "clone N" only spawns when this is true (toggled by cloneon/cloneoff)
  freyrCloneToggle:      false, // shared by all clones: true = keep swords summoned, false = return them

  // Internet access — see websearch.js / commands/internet.js
  internetEnabled:       false, // gate: "search <query>" only runs when this is true (toggled by "internet on"/"internet off")

  // Connection diagnostics — see nilo.js bot.on('login'/'error'/'end'), used by !status
  bootTime:              Date.now(), // process start — fallback "down since" if never connected
  connectedSince:        null,       // Date.now() of last successful login, null while disconnected
  lastDisconnectTime:    null,       // Date.now() of the last bot.on('end')
  lastConnectionError:   null,       // { message, code, time } from the last bot.on('error')
  reconnectAttempts:     0,          // consecutive failed reconnects, resets to 0 on login
};

module.exports = state;
