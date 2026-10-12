// SemVer 2.0.0 parsing and precedence (build metadata ignored), mirrors SemVer.kt.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function parseSemVer(text) {
  if (typeof text !== 'string' || text.length > 64) return null;
  const m = SEMVER.exec(text);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], prerelease: m[4] ? m[4].split('.') : [], text };
}

function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemVer(x, y) {
  const a = typeof x === 'string' ? parseSemVer(x) : x;
  const b = typeof y === 'string' ? parseSemVer(y) : y;
  if (!a || !b) throw new Error('invalid semver');
  for (const k of ['major', 'minor', 'patch']) {
    if (a[k] !== b[k]) return Math.sign(a[k] - b[k]);
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (c) return c;
  }
  return 0;
}
