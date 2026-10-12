/* Комп'ютерний гравець. Жадібний AI з рівнями складності + гачки для власних стратегій.
 *
 * Рівень складності задається кожному гравцю: new Game({ players: ['human', 'ai:easy', 'ai:hard'] }).
 * Параметри рівнів — AI.levels (можна правити з консолі: Slay.AI.levels.hard.noise = 1).
 *
 * Свій AI для гравця N:  AI.custom[N] = (game, playerId, params) => { ...дії... }
 * Дії робляться через API Game (moveUnit / buyUnit / buildCastle), а
 * endTurn() викликає той, хто запускає AI (main.js або AI.simulate).
 *
 * Безголовий прогін:  AI.simulate({ players: ['ai:easy','ai:hard','ai'], seed: 1 })
 */
(function (global) {
  'use strict';

  const Hex = global.Hex;

  const AI = {
    custom: {},
    maxActions: 400,

    /* Параметри рівнів:
     *  noise         — випадковий шум в оцінці цілей (більше = дурніший вибір)
     *  maxUnitLevel  — вище цього рівня юнітів не купує й не підсилює
     *  castles       — чи будує замки
     *  idleChance    — шанс «проспати» хід (лише рубає дерева)
     *  bufferTurns   — скільки ходів мінусу дозволяє економіка при купівлі
     *  buyToAttack   — чи купує юнітів одразу на ворожий гекс і чи підсилює для атаки
     *  defendCapital — чи прикриває столицю, коли сусід може її взяти
     *  bonusMoney    — фора: монет на кожну територію на початку ходу (чесний AI = 0)
     */
    levels: {
      easy:   { noise: 7,   maxUnitLevel: 2, castles: false, idleChance: 0.45, bufferTurns: 0, buyToAttack: true, defendCapital: false, bonusMoney: 0 },
      normal: { noise: 0,   maxUnitLevel: 4, castles: true,  idleChance: 0,   bufferTurns: 3, buyToAttack: true,  defendCapital: false, bonusMoney: 0 },
      hard:   { noise: 0,   maxUnitLevel: 4, castles: true,  idleChance: 0,   bufferTurns: 3, buyToAttack: true,  defendCapital: true,  bonusMoney: 2 },
    },
    levelNames: { easy: 'легкий', normal: 'середній', hard: 'важкий' },

    paramsFor(game, playerId) {
      const p = game.players[playerId];
      return AI.levels[p && p.level] || AI.levels.normal;
    },

    run(game, playerId) {
      const params = AI.paramsFor(game, playerId);
      if (params.bonusMoney) {
        for (const t of game.territories())
          if (t.owner === playerId && t.size >= 2 && t.capital) game.hexes[t.capital].money += params.bonusMoney;
        game.invalidate();
      }
      const fn = AI.custom[playerId] || AI.greedy;
      fn(game, playerId, params);
    },

    // ---------- Допоміжне ----------

    // Чи роз'єднає територію t вилучення гекса key
    splits(game, t, key) {
      const rest = new Set(t.hexes.filter(k => k !== key));
      if (rest.size < 2) return false;
      const first = rest.values().next().value;
      const seen = new Set([first]), stack = [first];
      while (stack.length) {
        const c = stack.pop();
        for (const n of Hex.neighborKeys(c)) if (rest.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
      return seen.size < rest.size;
    },

    treeNeighbors(game, key) {
      let n = 0;
      for (const k of Hex.neighborKeys(key)) { const h = game.hexes[k]; if (h && h.tree) n++; }
      return n;
    },

    // Найвищий рівень, який можна купити за money
    affordableLevel(game, money) {
      const R = game.rules;
      let best = 0;
      for (let l = 1; l <= R.maxLevel; l++) if (R.unitCost[l] <= money) best = l;
      return best;
    },

    // Оцінка захоплення гекса `to` юнітом рівня `level`
    attackScore(game, me, to, level) {
      const h = game.hexes[to];
      const et = game.territoryOf(to);
      let s = 1;
      if (h.capital) s += 5 + h.money / 8;
      if (h.unit) s += h.unit.level * 2.5;
      if (h.castle) s += 2;
      if (h.tree) s -= 0.2;
      if (et && et.size >= 3 && AI.splits(game, et, to)) s += 3;
      let mine = 0, threat = 0;
      for (const n of Hex.neighborKeys(to)) {
        const nh = game.hexes[n];
        if (!nh) continue;
        if (nh.owner === me) mine++;
        else if (nh.unit && nh.unit.level > level) threat++;
      }
      s += mine * 0.2 - threat * 0.8 - level * 0.15;
      return s;
    },

    // Чи витримає скарбниця нову платню
    sustainable(game, t, eco, addWage, cost, bufferTurns = 3) {
      const R = game.rules;
      const money = t.money - cost;
      if (money < 0) return false;
      const net = eco.income + R.incomePerHex - (eco.wages + addWage);
      return net >= 0 || money >= -net * bufferTurns;
    },

    // ---------- Захист столиці (важкий рівень) ----------

    /* Якщо сусідня ворожа територія має (або може купити) юніта, здатного взяти
     * столицю, підняти її захист: замком поруч, юнітом на столиці або поруч. */
    defendCapitals(game, me, P) {
      const R = game.rules;
      const maxLvl = Math.min(R.maxLevel, P.maxUnitLevel || R.maxLevel);
      for (const t of game.territories()) {
        if (t.owner !== me || t.size < 2 || !t.capital) continue;
        // дрібну й бідну столицю захищати дорожче, ніж втратити
        if (t.money + t.size < (P.defendValue || 20)) continue;
        const capKey = t.capital;
        let threat = 0;
        for (const n of Hex.neighborKeys(capKey)) {
          const nh = game.hexes[n];
          if (!nh || nh.owner === me) continue;
          const et = game.territoryOf(n);
          if (!et || et.size < 2) continue;
          let best = 0;
          for (const k of et.hexes) { const u = game.hexes[k].unit; if (u) best = Math.max(best, u.level); }
          const buy = AI.affordableLevel(game, et.money);
          const upgrade = best ? Math.min(R.maxLevel, best + buy) : 0;
          threat = Math.max(threat, best, buy, upgrade);
        }
        threat = Math.min(threat, R.maxLevel);
        if (threat <= game.defense(capKey)) continue;
        const need = threat;

        // A. замок поруч зі столицею
        if (P.castles && need <= R.castleStrength && t.money >= R.castleCost) {
          const spots = game.castleTargets(capKey).filter(k => Hex.neighborKeys(capKey).includes(k));
          if (spots.length) { game.buildCastle(capKey, spots[0]); continue; }
        }
        // B. перемістити наявного юніта потрібного рівня на столицю
        const cap = game.hexes[capKey];
        let moved = false;
        if (!cap.unit) {
          for (const k of t.hexes) {
            const u = game.hexes[k].unit;
            if (!u || u.moved || u.level < need || k === capKey) continue;
            if (game.legalMoves(k).includes(capKey)) { game.moveUnit(k, capKey); moved = true; break; }
          }
        }
        if (moved) continue;
        // C. купити (або докупити) юніта на столицю
        const have = cap.unit ? cap.unit.level : 0;
        const add = need - have;
        if (add <= 0 || need > maxLvl) continue;
        const eco = game.economy(t);
        const cost = R.unitCost[add];
        const addWage = R.unitWage[need] - (have ? R.unitWage[have] : 0);
        if (AI.sustainable(game, t, eco, addWage, cost, P.bufferTurns) && game.buyTargets(capKey, add).includes(capKey)) {
          game.buyUnit(capKey, add, capKey);
        }
      }
    },

    // ---------- Основна стратегія ----------

    greedy(game, playerId, P = AI.levels.normal) {
      const R = game.rules;
      const maxLvl = Math.min(R.maxLevel, P.maxUnitLevel || R.maxLevel);
      const noise = () => (P.noise ? (game.rng.next() - 0.5) * 2 * P.noise : 0);
      const score = (to, level) => AI.attackScore(game, playerId, to, level) + noise();
      const idle = P.idleChance > 0 && game.rng.next() < P.idleChance;
      let actions = 0;

      if (!idle && P.defendCapital) AI.defendCapitals(game, playerId, P);

      // 1. Захоплення: наявними юнітами, купівлею напряму, або підсиленням юніта
      while (!idle && actions++ < AI.maxActions && !game.over) {
        let best = null;
        const consider = (s, act) => { if (!best || s > best.score) best = { score: s, act }; };

        for (const t of game.territories()) {
          if (t.owner !== playerId || t.size < 2) continue;
          const eco = game.economy(t);

          for (const from of t.hexes) {
            const h = game.hexes[from];
            if (!h.unit || h.unit.moved) continue;
            const lvl = h.unit.level;
            for (const to of game.legalMoves(from)) {
              if (game.hexes[to].owner === playerId) continue;
              consider(score(to, lvl), () => game.moveUnit(from, to));
            }
            // підсилити юніт, щоб узяти сильнішу ціль
            for (let add = 1; P.buyToAttack !== false && lvl + add <= maxLvl; add++) {
              const cost = R.unitCost[add];
              if (!AI.sustainable(game, t, eco, R.unitWage[lvl + add] - R.unitWage[lvl], cost, P.bufferTurns)) continue;
              const newLvl = lvl + add;
              for (const to of game.borderTargets(t)) {
                const d = game.defense(to);
                if (d < lvl || d >= newLvl) continue;
                consider(score(to, newLvl) - add * 0.6,
                  () => { game.buyUnit(from, add, from); game.moveUnit(from, to); });
              }
            }
          }

          for (let level = 1; P.buyToAttack !== false && level <= maxLvl; level++) {
            const cost = R.unitCost[level];
            if (t.money < cost || !AI.sustainable(game, t, eco, R.unitWage[level], cost, P.bufferTurns)) continue;
            const anchor = t.capital;
            for (const to of game.buyTargets(anchor, level)) {
              if (game.hexes[to].owner === playerId) continue;
              consider(score(to, level) - level * 0.5, () => game.buyUnit(anchor, level, to));
            }
          }
        }

        if (!best || best.score <= 0) break;
        best.act();
      }
      if (game.over) return;

      // 2. Замки на загрозливому кордоні, коли є запас грошей
      if (!idle && P.castles) {
        for (const t of game.territories()) {
          if (t.owner !== playerId || t.size < 5 || t.money < R.castleCost + 10) continue;
          let best = null;
          for (const k of game.castleTargets(t.capital)) {
            if (game.defense(k) >= R.castleStrength) continue;
            let threat = 0;
            for (const n of Hex.neighborKeys(k)) {
              const nh = game.hexes[n];
              if (!nh || nh.owner === playerId) continue;
              const nt = game.territoryOf(n);
              threat += 1 + (nh.unit ? nh.unit.level : 0) + (nt && nt.size >= 2 ? nt.money / 20 : 0);
            }
            if (threat > 0 && (!best || threat > best.threat)) best = { k, threat };
          }
          if (best && best.threat >= 2) game.buildCastle(t.capital, best.k);
        }
      }

      // 3. Вільні юніти: рубати дерева, інакше — на слабкий кордон
      for (const t of game.territories()) {
        if (t.owner !== playerId || t.size < 2) continue;
        const enemyAdjacent = new Set();
        for (const k of t.hexes)
          if (Hex.neighborKeys(k).some(n => game.hexes[n] && game.hexes[n].owner !== playerId)) enemyAdjacent.add(k);

        for (const from of t.hexes) {
          const h = game.hexes[from];
          if (!h.unit || h.unit.moved) continue;
          const moves = game.legalMoves(from).filter(k => game.hexes[k].owner === playerId);
          const tree = moves.find(k => game.hexes[k].tree || game.hexes[k].grave);
          if (tree) { game.moveUnit(from, tree); continue; }
          if (idle || enemyAdjacent.has(from)) continue;
          let dest = null, bestDef = Infinity;
          for (const k of moves) {
            if (!enemyAdjacent.has(k) || game.hexes[k].unit) continue;
            const d = game.defense(k);
            if (d < bestDef) { bestDef = d; dest = k; }
          }
          if (dest && bestDef < h.unit.level) game.moveUnit(from, dest);
        }
      }

      // 4. Дерева з'їдають дохід: купити селянина прямо на дерево (це його рубає)
      for (const t of game.territories()) {
        if (t.owner !== playerId || t.size < 2) continue;
        for (let bought = 0; bought < 2; bought++) {
          const eco = game.economy(t);
          if (!AI.sustainable(game, t, eco, R.unitWage[1], R.unitCost[1], P.bufferTurns)) break;
          const trees = t.hexes.filter(k => game.hexes[k].tree || game.hexes[k].grave);
          if (trees.length < 2) break;
          trees.sort((a, b) => AI.treeNeighbors(game, b) - AI.treeNeighbors(game, a));
          game.buyUnit(t.capital, 1, trees[0]);
        }
      }

      // 5. Зайві гроші: селянин у резерв, якщо економіка дозволяє
      if (idle) return;
      for (const t of game.territories()) {
        if (t.owner !== playerId || t.size < 2) continue;
        const eco = game.economy(t);
        let units = 0;
        for (const k of t.hexes) if (game.hexes[k].unit) units++;
        if (units * 3 >= t.size || t.money < R.unitCost[1] + 5) continue;
        if (eco.income - eco.wages - R.unitWage[1] < 2) continue;
        const spots = game.buyTargets(t.capital, 1).filter(k => { const h = game.hexes[k]; return h.owner === playerId && !h.unit && !h.tree && !h.grave; });
        if (spots.length) game.buyUnit(t.capital, 1, game.rng.pick(spots));
      }
    },

    /* Прогін гри без інтерфейсу. Повертає { winner, rounds, game }.
     * opts як у new Game(); усі гравці керуються AI свого рівня (AI.custom або greedy). */
    simulate(opts = {}) {
      const Game = global.Game;
      const maxRounds = opts.maxRounds || 300;
      const g = new Game(Object.assign({ players: ['ai', 'ai', 'ai', 'ai'] }, opts));
      while (!g.over && g.round <= maxRounds) {
        AI.run(g, g.current);
        g.endTurn();
      }
      return { winner: g.winner, rounds: g.round, game: g };
    },
  };

  global.AI = AI;
})(window);
