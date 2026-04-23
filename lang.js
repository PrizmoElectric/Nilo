// lang.js — language detection (English vs Portuguese)

const PT_WORDS = new Set([
  'não','sim','você','voce','obrigado','obrigada','por','favor','aqui','ali',
  'também','tambem','mas','então','entao','quando','onde','como','porque',
  'que','uma','uns','umas','seu','sua','dele','dela','nós','nos','eles','elas',
  'me','te','se','lhe','meu','minha','teu','tua','isso','esse','essa','este',
  'esta','aquele','aquela','está','esta','estou','sou','são','sao','tem','têm',
  'vou','vai','vem','foi','era','fui','pelo','pela','num','numa','com','sem',
  'pra','para','até','ate','sobre','entre','depois','antes','agora','ainda',
  'sempre','nunca','já','ja','muito','pouco','mais','menos','bem','mal',
  'quero','posso','pode','preciso','tenho','conta','diz','faz','vai',
]);

function detectLanguage(text) {
  const words = text.toLowerCase().replace(/[^a-záàâãéèêíóôõúüç\s]/g, '').split(/\s+/);
  const ptCount = words.filter(w => PT_WORDS.has(w)).length;
  return ptCount >= 1 ? 'pt-BR' : 'en';
}

module.exports = { detectLanguage };
