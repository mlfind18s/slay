/* Малювання карти на canvas. Нічого не змінює у стані гри.
 * draw(ui) отримує стан інтерфейсу:
 *   { selTerritory: territory|null, selUnit: key|null, targets: Set<key>,
 *     hover: key|null, placing: {type,level}|null }
 */
(function (global) {
  'use strict';

  const Hex = global.Hex;
  // Колір юніта за рівнем: селянин, списник, лицар, барон
  const LEVEL_COLORS = ['', '#2fc24a', '#2f6fe8', '#15151c', '#e3261f'];
  const SEA = '#16202c';
  const NEUTRAL = '#6b7280';

  function shade(hex, amount) {
    // hex '#rrggbb' → освітлити (amount > 0) або затемнити (amount < 0)
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v + (amount > 0 ? (255 - v) : v) * amount))));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  class Renderer {
    constructor(canvas, game) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = window.devicePixelRatio || 1;
      this.w = 0; this.h = 0; this.size = 20; this.ox = 0; this.oy = 0;
      this.setGame(game);
    }

    setGame(game) { this.game = game; this.fit(); }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.w = Math.max(1, rect.width);
      this.h = Math.max(1, rect.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.fit();
    }

    fit() {
      if (!this.game || !this.w) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k in this.game.hexes) {
        const h = this.game.hexes[k];
        const p = Hex.toPixel(h.q, h.r, 1);
        minX = Math.min(minX, p.x - Hex.SQRT3 / 2); maxX = Math.max(maxX, p.x + Hex.SQRT3 / 2);
        minY = Math.min(minY, p.y - 1); maxY = Math.max(maxY, p.y + 1);
      }
      if (!isFinite(minX)) return;
      const bw = maxX - minX, bh = maxY - minY, pad = 16;
      this.size = Math.max(4, Math.min((this.w - pad * 2) / bw, (this.h - pad * 2) / bh));
      this.ox = (this.w - bw * this.size) / 2 - minX * this.size;
      this.oy = (this.h - bh * this.size) / 2 - minY * this.size;
    }

    center(key) {
      const { q, r } = Hex.parse(key);
      const p = Hex.toPixel(q, r, this.size);
      return { x: p.x + this.ox, y: p.y + this.oy };
    }

    hexAt(px, py) {
      const { q, r } = Hex.fromPixel(px - this.ox, py - this.oy, this.size);
      const k = Hex.key(q, r);
      return this.game.hexes[k] ? k : null;
    }

    polygon(ctx, key, scale = 1) {
      const c = this.center(key);
      const pts = Hex.corners(c.x, c.y, this.size * scale);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < 6; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    }

    draw(ui) {
      const ctx = this.ctx, g = this.game, s = this.size;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = SEA;
      ctx.fillRect(0, 0, this.w, this.h);
      if (!g) return;

      const hexes = g.hexes;
      const inSel = new Set(ui.selTerritory ? ui.selTerritory.hexes : []);

      // 1. Заливка
      for (const k in hexes) {
        const h = hexes[k];
        const base = h.owner >= 0 ? g.players[h.owner].color : NEUTRAL;
        const isCurrent = h.owner === g.current && !g.over;
        let fill = base;
        if (h.tree || h.grave) fill = shade(base, isCurrent ? -0.04 : -0.16);
        else if (isCurrent) fill = shade(base, 0.12);
        this.polygon(ctx, k);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.22)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // 2. Кордони територій
      ctx.lineCap = 'round';
      for (const k in hexes) {
        const h = hexes[k];
        const c = this.center(k);
        const pts = Hex.corners(c.x, c.y, s);
        for (let e = 0; e < 6; e++) {
          const n = hexes[Hex.edgeNeighborKey(k, e)];
          if (n && n.owner === h.owner) continue;
          ctx.beginPath();
          ctx.moveTo(pts[e][0], pts[e][1]);
          ctx.lineTo(pts[(e + 1) % 6][0], pts[(e + 1) % 6][1]);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.lineWidth = Math.max(1.5, s * 0.09);
          ctx.stroke();
        }
      }

      // 3. Виділена територія
      if (inSel.size) {
        for (const k of inSel) {
          const c = this.center(k);
          const pts = Hex.corners(c.x, c.y, s);
          for (let e = 0; e < 6; e++) {
            const nk = Hex.edgeNeighborKey(k, e);
            if (inSel.has(nk)) continue;
            ctx.beginPath();
            ctx.moveTo(pts[e][0], pts[e][1]);
            ctx.lineTo(pts[(e + 1) % 6][0], pts[(e + 1) % 6][1]);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = Math.max(2, s * 0.14);
            ctx.stroke();
          }
        }
      }

      // 4. Наведення
      if (ui.hover && hexes[ui.hover]) {
        this.polygon(ctx, ui.hover);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fill();
      }

      // 5. Вміст гексів
      for (const k in hexes) {
        const h = hexes[k];
        const c = this.center(k);
        if (h.tree === 'pine') this.drawPine(ctx, c.x, c.y, s);
        else if (h.tree === 'palm') this.drawPalm(ctx, c.x, c.y, s);
        if (h.grave) this.drawGrave(ctx, c.x, c.y, s);
        if (h.castle) this.drawCastle(ctx, c.x, c.y, s, h.name);
        if (h.capital) this.drawCapital(ctx, c.x, c.y, s, h.money, h.name);
        if (h.unit) {
          // юніти поточного гравця, що ще не ходили, злегка підстрибують
          let bounce = 0;
          if (ui.animate && !g.over && h.owner === g.current && !h.unit.moved) {
            const phase = h.q * 0.9 + h.r * 1.7;
            bounce = Math.abs(Math.sin((ui.time || 0) / 260 + phase)) * s * 0.14;
          }
          this.drawUnit(ctx, c.x, c.y, s, h.unit, h.capital, bounce);
        }
      }

      // 6. Виділений юніт і цілі
      if (ui.selUnit && hexes[ui.selUnit]) {
        const c = this.center(ui.selUnit);
        ctx.beginPath();
        ctx.arc(c.x, c.y, s * 0.78, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(2, s * 0.1);
        ctx.stroke();
      }
      if (ui.targets && ui.targets.size) {
        for (const k of ui.targets) {
          const h = hexes[k];
          if (!h) continue;
          const c = this.center(k);
          const enemy = h.owner !== g.current;
          ctx.beginPath();
          ctx.arc(c.x, c.y, s * 0.2, 0, Math.PI * 2);
          ctx.fillStyle = enemy ? 'rgba(255,60,60,0.9)' : 'rgba(255,255,255,0.9)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }

    // ---------- Іконки ----------

    drawUnit(ctx, cx, cy, s, unit, onCapital, bounce = 0) {
      const col = LEVEL_COLORS[Math.min(unit.level, LEVEL_COLORS.length - 1)];
      if (onCapital) { cx += s * 0.3; cy -= s * 0.1; }
      cy -= bounce;
      ctx.save();
      ctx.globalAlpha = unit.moved ? 0.55 : 1;
      // світлий диск-підкладка, щоб юніт читався на будь-якому кольорі гекса
      ctx.beginPath();
      ctx.arc(cx, cy + s * 0.02, s * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.93)';
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, s * 0.07);
      ctx.strokeStyle = '#111';
      ctx.stroke();
      ctx.lineWidth = Math.max(1, s * 0.05);
      // тіло
      const bw = s * 0.5, bh = s * 0.46, bx = cx - bw / 2, by = cy - s * 0.02;
      ctx.beginPath();
      ctx.moveTo(bx, by + bh);
      ctx.lineTo(bx, by + bh * 0.35);
      ctx.quadraticCurveTo(bx, by, cx, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + bh * 0.35);
      ctx.lineTo(bx + bw, by + bh);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill(); ctx.stroke();
      // голова
      ctx.beginPath();
      ctx.arc(cx, cy - s * 0.22, s * 0.17, 0, Math.PI * 2);
      ctx.fillStyle = '#f3d6b3';
      ctx.fill(); ctx.stroke();
      // корона для барона
      if (unit.level >= 4) {
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.18, cy - s * 0.34);
        ctx.lineTo(cx - s * 0.12, cy - s * 0.52);
        ctx.lineTo(cx, cy - s * 0.4);
        ctx.lineTo(cx + s * 0.12, cy - s * 0.52);
        ctx.lineTo(cx + s * 0.18, cy - s * 0.34);
        ctx.closePath();
        ctx.fillStyle = '#ffd54a';
        ctx.fill(); ctx.stroke();
      }
      // рівень: білий з темною обводкою — видно і на чорному лицарі
      ctx.font = `bold ${Math.round(s * 0.34)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, s * 0.12);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(String(unit.level), cx, cy + s * 0.24);
      ctx.fillStyle = '#fff';
      ctx.fillText(String(unit.level), cx, cy + s * 0.24);
      ctx.restore();
    }

    // Підпис (назва міста чи замку) з темною обводкою; ховається на дрібних гексах
    drawLabel(ctx, text, x, y, s, baseline) {
      if (!text || s < 13) return;
      const shown = text.length > 14 ? text.slice(0, 13) + '…' : text;
      ctx.save();
      ctx.font = `600 ${Math.round(s * 0.3)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = baseline;
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, s * 0.1);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(shown, x, y);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText(shown, x, y);
      ctx.restore();
    }

    drawCapital(ctx, cx, cy, s, money, name) {
      this.drawLabel(ctx, name, cx, cy - s * 0.4, s, 'bottom');
      ctx.save();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#2a1a12';
      const w = s * 0.62, h = s * 0.36, x = cx - w / 2, y = cy - s * 0.02;
      ctx.fillStyle = '#f4e9d6';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      ctx.beginPath();
      ctx.moveTo(x - s * 0.06, y);
      ctx.lineTo(cx, y - s * 0.34);
      ctx.lineTo(x + w + s * 0.06, y);
      ctx.closePath();
      ctx.fillStyle = '#8a3d2c';
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#5a3a2a';
      ctx.fillRect(cx - s * 0.08, y + h * 0.4, s * 0.16, h * 0.6);
      // скарбниця
      ctx.font = `bold ${Math.round(s * 0.34)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(String(money), cx, y + h + s * 0.04);
      ctx.fillStyle = '#fff';
      ctx.fillText(String(money), cx, y + h + s * 0.04);
      ctx.restore();
    }

    drawCastle(ctx, cx, cy, s, name) {
      this.drawLabel(ctx, name, cx, cy + s * 0.38, s, 'top');
      ctx.save();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = '#1c2026';
      const w = s * 0.66, h = s * 0.58, x = cx - w / 2, y = cy - h * 0.45;
      ctx.fillStyle = '#a4adb8';
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      const tw = w / 5;
      for (let i = 0; i < 5; i += 2) {
        ctx.fillRect(x + i * tw, y - s * 0.14, tw, s * 0.14);
        ctx.strokeRect(x + i * tw, y - s * 0.14, tw, s * 0.14);
      }
      ctx.fillStyle = '#2b2f36';
      ctx.beginPath();
      ctx.arc(cx, y + h * 0.62, s * 0.12, Math.PI, 0);
      ctx.lineTo(cx + s * 0.12, y + h);
      ctx.lineTo(cx - s * 0.12, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    drawPine(ctx, cx, cy, s) {
      ctx.save();
      ctx.fillStyle = '#5a3a1e';
      ctx.fillRect(cx - s * 0.06, cy + s * 0.2, s * 0.12, s * 0.22);
      ctx.strokeStyle = '#0d3a18';
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const top = cy - s * 0.5 + i * s * 0.2, wid = s * (0.22 + i * 0.12), base = top + s * 0.34;
        ctx.beginPath();
        ctx.moveTo(cx, top);
        ctx.lineTo(cx + wid, base);
        ctx.lineTo(cx - wid, base);
        ctx.closePath();
        ctx.fillStyle = i % 2 ? '#2a8a3e' : '#1f6b30';
        ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }

    drawPalm(ctx, cx, cy, s) {
      ctx.save();
      ctx.strokeStyle = '#7a5230';
      ctx.lineWidth = Math.max(1.5, s * 0.1);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.05, cy + s * 0.45);
      ctx.quadraticCurveTo(cx + s * 0.02, cy, cx + s * 0.12, cy - s * 0.3);
      ctx.stroke();
      ctx.strokeStyle = '#2fa64f';
      ctx.lineWidth = Math.max(1.5, s * 0.09);
      const tx = cx + s * 0.12, ty = cy - s * 0.3;
      for (const a of [-160, -120, -60, -20, 20]) {
        const rad = a * Math.PI / 180;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.quadraticCurveTo(tx + Math.cos(rad) * s * 0.3, ty + Math.sin(rad) * s * 0.3 - s * 0.15,
          tx + Math.cos(rad) * s * 0.42, ty + Math.sin(rad) * s * 0.42 + s * 0.1);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawGrave(ctx, cx, cy, s) {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#2b2f36';
      const w = s * 0.44, h = s * 0.5, x = cx - w / 2, y = cy - h * 0.4;
      ctx.beginPath();
      ctx.moveTo(x, y + h);
      ctx.lineTo(x, y + w / 2);
      ctx.arc(cx, y + w / 2, w / 2, Math.PI, 0);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      ctx.fillStyle = '#b9bec7';
      ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#3a3f47';
      ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.beginPath();
      ctx.moveTo(cx, y + s * 0.1); ctx.lineTo(cx, y + s * 0.36);
      ctx.moveTo(cx - s * 0.1, y + s * 0.18); ctx.lineTo(cx + s * 0.1, y + s * 0.18);
      ctx.stroke();
      ctx.restore();
    }
  }

  Renderer.LEVEL_COLORS = LEVEL_COLORS;
  global.Renderer = Renderer;
})(window);
