function cmd(patterns) {
  return lower => patterns.some(p => p.test(lower));
}
module.exports = { cmd };
