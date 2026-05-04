const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;
const { MASTER } = require('./config');
const { getModdedBlockName } = require('./registry-patch');

const DEFAULT_RANGE = 64;
const AIR = new Set(['air', 'cave_air', 'void_air']);

// Returns the first thing MASTER is looking at within maxDistance blocks.
// block.name is '' when the block is unresolved modded — we treat those as solid
// and report them as 'unknown [sid:X]' rather than seeing through them.
function getPlayerGazeTarget(bot, maxDistance = DEFAULT_RANGE) {
  const masterEntity = bot.players[MASTER]?.entity;
  if (!masterEntity?.position) return { block: null, entity: null, position: null };

  const eye = masterEntity.position.offset(0, masterEntity.height, 0);
  const { yaw, pitch } = masterEntity;
  const cosPitch = Math.cos(pitch);
  const dir = new Vec3(
    -Math.sin(yaw) * cosPitch,
     Math.sin(pitch),
    -Math.cos(yaw) * cosPitch
  ).normalize();

  // ── Block hit ─────────────────────────────────────────────────────────────
  const blockIter = new RaycastIterator(eye, dir, maxDistance);
  let block = null;
  let blockDist = Infinity;

  let pos;
  while ((pos = blockIter.next())) {
    const bvec = new Vec3(pos.x, pos.y, pos.z);
    const b = bot.blockAt(bvec);
    if (!b) continue;

    if (b.name === '') {
      // Unresolved modded block — physics unknown, treat as solid
      const sid = bot.world.getBlockStateId(bvec);
      const moddedName = getModdedBlockName(sid);
      block = { name: moddedName || 'unknown', position: bvec, stateId: sid };
      blockDist = eye.distanceTo(bvec.offset(0.5, 0.5, 0.5));
      break;
    }

    if (AIR.has(b.name) || b.boundingBox === 'empty') continue;
    block = b;
    blockDist = eye.distanceTo(b.position.offset(0.5, 0.5, 0.5));
    break;
  }

  // ── Entity scan ───────────────────────────────────────────────────────────
  // intersect() uses only this.pos + this.dir (stateless w.r.t. next() calls)
  const entityIter = new RaycastIterator(eye, dir, maxDistance);
  const nearby = Object.values(bot.entities).filter(e =>
    e !== masterEntity && e.position.distanceTo(masterEntity.position) <= maxDistance
  );

  let hitEntity = null;
  let entityDist = Infinity;

  for (const e of nearby) {
    const w = (e.width ?? 0.6) / 2;
    const shapes = [[-w, 0, -w, w, e.height ?? 1.8, w]];
    const intersect = entityIter.intersect(shapes, e.position);
    if (!intersect) continue;
    const dist = eye.distanceTo(intersect.pos);
    if (dist > maxDistance) continue;
    if (dist < entityDist) {
      hitEntity = e;
      entityDist = dist;
    }
  }

  if (hitEntity && entityDist < blockDist) {
    return { block: null, entity: hitEntity, position: eye.plus(dir.scaled(entityDist)) };
  }

  if (block) {
    return { block, entity: null, position: block.position };
  }

  return { block: null, entity: null, position: null };
}

module.exports = { getPlayerGazeTarget };
