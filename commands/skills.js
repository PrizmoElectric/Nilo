const state = require('../state');
const skillEngine = require('../skill-engine');
const { cmd } = require('./_util');

const IS_LIST_SKILLS = cmd([
  /\bwhat skills? (do you know|have you learned|can you do)\b/,
  /\b(show|list) (me )?(your |all )?skills?\b/,
  /\bquais skills? (você sabe|você tem|você conhece)\b/,
  /\bmostra (suas |as )?skills?\b/, /\blist(a)? skills?\b/,
]);
const IS_AUTONOMOUS_OFF = cmd([
  /\b(stop|turn off|disable|deactivate) autonomous( mode)?\b/,
  /\bautonomous (mode )?off\b/,
  /\b(desativa|desliga|para) (o )?modo autônomo\b/,
]);
const IS_AUTONOMOUS_ON = cmd([
  /\b(start|turn on|enable|activate) autonomous( mode)?\b/,
  /\bautonomous (mode )?on\b/, /\bbe autonomous\b/,
  /\b(ativa|liga|inicia) (o )?modo autônomo\b/,
]);
const IS_FORGET_SKILL = cmd([
  /\bforget (how to|the skill|skill)?\b/, /\bunlearn\b/, /\bdelete (the )?skill\b/,
  /\besquecer?\b/, /\bapaga (a |o )?(skill|habilidade)\b/,
]);
const IS_QUEUE_GOAL = cmd([
  /\b(add|queue|enqueue) .+ (to (your )?goals?|to (your )?curriculum|as a goal)\b/,
  /\bqueue (a )?goal\b/, /\badiciona .+ (aos? objetivos|ao curriculum)\b/,
]);
const IS_LEARN_SKILL = cmd([
  /\blearn (how to|to)\b/, /\bteach yourself (to|how to)\b/, /\blearn (the )?skill\b/,
  /\baprende (a|como)\b/, /\baprender (a|como)\b/, /\bensina(-te)? (a|como)\b/,
]);
const IS_RUN_SKILL = cmd([
  /\b(do|run|perform|execute|use) (the |your )?(\w+ )?skill\b/,
  /\b(do|run|perform|execute) (the )?\w+\b/,
  /\b(faz|executa|usa) (a |o )?skill\b/, /\bexecuta\b/,
]);

async function handle(bot, lower, raw) {
  if (IS_LIST_SKILLS(lower)) {
    const list   = skillEngine.listSkills();
    const chunks = list.match(/.{1,200}(?:\s|$)/g) || [list];
    for (const chunk of chunks) bot.chat(chunk.trim());
    return true;
  }

  if (IS_AUTONOMOUS_OFF(lower)) {
    state.autonomousSkillsEnabled = false;
    bot.chat('Autonomous mode OFF.');
    return true;
  }

  if (IS_AUTONOMOUS_ON(lower)) {
    state.autonomousSkillsEnabled = true;
    bot.chat(`Autonomous mode ON. I will learn new skills when idle. (${skillEngine.skillCount()} skills known)`);
    return true;
  }

  if (IS_FORGET_SKILL(lower)) {
    const m = raw.match(/(?:forget|unlearn|delete skill|apaga skill|esquecer?)\s+(?:how to|the skill|skill|a skill|o skill|a habilidade)?\s*["']?([a-z0-9_][a-z0-9_ ]*)["']?/i);
    if (!m) { bot.chat('Which skill should I forget?'); return true; }
    const name = m[1].trim().replace(/\s+/g, '_').toLowerCase();
    const ok   = skillEngine.deleteSkill(name);
    bot.chat(ok ? `Forgot skill: ${name}.` : `No skill named ${name}.`);
    return true;
  }

  if (IS_QUEUE_GOAL(lower)) {
    const m = raw.match(/(?:add|queue|enqueue|adiciona)\s+(.+?)\s+(?:to (?:your )?goals?|to (?:your )?curriculum|as a goal|aos? objetivos|ao curriculum)/i);
    if (!m) { bot.chat('What goal should I queue?'); return true; }
    skillEngine.queueGoal(m[1].trim());
    bot.chat(`Added to curriculum: "${m[1].trim().slice(0, 50)}"`);
    return true;
  }

  if (IS_LEARN_SKILL(lower)) {
    if (state.skillLearnInProgress) { bot.chat('Already learning something. Give me a moment.'); return true; }
    const m = raw.match(/(?:learn|teach yourself|aprende?r?|ensina-?te?)\s+(?:how to|to|a|como)?\s*(.+)/i);
    if (!m) { bot.chat('What should I learn?'); return true; }
    const task = m[1].trim();
    state.skillLearnInProgress = true;
    bot.chat(`Learning: ${task}`);
    skillEngine.learnSkill(bot, task)
      .catch(e => { console.error('[SKILL] learnSkill error:', e.message); bot.chat('Something went wrong while learning.'); })
      .finally(() => { state.skillLearnInProgress = false; });
    return true;
  }

  if (IS_RUN_SKILL(lower)) {
    const m = raw.match(/(?:do|run|perform|execute|use|faz|executa|usa)\s+(?:the |your |a )?(?:skill\s+)?["']?([a-z0-9_][a-z0-9_ ]*)["']?/i);
    if (m) {
      const name = m[1].trim().replace(/\s+/g, '_').toLowerCase();
      if (skillEngine.hasSkill(name)) {
        bot.chat(`Running skill: ${name}...`);
        skillEngine.runSkill(bot, name)
          .then(({ success, result, error }) => {
            bot.chat(success ? `Done: ${String(result ?? name).slice(0, 60)}` : `Skill failed: ${error}`);
          })
          .catch(e => bot.chat(`Error: ${e.message}`));
        return true;
      }
    }
  }

  return false;
}

module.exports = { handle };
