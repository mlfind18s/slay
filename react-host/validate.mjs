#!/usr/bin/env node
// Validates react-host-app.zip with the same rules as the Android host.
//
//   node tools/validate.mjs <react-host-app.zip> [--tag v0.1.0] [--host-version 0.1.0] [--json]
import { readFileSync } from 'node:fs';
import { validatePackage } from './lib/package.mjs';

const argv = process.argv.slice(2);
const file = argv.find((a, i) => !a.startsWith('--') && !['--tag', '--host-version'].includes(argv[i - 1]));
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
if (!file) {
  console.error('usage: node tools/validate.mjs <zip> [--tag vX.Y.Z] [--host-version X.Y.Z] [--json]');
  process.exit(64);
}
const result = validatePackage(readFileSync(file), { hostVersion: opt('--host-version') });
const tag = opt('--tag');
if (result.ok && tag !== undefined && tag !== `v${result.manifest.version}`) {
  result.ok = false;
  result.error = { code: 'TAG_VERSION_MISMATCH', message: `tag "${tag}" must equal "v${result.manifest.version}"` };
}
if (argv.includes('--json')) {
  console.log(JSON.stringify({ ok: result.ok, error: result.error, manifest: result.manifest, warnings: result.warnings }, null, 2));
} else if (result.ok) {
  console.log(`OK ${result.manifest.appId} ${result.manifest.version} (${result.files.size} files, ${result.unpackedBytes} bytes)`);
  for (const w of result.warnings) console.log(`warning ${w.code}: ${w.message}`);
} else {
  console.error(`error ${result.error.code}: ${result.error.message}`);
}
process.exit(result.ok ? 0 : 1);
