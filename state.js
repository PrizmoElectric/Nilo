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
};

module.exports = state;
