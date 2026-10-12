#!/usr/bin/env node
// Packs a built static app directory into react-host-app.zip and validates the result.
//
//   node tools/pack.mjs <dist-dir> [--out react-host-app.zip] [--tag v0.1.0] [--host-version 0.1.0]
//
// The directory must already contain react-host.json, index.html and the icon. Its contents
// (not the directory itself) become the ZIP root. With --tag (or GITHUB_REF_NAME when
// --tag-from-env is given) the tag must equal "v" + manifest.version.
import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { writeZip } from './lib/zip.mjs';
import { validatePackage } from './lib/package.mjs';
import { ASSET_NAME } from './lib/errors.mjs';

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--tag') opts.tag = argv[++i];
    else if (a === '--tag-from-env') opts.tagFromEnv = true;
    else if (a === '--host-version') opts.hostVersion = argv[++i];
    else opts.positional.push(a);
  }
  return opts;
}

function collect(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const stat = lstatSync(full);
      const rel = relative(root, full).split(sep).join('/');
      if (stat.isSymbolicLink()) throw new Error(`symlinks are not allowed in a package: ${rel}`);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) files.push(rel);
      else throw new Error(`unsupported file type: ${rel}`);
    }
  };
  walk(root);
  return files.sort();
}

export function packDirectory(dir) {
  const files = collect(dir);
  return writeZip(files.map((name) => ({ name, data: readFileSync(join(dir, name)) })));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = opts.positional[0];
  if (!dir) {
    console.error('usage: node tools/pack.mjs <dist-dir> [--out file] [--tag vX.Y.Z | --tag-from-env] [--host-version X.Y.Z]');
    process.exit(64);
  }
  const out = resolve(opts.out ?? ASSET_NAME);
  const zip = packDirectory(resolve(dir));
  const result = validatePackage(zip, { hostVersion: opts.hostVersion });
  if (!result.ok) {
    console.error(`error ${result.error.code}: ${result.error.message}`);
    process.exit(1);
  }
  const tag = opts.tag ?? (opts.tagFromEnv ? process.env.GITHUB_REF_NAME : undefined);
  if (tag !== undefined && tag !== `v${result.manifest.version}`) {
    console.error(`error TAG_VERSION_MISMATCH: tag "${tag}" must equal "v${result.manifest.version}" (manifest.version)`);
    process.exit(1);
  }
  for (const w of result.warnings) console.warn(`warning ${w.code}: ${w.message}`);
  writeFileSync(out, zip);
  const sha = createHash('sha256').update(zip).digest('hex');
  console.log(`${out}`);
  console.log(`  appId ${result.manifest.appId}, version ${result.manifest.version}`);
  console.log(`  ${result.files.size} files, ${result.unpackedBytes} bytes unpacked, ${zip.length} bytes zipped`);
  console.log(`  sha256 ${sha}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) main();
