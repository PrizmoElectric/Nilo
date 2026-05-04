// blockresolver.js
// ============================================================
// CONTEXTO: NILO roda no servidor Minecraft modded "Prominence 2
// - Hasturian Era" (Fabric). Mods adicionam blocos novos e
// reordenam o registry na inicialização, fazendo os stateIds do
// vanilla mudarem. NUNCA use stateIds hardcodados nem o pacote
// externo `minecraft-data` para resolver blocos — ele usa dados
// vanilla e vai retornar stateIds errados no modded.
//
// REGRA PRINCIPAL: sempre resolva nome → stateId em runtime
// usando `bot.registry`, que é populado com os dados reais do
// servidor após a conexão.
// ============================================================

/**
 * Resolve um bloco pelo nome usando o registry real do servidor.
 * Funciona com blocos vanilla e de mods.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string} blockName - ex: 'stone', 'oak_log', 'create:andesite_alloy'
 * @returns {{ id: number, stateId: number, name: string } | null}
 */
function resolveBlock(bot, blockName) {
  // Tenta direto, com namespace minecraft: e sem namespace
  const block =
    bot.registry.blocksByName[blockName] ||
    bot.registry.blocksByName[`minecraft:${blockName}`] ||
    bot.registry.blocksByName[blockName.replace(/^minecraft:/, '')]

  if (!block) {
    const similar = Object.keys(bot.registry.blocksByName)
      .filter((name) => name.includes(blockName))
      .slice(0, 5)
    console.warn(
      `[blockResolver] Bloco "${blockName}" não encontrado no registry.` +
        (similar.length ? ` Similares: ${similar.join(', ')}` : ' Nenhum similar encontrado.')
    )
    return null
  }

  return {
    id: block.id,
    stateId: block.minStateId, // estado padrão (sem rotação/variação)
    name: block.name,
  }
}

/**
 * Retorna o stateId exato de um bloco já presente no mundo.
 * Use quando a orientação/estado físico importa (porta aberta,
 * slab em cima/baixo, log rotacionado, etc).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {import('vec3').Vec3} position
 * @returns {number | null}
 */
function getStateIdAt(bot, position) {
  const block = bot.blockAt(position)
  if (!block) return null
  return block.stateId
}

/**
 * Encontra o bloco mais próximo pelo nome usando o registry
 * correto. Wrapper conveniente sobre bot.findBlock.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string} blockName
 * @param {number} maxDistance
 * @returns {import('prismarine-block').Block | null}
 */
function findNearestBlock(bot, blockName, maxDistance = 64) {
  const resolved = resolveBlock(bot, blockName)
  if (!resolved) return null

  return bot.findBlock({
    matching: resolved.id,
    maxDistance,
  })
}

/**
 * DEBUG: lista todos os blocos do registry que contêm uma string.
 * Útil para descobrir o nome exato de blocos de mods.
 *
 * @param {import('mineflayer').Bot} bot
 * @param {string} query
 */
function searchRegistry(bot, query) {
  const results = Object.keys(bot.registry.blocksByName)
    .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
  console.log(`[blockResolver] Busca por "${query}": ${results.join(', ') || 'nenhum resultado'}`)
  return results
}

module.exports = { resolveBlock, getStateIdAt, findNearestBlock, searchRegistry }
