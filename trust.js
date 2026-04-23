// trust.js — player trust management

const { MASTER, loadConfig, saveConfig } = require('./config');

function isTrusted(username) {
  if (username === MASTER) return true;
  return (loadConfig().trusted || []).includes(username);
}

function trustPlayer(username) {
  const cfg   = loadConfig();
  cfg.trusted = [...new Set([...(cfg.trusted || []), username])];
  saveConfig(cfg);
}

function untrustPlayer(username) {
  const cfg   = loadConfig();
  cfg.trusted = (cfg.trusted || []).filter(n => n !== username);
  saveConfig(cfg);
}

function listTrusted() {
  return loadConfig().trusted || [];
}

module.exports = { isTrusted, trustPlayer, untrustPlayer, listTrusted };
