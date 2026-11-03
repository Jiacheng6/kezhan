// Compatibility boundary for old launch scripts. New code uses KEBO_* only.
function normalizeEnvironment(env = process.env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('XXT_')) {
      const next = 'KEBO_' + key.slice(4);
      if (env[next] === undefined) env[next] = env[key];
    }
  }
  return env;
}
normalizeEnvironment();
module.exports = { normalizeEnvironment };
