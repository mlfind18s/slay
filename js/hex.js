/* Гексова геометрія.
 * Осьові координати (q, r), гекси «гострим верхом» (pointy-top).
 * Ключ гекса — рядок "q,r". Нічого не знає про гру чи DOM.
 */
(function (global) {
  'use strict';

  const SQRT3 = Math.sqrt(3);
  // Шість сусідів у порядку: E, NE, NW, W, SW, SE
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  // Ребро i (між кутами i та i+1 з corners()) виходить на сусіда EDGE_DIRS[i]
  const EDGE_DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

  const Hex = {
    SQRT3,
    DIRS,
    EDGE_DIRS,

    key(q, r) { return q + ',' + r; },

    parse(key) {
      const i = key.indexOf(',');
      return { q: +key.slice(0, i), r: +key.slice(i + 1) };
    },

    neighborKeys(key) {
      const { q, r } = Hex.parse(key);
      return DIRS.map(d => Hex.key(q + d[0], r + d[1]));
    },

    edgeNeighborKey(key, edge) {
      const { q, r } = Hex.parse(key);
      const d = EDGE_DIRS[edge];
      return Hex.key(q + d[0], r + d[1]);
    },

    distance(a, b) {
      const dq = a.q - b.q, dr = a.r - b.r;
      return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
    },

    // Центр гекса в пікселях (без зсуву)
    toPixel(q, r, size) {
      return { x: size * SQRT3 * (q + r / 2), y: size * 1.5 * r };
    },

    fromPixel(x, y, size) {
      const qf = (SQRT3 / 3 * x - y / 3) / size;
      const rf = (2 / 3 * y) / size;
      return Hex.round(qf, rf);
    },

    round(qf, rf) {
      const sf = -qf - rf;
      let q = Math.round(qf), r = Math.round(rf), s = Math.round(sf);
      const dq = Math.abs(q - qf), dr = Math.abs(r - rf), ds = Math.abs(s - sf);
      if (dq > dr && dq > ds) q = -r - s;
      else if (dr > ds) r = -q - s;
      return { q, r };
    },

    // Шість кутів: -30°, 30°, 90°, 150°, 210°, 270° (y вниз)
    corners(cx, cy, size) {
      const pts = [];
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        pts.push([cx + size * Math.cos(a), cy + size * Math.sin(a)]);
      }
      return pts;
    },

    // Прямокутна сітка (odd-r offset) → осьові координати
    offsetToAxial(col, row) {
      return { q: col - ((row - (row & 1)) >> 1), r: row };
    },
  };

  global.Hex = Hex;
})(window);
