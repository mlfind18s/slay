#!/usr/bin/env node
// Builds react-host-app.zip for React Host. The game has no build step: index.html and js/
// are copied into dist/ together with react-host.json and a generated icon, then packed.
// Extra arguments go to react-host/pack.mjs, e.g. `--tag-from-env` in CI.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { encodePng } from '../react-host/lib/png.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('index.html', 'dist/index.html');
cpSync('js', 'dist/js', { recursive: true });

writeFileSync('dist/react-host.json', JSON.stringify({
  schemaVersion: 1,
  appId: 'dev.yevhen.slay',
  name: 'Slay',
  version: pkg.version,
  description: 'Гексова стратегія проти комп’ютера',
  entry: 'index.html',
  icon: 'icon.png',
  minHostVersion: '0.1.0',
}, null, 2) + '\n');

writeFileSync('dist/icon.png', hexIcon(192));
execFileSync(process.execPath, ['react-host/pack.mjs', 'dist', '--out', 'react-host-app.zip', ...process.argv.slice(2)], { stdio: 'inherit' });

/** Rounded dark tile with a patch of coloured hexes, like a small Slay map. */
function hexIcon(size) {
  const colors = [[229, 57, 53], [67, 160, 71], [30, 136, 229], [253, 216, 53], [142, 36, 170]];
  const radius = size * 0.22;
  const s = size / 8.5; // hex size
  return encodePng(size, size, (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    if ((x - cx) ** 2 + (y - cy) ** 2 > radius ** 2) return [0, 0, 0, 0];
    // Pointy-top axial coordinates around the centre.
    const px = x - size / 2;
    const py = y - size / 2;
    const q = ((Math.sqrt(3) / 3) * px - py / 3) / s;
    const r = ((2 / 3) * py) / s;
    let rx = Math.round(q);
    let rz = Math.round(r);
    let ry = Math.round(-q - r);
    const dx = Math.abs(rx - q);
    const dz = Math.abs(rz - r);
    const dy = Math.abs(ry + q + r);
    if (dx > dy && dx > dz) rx = -ry - rz;
    else if (dy <= dz) rz = -rx - ry;
    const dist = Math.max(Math.abs(rx), Math.abs(rz), Math.abs(-rx - rz));
    if (dist > 2) return [22, 32, 44, 255]; // sea
    // Hex-shaped distance from the hex centre (cube metric) draws the border line.
    const fq = q - rx;
    const fr = r - rz;
    const d = (Math.abs(fq) + Math.abs(fr) + Math.abs(fq + fr)) / 2;
    if (d > 0.465) return [14, 14, 20, 255];
    const c = colors[(((rx * 2 + rz * 3) % 5) + 5) % 5];
    return [c[0], c[1], c[2], 255];
  });
}
