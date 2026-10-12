/* Інтерфейс: панель, ввід мишею/клавіатурою, цикл ходів AI,
 * консольний API window.Slay для експериментів. */
(function (global) {
  'use strict';

  const { Hex, Game, AI, Renderer } = global;
  const $ = (id) => document.getElementById(id);

  const canvas = $('board');
  const renderer = new Renderer(canvas, null);

  let game = null;
  let history = [];   // знімки стану в межах ходу людини (для «Скасувати»)
  let hover = null;
  let aiTimer = null;
  let paused = false;
  const sel = { anchor: null, unit: null, targets: new Set(), placing: null };
  const hooks = { beforeTurn: null, afterTurn: null, onAction: null, onGameOver: null };

  // ---------- Налаштування нової гри ----------

  function renderPlayerKinds() {
    const n = +$('playerCount').value;
    const box = $('playerKinds');
    const prev = [...box.querySelectorAll('select')].map(s => s.value);
    box.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const label = document.createElement('label');
      label.innerHTML = `<span class="swatch" style="background:${Game.PLAYER_COLORS[i]}"></span>${Game.PLAYER_NAMES[i]}`;
      const s = document.createElement('select');
      s.innerHTML = '<option value="human">Людина</option>' +
        Object.keys(AI.levels).map(l => `<option value="ai:${l}">Комп'ютер: ${AI.levelNames[l] || l}</option>`).join('');
      s.value = prev[i] || (i === 0 ? 'human' : 'ai:normal');
      label.appendChild(s);
      box.appendChild(label);
    }
  }

  function readSetup() {
    const seedRaw = $('seed').value.trim();
    return {
      players: [...$('playerKinds').querySelectorAll('select')].map(s => s.value),
      width: Math.max(6, +$('mapW').value || 20),
      height: Math.max(6, +$('mapH').value || 14),
      landRatio: Math.min(1, Math.max(0.2, (+$('land').value || 62) / 100)),
      seed: seedRaw === '' ? undefined : (+seedRaw >>> 0),
      rules: { treeRatio: Math.max(0, (+$('trees').value || 0) / 100) },
    };
  }

  function newGame(opts) {
    clearTimeout(aiTimer); aiTimer = null;
    game = new Game(opts || readSetup());
    history = [];
    paused = false;
    clearSel();
    renderer.setGame(game);
    $('seed').value = game.seed;
    global.Slay.game = game;
    refresh();
    scheduleAi();
    return game;
  }

  function adoptGame(g) {
    clearTimeout(aiTimer); aiTimer = null;
    game = g;
    history = [];
    paused = false;
    clearSel();
    renderer.setGame(game);
    global.Slay.game = game;
    refresh();
    scheduleAi();
    return game;
  }

  // ---------- Виділення ----------

  function humanTurn() { return !!game && !game.over && game.players[game.current].kind === 'human'; }

  function selTerritory() {
    if (!game || !sel.anchor) return null;
    const t = game.territoryOf(sel.anchor);
    if (!t || t.owner !== game.current || t.size < 2) return null;
    return t;
  }

  function clearSel() { sel.anchor = null; sel.unit = null; sel.targets = new Set(); sel.placing = null; }

  function cancel() { sel.unit = null; sel.targets = new Set(); sel.placing = null; refresh(); }

  function selectUnit(k) { sel.unit = k; sel.placing = null; sel.targets = new Set(game.legalMoves(k)); }

  function startPlacing(type, level) {
    if (!humanTurn()) return;
    const t = selTerritory();
    if (!t) { flash('Спершу виділіть свою територію'); return; }
    if (sel.placing && sel.placing.type === type && sel.placing.level === level) { cancel(); return; }
    const targets = type === 'castle' ? game.castleTargets(t.capital) : game.buyTargets(t.capital, level);
    if (!targets.length) { flash(t.money < (type === 'castle' ? game.rules.castleCost : game.rules.unitCost[level]) ? 'Не вистачає грошей' : 'Нема куди поставити'); return; }
    sel.placing = { type, level };
    sel.unit = null;
    sel.targets = new Set(targets);
    refresh();
  }

  function uiState() {
    return {
      selTerritory: selTerritory(), selUnit: sel.unit, targets: sel.targets, hover, placing: sel.placing,
      animate: true, time: performance.now(),
    };
  }

  // Анімація: перемальовуємо, поки в поточного гравця є юніти, що не ходили
  let lastFrame = 0;
  function hasBouncingUnits() {
    if (!game || game.over) return false;
    for (const k in game.hexes) {
      const h = game.hexes[k];
      if (h.owner === game.current && h.unit && !h.unit.moved) return true;
    }
    return false;
  }
  function animate() {
    const now = performance.now();
    if (document.hidden || now - lastFrame < 30 || !hasBouncingUnits()) return;
    lastFrame = now;
    renderer.draw(uiState());
  }

  // ---------- Дії людини ----------

  function act(fn) {
    const snap = game.serialize();
    const res = fn();
    if (res && res.ok === false) { flash(res.error); return false; }
    history.push(snap);
    if (hooks.onAction) hooks.onAction(game);
    if (game.over && hooks.onGameOver) hooks.onGameOver(game);
    return true;
  }

  function onClick(k) {
    if (!humanTurn()) return;
    if (!k) { clearSel(); refresh(); return; }
    const h = game.hexes[k];

    if (sel.placing && sel.targets.has(k)) {
      const p = sel.placing, anchor = sel.anchor;
      act(() => p.type === 'castle' ? game.buildCastle(anchor, k) : game.buyUnit(anchor, p.level, k));
      sel.placing = null; sel.targets = new Set(); sel.unit = null;
      sel.anchor = k;
      const nh = game.hexes[k];
      if (nh.owner === game.current && nh.unit && !nh.unit.moved && selTerritory()) selectUnit(k);
      refresh();
      return;
    }

    if (sel.unit && sel.targets.has(k)) {
      const from = sel.unit;
      act(() => game.moveUnit(from, k));
      sel.unit = null; sel.targets = new Set();
      sel.anchor = k;
      refresh();
      return;
    }

    if (h.owner === game.current) {
      const t = game.territoryOf(k);
      sel.placing = null;
      if (t.size >= 2) {
        sel.anchor = k;
        if (h.unit && !h.unit.moved) selectUnit(k);
        else { sel.unit = null; sel.targets = new Set(); }
      } else {
        clearSel();
        flash('Самотній гекс не може діяти');
      }
      refresh();
      return;
    }

    clearSel();
    refresh();
  }

  // Назва міста або замку (не є ігровою дією, тому без знімка для «Скасувати»)
  function promptName(key) {
    if (!game) return;
    const h = game.hexes[key];
    if (!h || !(h.capital || h.castle)) { flash('Назву можна дати лише місту або замку'); return; }
    const value = window.prompt(h.capital ? 'Назва міста:' : 'Назва замку:', h.name || '');
    if (value === null) return;
    const res = game.setName(key, value);
    if (!res.ok) flash(res.error);
    refresh();
  }

  function undo() {
    if (!history.length || !humanTurn()) return;
    game.restore(history.pop());
    clearSel();
    refresh();
  }

  function endTurnHuman() {
    if (!humanTurn()) return;
    game.endTurn();
    history = [];
    clearSel();
    refresh();
    scheduleAi();
  }

  // ---------- Ходи AI ----------

  function aiDelay() { return +$('aiDelay').value; }

  function scheduleAi() {
    clearTimeout(aiTimer); aiTimer = null;
    if (!game || game.over || humanTurn() || paused) { refresh(); return; }
    aiTimer = setTimeout(aiStep, aiDelay());
  }

  function aiStep() {
    aiTimer = null;
    if (!game || game.over || humanTurn() || paused) { refresh(); return; }
    runOneAiTurn();
    refresh();
    scheduleAi();
  }

  function runOneAiTurn() {
    const p = game.current;
    if (hooks.beforeTurn) hooks.beforeTurn(game, p);
    try { AI.run(game, p); } catch (e) { console.error('Помилка AI гравця', p, e); }
    if (hooks.afterTurn) hooks.afterTurn(game, p);
    game.endTurn();
    if (game.over && hooks.onGameOver) hooks.onGameOver(game);
  }

  function fastForward() {
    if (!game) return;
    clearTimeout(aiTimer); aiTimer = null;
    let guard = 0;
    while (!game.over && !humanTurn() && guard++ < 5000) runOneAiTurn();
    refresh();
  }

  function togglePause() {
    paused = !paused;
    if (!paused) scheduleAi(); else { clearTimeout(aiTimer); aiTimer = null; refresh(); }
  }

  // ---------- Панель ----------

  function swatch(color) { return `<span class="swatch" style="background:${color}"></span>`; }

  function playerKindLabel(p) {
    if (p.kind === 'human') return 'людина';
    return `комп'ютер, ${AI.levelNames[p.level] || p.level || 'середній'}`;
  }

  function updatePanel() {
    if (!game) return;
    const cur = game.players[game.current];
    const R = game.rules;

    if (game.over) {
      const w = game.winner >= 0 ? game.players[game.winner] : null;
      $('turnInfo').innerHTML = `Раунд ${game.round} · Гра завершена. Перемога: ${w ? swatch(w.color) + ' ' + w.name : 'нічия'}`;
    } else {
      $('turnInfo').innerHTML = `Раунд ${game.round} · Хід: ${swatch(cur.color)} <b>${cur.name}</b> (${playerKindLabel(cur)})${paused ? ' · <b>пауза</b>' : ''}`;
    }

    const tbody = $('players').querySelector('tbody');
    tbody.innerHTML = game.stats().map(s =>
      `<tr class="${s.id === game.current && !game.over ? 'current' : ''}${s.alive ? '' : ' dead'}">
        <td>${swatch(s.color)} ${s.name}${s.kind === 'ai' ? ` <span class="muted">· ${AI.levelNames[s.level] || s.level}</span>` : ''}</td>
        <td>${s.hexes}</td><td>${s.territories}</td><td>${s.money}</td><td>${s.units}</td></tr>`).join('');

    const t = selTerritory();
    const info = $('terrInfo');
    if (t) {
      const { income, wages } = game.economy(t);
      const next = t.money + income - wages;
      const capName = game.hexes[t.capital].name;
      info.innerHTML = (capName ? `Місто: <b>${escapeHtml(capName)}</b><br>` : '') +
        `Гексів: <b>${t.size}</b> · Скарбниця: <b>${t.money}</b><br>` +
        `Дохід: +${income} · Платня: −${wages} · Наступного ходу: <b style="color:${next < 0 ? '#ff8a80' : '#d6d6e6'}">${next}</b>` +
        (next < 0 ? '<br><span style="color:#ff8a80">Банкрутство: усі юніти загинуть!</span>' : '');
    } else {
      info.innerHTML = `<span class="muted">${humanTurn() ? 'Клацніть по своїй території (2+ гекси)' : 'Хід комп\'ютера'}</span>`;
    }

    const human = humanTurn();
    document.querySelectorAll('.buyBtn').forEach(btn => {
      const lvl = +btn.dataset.level;
      btn.querySelector('.cost').textContent = R.unitCost[lvl];
      btn.disabled = !human || !t || !game.buyTargets(t.capital, lvl).length;
      btn.classList.toggle('active', !!(sel.placing && sel.placing.type === 'unit' && sel.placing.level === lvl));
    });
    const cb = $('castleBtn');
    cb.querySelector('.cost').textContent = R.castleCost;
    cb.disabled = !human || !t || !game.castleTargets(t.capital).length;
    cb.classList.toggle('active', !!(sel.placing && sel.placing.type === 'castle'));

    $('nameBtn').disabled = !human || !t;
    $('endTurn').disabled = !human;
    $('undo').disabled = !human || !history.length;
    $('pause').textContent = paused ? 'Продовжити' : 'Пауза';
    $('pause').disabled = game.over;
    $('fastForward').disabled = game.over || human;

    $('log').innerHTML = game.log.slice(-20).reverse().map(e => `<div><span class="muted">${e.round}.</span> ${e.msg}</div>`).join('');

    const ov = $('overlay');
    if (game.over) {
      const w = game.winner >= 0 ? game.players[game.winner] : null;
      $('overlayText').innerHTML = w ? `${swatch(w.color)} Перемога: ${w.name}` : 'Нічия';
      $('overlaySub').textContent = `Раундів: ${game.round} · seed ${game.seed}`;
      ov.style.display = 'flex';
    } else ov.style.display = 'none';
  }

  function refresh() {
    renderer.draw(uiState());
    updatePanel();
    autosave();
  }

  // ---------- Автозбереження ----------
  // Гра записується після кожної зміни й продовжується при наступному відкритті: у React Host
  // (і в закритій вкладці) інакше незбережена партія зникає. Окремо від ручного «Зберегти».

  const AUTOSAVE_KEY = 'slay.autosave';

  function autosave() {
    if (!game) return;
    try {
      if (game.over) localStorage.removeItem(AUTOSAVE_KEY);
      else localStorage.setItem(AUTOSAVE_KEY, game.serialize());
    } catch (e) { /* сховище недоступне — граємо без автозбереження */ }
  }

  function resumeOrNewGame() {
    let saved = null;
    try { saved = localStorage.getItem(AUTOSAVE_KEY); } catch (e) { /* ignore */ }
    if (saved) {
      try {
        adoptGame(Game.deserialize(saved));
        flash('Продовжено попередню гру · «Нова гра» — почати заново');
        return;
      } catch (e) {
        console.warn('Не вдалося відновити автозбереження', e);
      }
    }
    newGame();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  let flashTimer = null;
  function flash(msg) {
    const el = $('flash');
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
  }

  // ---------- Підказка ----------

  function updateTooltip(e, k) {
    const tip = $('tooltip');
    if (!k || !game) { tip.style.display = 'none'; return; }
    const h = game.hexes[k];
    const t = game.territoryOf(k);
    const lines = [];
    lines.push(`${swatch(h.owner >= 0 ? game.players[h.owner].color : '#6b7280')} ${game.playerName(h.owner)} · ${k}`);
    lines.push(`Територія: ${t.size} гекс.${t.capital ? ` · скарбниця ${t.money}` : ''} · захист ${game.defense(k)}`);
    if (t.capital && t.size >= 2) { const eco = game.economy(t); lines.push(`Дохід +${eco.income} · платня −${eco.wages}`); }
    if (h.unit) lines.push(`${Game.UNIT_NAMES[h.unit.level]} (рівень ${h.unit.level})${h.unit.moved ? ' · вже ходив' : ''}`);
    if (h.capital) lines.push(h.name ? `Місто «${escapeHtml(h.name)}»` : 'Місто (столиця) · подвійний клік — назвати');
    if (h.castle) lines.push(h.name ? `Замок «${escapeHtml(h.name)}»` : 'Замок · подвійний клік — назвати');
    if (h.tree) lines.push(h.tree === 'pine' ? 'Сосна (не дає доходу)' : 'Пальма (не дає доходу)');
    if (h.grave) lines.push('Могила (стане деревом)');
    tip.innerHTML = lines.join('<br>');
    tip.style.display = 'block';
    const pad = 14;
    let x = e.clientX + pad, y = e.clientY + pad;
    const r = tip.getBoundingClientRect();
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  // ---------- Події ----------

  function hexAtEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return renderer.hexAt(e.clientX - rect.left, e.clientY - rect.top);
  }

  canvas.addEventListener('mousemove', e => {
    const k = hexAtEvent(e);
    if (k !== hover) { hover = k; renderer.draw(uiState()); }
    updateTooltip(e, k);
  });
  canvas.addEventListener('mouseleave', () => { hover = null; $('tooltip').style.display = 'none'; renderer.draw(uiState()); });
  canvas.addEventListener('click', e => onClick(hexAtEvent(e)));
  canvas.addEventListener('dblclick', e => {
    const k = hexAtEvent(e);
    if (k && game && (game.hexes[k].capital || game.hexes[k].castle)) promptName(k);
  });
  canvas.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); });

  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'Enter': case ' ': e.preventDefault(); endTurnHuman(); break;
      case 'Escape': cancel(); break;
      case 'z': case 'Z': case 'Backspace': e.preventDefault(); undo(); break;
      case '1': case '2': case '3': case '4': startPlacing('unit', +e.key); break;
      case 'c': case 'C': startPlacing('castle'); break;
      case 'n': case 'N': newGame(); break;
      case 'p': case 'P': togglePause(); break;
      case 'f': case 'F': fastForward(); break;
      default: return;
    }
  });

  $('endTurn').addEventListener('click', endTurnHuman);
  $('undo').addEventListener('click', undo);
  $('pause').addEventListener('click', togglePause);
  $('fastForward').addEventListener('click', fastForward);
  $('newGame').addEventListener('click', () => newGame());
  $('overlayNew').addEventListener('click', () => newGame());
  $('playerCount').addEventListener('change', renderPlayerKinds);
  $('aiDelay').addEventListener('input', () => { $('aiDelayVal').textContent = $('aiDelay').value; });
  document.querySelectorAll('.buyBtn').forEach(btn => btn.addEventListener('click', () => startPlacing('unit', +btn.dataset.level)));
  $('castleBtn').addEventListener('click', () => startPlacing('castle'));
  $('nameBtn').addEventListener('click', () => { const t = selTerritory(); if (t) promptName(t.capital); });
  $('save').addEventListener('click', () => {
    if (!game) return;
    try { localStorage.setItem('slay.save', game.serialize()); flash('Збережено'); } catch (e) { flash('Не вдалося зберегти'); }
  });
  $('load').addEventListener('click', () => {
    let s = null;
    try { s = localStorage.getItem('slay.save'); } catch (e) { /* ignore */ }
    if (!s) { flash('Збереження немає'); return; }
    adoptGame(Game.deserialize(s));
    flash('Завантажено');
  });

  window.addEventListener('resize', () => { renderer.resize(); refresh(); });

  // ---------- Консольний API ----------

  global.Slay = {
    game: null,
    Game, AI, Hex, Renderer, renderer, hooks,
    RULES: Game.RULES,
    newGame, adoptGame, refresh, undo, cancel, fastForward, togglePause,
    endTurn: endTurnHuman,
    simulate: AI.simulate,
    setName(key, name) { const r = game.setName(key, name); refresh(); return r; },
    save() { return game ? game.serialize() : null; },
    load(str) { return adoptGame(Game.deserialize(str)); },
    // Зіграти хід поточного AI-гравця вручну (зручно крок за кроком)
    stepAi() { if (game && !game.over && !humanTurn()) { runOneAiTurn(); refresh(); } },
  };

  // ---------- Старт ----------

  renderPlayerKinds();
  $('aiDelayVal').textContent = $('aiDelay').value;
  document.querySelectorAll('.buyBtn').forEach(btn => {
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = Renderer.LEVEL_COLORS[+btn.dataset.level];
    btn.prepend(sw, ' ');
  });
  renderer.resize();
  resumeOrNewGame();
  setInterval(animate, 33);
})(window);
