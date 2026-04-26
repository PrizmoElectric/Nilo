const { runCommand } = require('../actions');

async function handle(bot, lower, raw) {
  // Say / repeat
  const repeatMatch = raw.match(/^(?:nilo[,:]?\s+)?(?:repeat after me[:\s]+|say[:\s]+|fala[:\s]+|repete[:\s]+)"?(.+?)"?\s*$/i);
  if (repeatMatch) {
    const toSay = repeatMatch[1].trim();
    if (toSay.startsWith('/')) {
      runCommand(bot, toSay);
      bot.chat(`Running: ${toSay.slice(0, 50)}`);
    } else {
      bot.chat(toSay);
    }
    return true;
  }

  return false;
}

module.exports = { handle };
