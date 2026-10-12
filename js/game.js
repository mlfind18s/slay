/* Правила гри Slay. Чиста логіка стану без DOM — зручно для експериментів.
 *
 * Стан: game.hexes — об'єкт { "q,r": hex }, де hex =
 *   { q, r, owner (-1 = нічия), unit: null | {level, moved}, capital, money,
 *     castle, tree: null | 'pine' | 'palm', grave }
 * Гроші зберігаються на гексі столиці (capital === true).
 *
 * Територія — зв'язна група гексів одного власника. Діяти може лише
 * територія з 2+ гексів (має столицю та скарбницю).
 *
 * API для дій поточного гравця:
 *   legalMoves(fromKey) / moveUnit(fromKey, toKey)
 *   buyTargets(anchorKey, level) / buyUnit(anchorKey, level, toKey)
 *   castleTargets(anchorKey) / buildCastle(anchorKey, toKey)
 *   endTurn()
 * anchorKey — будь-який гекс потрібної території.
 */
(function (global) {
  'use strict';

  const Hex = global.Hex;

  // Усі числові правила зібрані тут — змінюйте для експериментів
  // (Slay.RULES у консолі або opts.rules у new Game()).
  const RULES = {
    maxLevel: 4,
    unitCost: [0, 10, 20, 30, 40],      // ціна юніта за рівнем
    unitWage: [0, 2, 6, 18, 54],        // платня за хід
    castleCost: 15,
    castleStrength: 2,
    capitalStrength: 1,
    incomePerHex: 1,                    // дохід з гекса без дерева/могили
    startMoney: 10,                     // стартова скарбниця кожної столиці
    incomeOnFirstRound: false,          // у першому раунді доходу нема: усі починають з startMoney
    moveTiresUnit: true,                // будь-яке переміщення втомлює юніта (один хід за раунд)
    mergeTiresUnit: false,              // об'єднання юнітів втомлює результат
    boughtUnitCanMove: false,           // щойно куплений юніт може ходити того ж ходу
    treeRatio: 0.08,                    // частка дерев на старті
    pineNeighborsToSpread: 2,           // сосна росте, якщо поруч ≥ N сосен
    pineSpreadChance: 0.2,
    palmSpreadChance: 0.15,             // пальма росте на березі поруч з пальмою
    graveBecomesTree: true,
    singleHexKillsUnit: true,           // юніт на самотньому гексі гине
    allowBuyAnyLevel: true,             // купувати одразу списника/лицаря/барона
  };

  const UNIT_NAMES = ['', 'Селянин', 'Списник', 'Лицар', 'Барон'];
  const PLAYER_NAMES = ['Червоні', 'Сині', 'Зелені', 'Жовті', 'Фіолетові', 'Помаранчеві'];
  const PLAYER_COLORS = ['#e0483a', '#3b7ddd', '#3fae4a', '#e2c23c', '#a561d8', '#f08a24'];

  // Детермінований генератор (mulberry32) зі станом, який можна зберегти
  function makeRng(seed) {
    const rng = {
      state: seed >>> 0,
      next() {
        let t = (rng.state = (rng.state + 0x6D2B79F5) >>> 0);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      int(n) { return Math.floor(rng.next() * n); },
      pick(arr) { return arr[Math.floor(rng.next() * arr.length)]; },
      shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(rng.next() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      },
    };
    return rng;
  }

  const ok = () => ({ ok: true });
  const fail = (error) => ({ ok: false, error });

  class Game {
    /* opts: { players: ['human','ai',...], seed, width, height, landRatio,
     *         clumping, rules: {...} } */
    constructor(opts = {}) {
      this.rules = Object.assign({}, RULES, opts.rules || {});
      this.seed = (opts.seed ?? Math.floor(Math.random() * 0x7fffffff)) >>> 0;
      this.rng = makeRng(this.seed);
      const specs = opts.players || ['human', 'ai', 'ai', 'ai', 'ai', 'ai'];
      this.players = specs.map((spec, i) => {
        const p = Game.parsePlayer(spec);
        return {
          id: i, kind: p.kind, level: p.level, alive: true,
          name: PLAYER_NAMES[i] || 'Гравець ' + (i + 1),
          color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        };
      });
      this.width = opts.width || 20;
      this.height = opts.height || 14;
      this.hexes = {};
      this.current = 0;
      this.round = 1;
      this.over = false;
      this.winner = null;
      this.log = [];
      this._terr = null;
      this.generateMap(opts);
      this.startTurn();
    }

    // ---------- Генерація карти ----------

    generateMap(opts) {
      const W = this.width, H = this.height, N = this.players.length;
      const landCount = Math.max(N * 4, Math.round(W * H * (opts.landRatio ?? 0.62)));
      const inBounds = new Set();
      for (let row = 0; row < H; row++)
        for (let col = 0; col < W; col++) {
          const { q, r } = Hex.offsetToAxial(col, row);
          inBounds.add(Hex.key(q, r));
        }

      // Острів росте від центру випадковими «пагонами»
      const start = Hex.offsetToAxial(W >> 1, H >> 1);
      const startKey = Hex.key(start.q, start.r);
      const land = new Set([startKey]);
      const landArr = [startKey];
      const recent = [startKey];
      let guard = 0;
      while (land.size < landCount && land.size < inBounds.size && guard++ < 200000) {
        const src = this.rng.next() < 0.5 ? this.rng.pick(recent) : this.rng.pick(landArr);
        const nk = this.rng.pick(Hex.neighborKeys(src));
        if (!inBounds.has(nk) || land.has(nk)) continue;
        land.add(nk); landArr.push(nk); recent.push(nk);
        if (recent.length > 12) recent.shift();
      }

      for (const k of landArr) {
        const { q, r } = Hex.parse(k);
        this.hexes[k] = { q, r, owner: -1, unit: null, capital: false, money: 0, castle: false, tree: null, grave: false, name: '' };
      }

      // Власники: випадково + кілька проходів «злипання», з перевіркою балансу
      const passes = opts.clumping ?? 2;
      for (let attempt = 0; attempt < 30; attempt++) {
        for (const k of landArr) this.hexes[k].owner = this.rng.int(N);
        for (let p = 0; p < passes; p++) {
          for (const k of this.rng.shuffle(landArr)) {
            if (this.rng.next() < 0.4) {
              const nb = this.landNeighbors(k);
              if (nb.length) this.hexes[k].owner = this.hexes[this.rng.pick(nb)].owner;
            }
          }
        }
        this.invalidate();
        const counts = this.hexCounts();
        const everyoneCanAct = this.players.every(p => this.territories().some(t => t.owner === p.id && t.size >= 2));
        const balanced = Math.max(...counts) <= 2 * Math.max(1, Math.min(...counts));
        if (everyoneCanAct && (balanced || attempt > 20)) break;
      }

      // Дерева: пальми на березі, сосни всередині
      for (const k of landArr) {
        if (this.rng.next() < this.rules.treeRatio) this.hexes[k].tree = this.isCoastal(k) ? 'palm' : 'pine';
      }

      // Столиці та стартові гроші
      for (const p of this.players) this.normalize(p.id);
      for (const t of this.territories()) {
        if (t.capital) this.hexes[t.capital].money = this.rules.startMoney;
      }
      this.invalidate();
    }

    // ---------- Допоміжне ----------

    invalidate() { this._terr = null; }

    landNeighbors(key) { return Hex.neighborKeys(key).filter(n => this.hexes[n]); }

    isCoastal(key) { return Hex.neighborKeys(key).some(n => !this.hexes[n]); }

    hexCounts() {
      const counts = new Array(this.players.length).fill(0);
      for (const k in this.hexes) { const o = this.hexes[k].owner; if (o >= 0) counts[o]++; }
      return counts;
    }

    playerName(id) { return id >= 0 && this.players[id] ? this.players[id].name : 'Нічия'; }

    logMsg(msg) {
      this.log.push({ round: this.round, player: this.current, msg });
      if (this.log.length > 300) this.log.shift();
    }

    // ---------- Території ----------

    /* Повертає масив { id, owner, hexes: [keys], size, capital: key|null, money }.
     * Кешується до наступної зміни стану; не тримайте посилання довго —
     * після дії беріть територію знову через territoryOf(anchorKey). */
    territories() {
      if (this._terr) return this._terr.list;
      const seen = new Set(), list = [], byKey = {};
      for (const k in this.hexes) {
        if (seen.has(k)) continue;
        const owner = this.hexes[k].owner;
        const stack = [k], keys = [];
        seen.add(k);
        while (stack.length) {
          const c = stack.pop();
          keys.push(c);
          for (const n of Hex.neighborKeys(c)) {
            const h = this.hexes[n];
            if (h && !seen.has(n) && h.owner === owner) { seen.add(n); stack.push(n); }
          }
        }
        const t = { id: list.length, owner, hexes: keys, size: keys.length, capital: null, money: 0 };
        for (const kk of keys) {
          if (this.hexes[kk].capital) { t.capital = kk; t.money = this.hexes[kk].money; }
          byKey[kk] = t;
        }
        list.push(t);
      }
      this._terr = { list, byKey };
      return list;
    }

    territoryOf(key) { this.territories(); return this._terr.byKey[key] || null; }

    // Гекси інших власників, суміжні з територією
    borderTargets(t) {
      const out = new Set();
      for (const k of t.hexes)
        for (const n of Hex.neighborKeys(k)) {
          const h = this.hexes[n];
          if (h && h.owner !== t.owner) out.add(n);
        }
      return [...out];
    }

    // Після зміни власників: столиці, злиття скарбниць, самотні гекси
    normalize(owner) {
      this.invalidate();
      for (const t of this.territories()) {
        if (t.owner !== owner) continue;
        if (t.size < 2) {
          for (const k of t.hexes) {
            const h = this.hexes[k];
            if (h.capital) { h.capital = false; h.money = 0; h.name = ''; }
            if (h.unit && this.rules.singleHexKillsUnit) { h.unit = null; h.grave = true; }
          }
          continue;
        }
        const caps = t.hexes.filter(k => this.hexes[k].capital);
        if (caps.length === 1) continue;
        if (caps.length > 1) {
          caps.sort((a, b) => this.hexes[b].money - this.hexes[a].money);
          const keep = this.hexes[caps[0]];
          for (let i = 1; i < caps.length; i++) {
            const h = this.hexes[caps[i]];
            keep.money += h.money; h.money = 0; h.capital = false; h.name = '';
          }
        } else {
          const free = t.hexes.filter(k => { const h = this.hexes[k]; return !h.unit && !h.castle && !h.tree && !h.grave; });
          const pool = free.length ? free : t.hexes.filter(k => !this.hexes[k].castle);
          const k = pool.length ? this.rng.pick(pool) : this.rng.pick(t.hexes);
          const h = this.hexes[k];
          h.capital = true; h.money = 0; h.castle = false; h.tree = null; h.grave = false;
        }
      }
      this.invalidate();
    }

    // ---------- Сила та захист ----------

    strength(h) {
      return Math.max(
        h.unit ? h.unit.level : 0,
        h.castle ? this.rules.castleStrength : 0,
        h.capital ? this.rules.capitalStrength : 0);
    }

    // Захист гекса = максимум сили на ньому та на сусідніх гексах того ж власника
    defense(key) {
      const h = this.hexes[key];
      if (!h) return 0;
      let best = this.strength(h);
      for (const n of Hex.neighborKeys(key)) {
        const nh = this.hexes[n];
        if (nh && nh.owner === h.owner) best = Math.max(best, this.strength(nh));
      }
      return best;
    }

    economy(t) {
      let income = 0, wages = 0;
      for (const k of t.hexes) {
        const h = this.hexes[k];
        if (!h.tree && !h.grave) income += this.rules.incomePerHex;
        if (h.unit) wages += this.rules.unitWage[h.unit.level];
      }
      return { income, wages };
    }

    canAct(playerId) {
      const p = this.players[playerId];
      return !!p && p.alive && this.territories().some(t => t.owner === playerId && t.size >= 2);
    }

    // ---------- Дії ----------

    legalMoves(fromKey) {
      const from = this.hexes[fromKey];
      if (this.over || !from || !from.unit || from.owner !== this.current || from.unit.moved) return [];
      const t = this.territoryOf(fromKey);
      if (t.size < 2) return [];
      const lvl = from.unit.level, out = [];
      for (const k of t.hexes) {
        if (k === fromKey) continue;
        const h = this.hexes[k];
        if (h.castle) continue;
        if (h.unit && h.unit.level + lvl > this.rules.maxLevel) continue;
        out.push(k);
      }
      for (const k of this.borderTargets(t)) if (lvl > this.defense(k)) out.push(k);
      return out;
    }

    moveUnit(fromKey, toKey) {
      if (!this.legalMoves(fromKey).includes(toKey)) return fail('Недопустимий хід');
      const from = this.hexes[fromKey], to = this.hexes[toKey];
      const unit = from.unit;
      from.unit = null;
      if (to.owner === this.current) {
        const tired = unit.moved || this.rules.moveTiresUnit;
        if (to.unit) to.unit = { level: to.unit.level + unit.level, moved: to.unit.moved || unit.moved || this.rules.mergeTiresUnit };
        else if (to.tree || to.grave) { to.tree = null; to.grave = false; to.unit = { level: unit.level, moved: true }; }
        else to.unit = { level: unit.level, moved: tired };
        this.invalidate();
      } else {
        this.capture(toKey, { level: unit.level, moved: true }, this.current);
      }
      return ok();
    }

    buyTargets(anchorKey, level) {
      const t = this.territoryOf(anchorKey);
      if (this.over || !t || t.owner !== this.current || t.size < 2) return [];
      if (level < 1 || level > this.rules.maxLevel) return [];
      if (!this.rules.allowBuyAnyLevel && level !== 1) return [];
      if (t.money < this.rules.unitCost[level]) return [];
      const out = [];
      for (const k of t.hexes) {
        const h = this.hexes[k];
        if (h.castle) continue;
        if (h.unit && h.unit.level + level > this.rules.maxLevel) continue;
        out.push(k);
      }
      for (const k of this.borderTargets(t)) if (level > this.defense(k)) out.push(k);
      return out;
    }

    buyUnit(anchorKey, level, toKey) {
      if (!this.buyTargets(anchorKey, level).includes(toKey)) return fail('Не можна купити сюди');
      const t = this.territoryOf(anchorKey);
      this.hexes[t.capital].money -= this.rules.unitCost[level];
      const to = this.hexes[toKey];
      if (to.owner === this.current) {
        if (to.unit) to.unit = { level: to.unit.level + level, moved: to.unit.moved };
        else if (to.tree || to.grave) { to.tree = null; to.grave = false; to.unit = { level, moved: true }; }
        else to.unit = { level, moved: !this.rules.boughtUnitCanMove };
        this.invalidate();
      } else {
        this.capture(toKey, { level, moved: true }, this.current);
      }
      return ok();
    }

    castleTargets(anchorKey) {
      const t = this.territoryOf(anchorKey);
      if (this.over || !t || t.owner !== this.current || t.size < 2) return [];
      if (t.money < this.rules.castleCost) return [];
      return t.hexes.filter(k => { const h = this.hexes[k]; return !h.unit && !h.castle && !h.capital && !h.tree && !h.grave; });
    }

    buildCastle(anchorKey, toKey) {
      if (!this.castleTargets(anchorKey).includes(toKey)) return fail('Не можна збудувати тут');
      const t = this.territoryOf(anchorKey);
      this.hexes[t.capital].money -= this.rules.castleCost;
      this.hexes[toKey].castle = true;
      this.hexes[toKey].name = '';
      this.invalidate();
      return ok();
    }

    // Назва міста (столиці) або замку. Порожній рядок прибирає назву.
    setName(key, name) {
      const h = this.hexes[key];
      if (!h || !(h.capital || h.castle)) return fail('Назву можна дати лише місту або замку');
      h.name = String(name == null ? '' : name).trim().slice(0, 24);
      return ok();
    }

    capture(key, unit, by) {
      const h = this.hexes[key];
      const prev = h.owner;
      if (h.capital && h.money > 0) this.logMsg(`${this.playerName(by)} захопили столицю ${this.playerName(prev)} (${h.money} монет пропало)`);
      h.owner = by; h.unit = unit;
      h.capital = false; h.money = 0; h.castle = false; h.tree = null; h.grave = false; h.name = '';
      this.normalize(by);
      if (prev >= 0) this.normalize(prev);
      this.checkPlayers();
    }

    // ---------- Хід ----------

    startTurn() {
      const p = this.current;
      if (this.round === 1 && !this.rules.incomeOnFirstRound) {
        // перший раунд: без доходу й росту дерев, усі стартують з однаковою скарбницею
        for (const k in this.hexes) { const h = this.hexes[k]; if (h.owner === p && h.unit) h.unit.moved = false; }
        this.invalidate();
        return;
      }
      this.growTrees(p);
      for (const t of this.territories()) {
        if (t.owner !== p || t.size < 2 || !t.capital) continue;
        const cap = this.hexes[t.capital];
        const { income, wages } = this.economy(t);
        cap.money += income - wages;
        if (cap.money < 0) {
          cap.money = 0;
          let died = 0;
          for (const k of t.hexes) {
            const h = this.hexes[k];
            if (h.unit) { h.unit = null; if (!h.capital) h.grave = true; died++; }
          }
          this.logMsg(`${this.playerName(p)}: територія з ${t.size} гексів збанкрутувала, загинуло юнітів: ${died}`);
        }
      }
      for (const k in this.hexes) {
        const h = this.hexes[k];
        if (h.owner === p && h.unit) h.unit.moved = false;
      }
      this.invalidate();
    }

    growTrees(p) {
      const R = this.rules;
      const keys = Object.keys(this.hexes).filter(k => this.hexes[k].owner === p);
      for (const k of keys) {
        const h = this.hexes[k];
        if (!h.grave) continue;
        h.grave = false;
        if (R.graveBecomesTree && !h.capital && !h.castle) h.tree = this.isCoastal(k) ? 'palm' : 'pine';
      }
      const before = {};
      for (const k in this.hexes) before[k] = this.hexes[k].tree;
      for (const k of keys) {
        const h = this.hexes[k];
        if (h.tree || h.unit || h.castle || h.capital || h.grave) continue;
        let pines = 0, palms = 0;
        for (const n of Hex.neighborKeys(k)) {
          if (before[n] === 'pine') pines++;
          else if (before[n] === 'palm') palms++;
        }
        if (this.isCoastal(k) && palms >= 1 && this.rng.next() < R.palmSpreadChance) h.tree = 'palm';
        else if (pines >= R.pineNeighborsToSpread && this.rng.next() < R.pineSpreadChance) h.tree = 'pine';
      }
    }

    endTurn() {
      if (this.over) return;
      this.checkPlayers();
      if (this.over) return;
      const N = this.players.length;
      for (let i = 0; i < N; i++) {
        this.current = (this.current + 1) % N;
        if (this.current === 0) this.round++;
        if (this.canAct(this.current)) break;
      }
      this.startTurn();
    }

    checkPlayers() {
      const counts = this.hexCounts();
      for (const p of this.players) {
        if (p.alive && counts[p.id] === 0) { p.alive = false; this.logMsg(`${p.name} вибули з гри`); }
      }
      const active = this.players.filter(p => this.canAct(p.id));
      if (active.length <= 1 && !this.over) {
        this.over = true;
        if (active.length === 1) this.winner = active[0].id;
        else {
          let best = -1, bestCount = -1;
          counts.forEach((c, i) => { if (c > bestCount) { bestCount = c; best = i; } });
          this.winner = best;
        }
        this.logMsg(`Гра завершена. Перемога: ${this.playerName(this.winner)}`);
      }
    }

    // ---------- Статистика ----------

    stats() {
      const counts = this.hexCounts();
      return this.players.map(p => {
        let money = 0, units = 0, terrs = 0;
        for (const t of this.territories()) {
          if (t.owner !== p.id) continue;
          if (t.size >= 2) { terrs++; money += t.money; }
          for (const k of t.hexes) if (this.hexes[k].unit) units++;
        }
        return { id: p.id, name: p.name, color: p.color, kind: p.kind, level: p.level, alive: p.alive, hexes: counts[p.id], territories: terrs, money, units };
      });
    }

    /* Опис гравця: 'human' | 'ai' | 'ai:easy' | 'ai:normal' | 'ai:hard' | { kind, level } */
    static parsePlayer(spec) {
      if (spec && typeof spec === 'object') {
        const kind = spec.kind === 'human' ? 'human' : 'ai';
        return { kind, level: kind === 'ai' ? (spec.level || 'normal') : null };
      }
      const s = String(spec || 'ai');
      if (s === 'human') return { kind: 'human', level: null };
      const level = s.split(':')[1];
      return { kind: 'ai', level: level || 'normal' };
    }

    // ---------- Збереження ----------

    serialize() {
      return JSON.stringify({
        rules: this.rules, seed: this.seed, width: this.width, height: this.height,
        players: this.players, hexes: this.hexes, current: this.current, round: this.round,
        over: this.over, winner: this.winner, log: this.log, rngState: this.rng.state,
      });
    }

    restore(str) {
      const d = JSON.parse(str);
      this.rules = d.rules; this.seed = d.seed; this.width = d.width; this.height = d.height;
      this.players = d.players; this.hexes = d.hexes; this.current = d.current; this.round = d.round;
      this.over = d.over; this.winner = d.winner; this.log = d.log;
      this.rng = makeRng(0); this.rng.state = d.rngState;
      this.invalidate();
      return this;
    }

    static deserialize(str) {
      const g = Object.create(Game.prototype);
      return g.restore(str);
    }
  }

  Game.RULES = RULES;
  Game.UNIT_NAMES = UNIT_NAMES;
  Game.PLAYER_NAMES = PLAYER_NAMES;
  Game.PLAYER_COLORS = PLAYER_COLORS;
  Game.makeRng = makeRng;

  global.Game = Game;
})(window);
