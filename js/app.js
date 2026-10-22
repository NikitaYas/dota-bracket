/**
 * app.js — отрисовка сетки и взаимодействие (просмотр + режим администратора).
 * Имена участников никогда не вставляются через innerHTML: только textContent / атрибуты.
 */
import * as E from './engine.js';
import * as S from './storage.js';

const DRAFT_KEY = 'dotaBracket.draft.v1';
const ZOOM_KEY = 'dotaBracket.zoom';
const REFRESH_MS = 60_000;
/** Как часто автообновление обращается к GitHub API без токена (60 запросов/час на IP, 304 тоже считаются). */
const API_REFRESH_MS = 5 * 60_000;
const HISTORY_LIMIT = 200;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 64;

/* Геометрия сетки (px, до масштабирования) */
const G = {
  CW: 204,        // ширина карточки
  FULL_H: 58,     // 2 строки по 28 + рамка
  COMPACT_H: 30,  // авто-проход (BYE)
  VGAP: 26,       // вертикальный зазор (место под подпись матча)
  CGAP: 64,       // зазор между колонками
  PAD: 24,
  HEAD: 76,       // заголовок секции + подписи раундов
  SECTION_GAP: 36,
  ADV: 52,        // место справа под зону «Победа» в режиме админа
};

const el = {};
const ui = {
  state: null,
  res: null,
  standings: new Map(),
  byId: new Map(),
  nums: Object.create(null),
  layout: null,
  history: [],
  hIndex: 0,
  savedState: null,
  savedKey: '',
  baselineText: null,
  etag: null,
  source: '',
  lastCheck: 0,
  lastApiCheck: 0,
  admin: false,
  zoom: 1,
  zoomInit: false,
  tab: 'bracket',
  hl: null,
  saving: false,
  refreshing: false,
  suppressClick: false,
  pendingSave: false,
  settingsOpen: false,
  draftHold: false,
};

/* ================================================================== */
/* Утилиты                                                             */
/* ================================================================== */

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  return node;
}

function trophyIcon(cls = 'ic') {
  const s = svgEl('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' });
  s.append(
    svgEl('path', { d: 'M7 4h10v4a5 5 0 0 1-10 0V4Z', fill: 'currentColor' }),
    svgEl('path', { d: 'M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' }),
    svgEl('path', { d: 'M10 13h4v3h-4zM8 20h8v-2a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2Z', fill: 'currentColor' }),
  );
  return s;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

function fmtDateTime(iso) {
  const d = typeof iso === 'number' ? new Date(iso) : new Date(iso || 0);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}, ${time}`;
}

const stateKey = (s) => JSON.stringify({ ...s, updatedAt: null });
const isDirty = () => !!ui.state && stateKey(ui.state) !== ui.savedKey;

function lsGet(key) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function lsSet(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* недоступно — не критично */ }
}
function lsDel(key) {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
}

/* ---------------- toasts ---------------- */

function toast(message, kind = 'info', ms = 4500) {
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('div', { class: 'toast-msg' }, message),
    h('button', { type: 'button', class: 'toast-x', 'aria-label': 'Закрыть уведомление' }, '×'));
  const close = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  };
  t.querySelector('.toast-x').addEventListener('click', close);
  el.toasts.append(t);
  if (ms > 0) setTimeout(close, ms);
  return t;
}

/* ---------------- confirm ---------------- */

let confirmResolve = null;
/** Резолвится true (OK), false (кнопка отмены) или null (закрыто Esc / без явного выбора). */
function confirmDialog(text, okLabel = 'Продолжить', cancelLabel = 'Отмена') {
  return new Promise((resolve) => {
    if (confirmResolve) confirmResolve(null);
    confirmResolve = resolve;
    el.confirmText.textContent = text;
    el.confirmOk.textContent = okLabel;
    el.confirmCancel.textContent = cancelLabel;
    el.confirmDlg.showModal();
    el.confirmOk.focus();
  });
}
function finishConfirm(value) {
  const r = confirmResolve;
  confirmResolve = null;
  if (el.confirmDlg.open) el.confirmDlg.close();
  if (r) r(value);
}

/* ================================================================== */
/* Состояние, история                                                  */
/* ================================================================== */

function setState(state, opts) {
  ui.state = state;
  ui.res = E.resolve(state);
  ui.standings = E.standings(state, ui.res);
  ui.byId = new Map(state.participants.map((p) => [p.id, p]));
  renderAll(opts);
  saveDraft();
}

function pushState(next, opts) {
  if (next === ui.state) return;
  ui.history = ui.history.slice(0, ui.hIndex + 1);
  ui.history.push(next);
  if (ui.history.length > HISTORY_LIMIT) ui.history.shift();
  ui.hIndex = ui.history.length - 1;
  setState(next, opts);
}

function resetHistory(state) {
  ui.history = [state];
  ui.hIndex = 0;
  setState(state);
}

function undo() {
  if (!ui.admin || ui.hIndex <= 0) return;
  ui.hIndex--;
  setState(ui.history[ui.hIndex]);
}

function redo() {
  if (!ui.admin || ui.hIndex >= ui.history.length - 1) return;
  ui.hIndex++;
  setState(ui.history[ui.hIndex]);
}

/** Применяет изменение; если оно сбрасывает результаты ниже по сетке — спрашивает подтверждение. */
async function apply(next, { except = null, ask = true, keepSettings = false } = {}) {
  if (!next || next === ui.state) return false;
  const removed = E.removedResults(ui.state, next).filter((id) => id !== except);
  if (ask && removed.length) {
    const n = removed.length;
    const ok = await confirmDialog(
      `Это изменение сбросит ${n} ${plural(n, ['результат', 'результата', 'результатов'])} уже сыгранных матчей (они зависят от изменённого). Продолжить?`,
      'Сбросить и продолжить',
    );
    if (!ok) {
      renderBracket();
      return false;
    }
  }
  pushState(next, { keepSettings });
  return true;
}

function tryOp(fn) {
  try {
    return fn();
  } catch (err) {
    toast(err && err.message ? err.message : 'Действие невозможно', 'error');
    return null;
  }
}

/* ---------------- черновик ---------------- */

function saveDraft() {
  if (!ui.admin || ui.draftHold) return;
  if (isDirty()) lsSet(DRAFT_KEY, JSON.stringify({ text: E.serialize(ui.state), at: Date.now() }));
  else lsDel(DRAFT_KEY);
}

async function offerDraft() {
  const raw = lsGet(DRAFT_KEY);
  if (!raw || !ui.admin) return;
  let draft;
  try {
    const d = JSON.parse(raw);
    draft = { state: E.normalizeState(JSON.parse(d.text)), at: d.at };
  } catch {
    lsDel(DRAFT_KEY);
    return;
  }
  const k = stateKey(draft.state);
  if (k === ui.savedKey || k === stateKey(ui.state)) {
    lsDel(DRAFT_KEY);
    return;
  }
  const ok = await confirmDialog(
    `Найден несохранённый черновик${draft.at ? ` от ${fmtDateTime(draft.at)}` : ''}. Восстановить его?`,
    'Восстановить черновик',
    'Удалить черновик',
  );
  if (ok === true) {
    pushState(draft.state);
    toast('Черновик восстановлен. Не забудьте сохранить.', 'info');
  } else if (ok === false) {
    lsDel(DRAFT_KEY); // только явный выбор «Удалить черновик»
  } else {
    toast('Черновик оставлен в браузере — его предложат снова при следующем входе (пока вы не начнёте новые правки).', 'info', 7000);
  }
}

/* ================================================================== */
/* Раскладка сетки                                                     */
/* ================================================================== */

function visOf(m, r, admin) {
  if (admin && m.section === 'upper' && m.round === 1) return 'full';
  const nulls = (r.p[0] === null ? 1 : 0) + (r.p[1] === null ? 1 : 0);
  if (nulls === 2) return 'hidden';
  return nulls === 1 ? 'compact' : 'full';
}

const heightOf = (vis) => (vis === 'full' ? G.FULL_H : G.COMPACT_H);
const colX = (c) => G.PAD + c * (G.CW + G.CGAP);

function computeLayout(B, RES, admin) {
  const pos = Object.create(null);
  const titles = [];
  const labels = [];
  const place = (id, col, cy) => {
    const m = B.byId[id];
    const vis = visOf(m, RES.matches[id], admin);
    const hh = heightOf(vis);
    pos[id] = { x: colX(col), top: cy - hh / 2, h: hh, cy, vis };
  };
  const colLabel = (col, top, text) => labels.push({ x: colX(col), y: top - 46, text });

  // Верхняя / основная сетка
  let y = G.PAD;
  titles.push({ x: G.PAD, y, text: B.format === 'double' ? 'Верхняя сетка' : 'Сетка плей-офф' });
  let top = y + G.HEAD;
  let cur = top;
  for (const id of B.upper[0]) {
    const hh = heightOf(visOf(B.byId[id], RES.matches[id], admin));
    place(id, 0, cur + hh / 2);
    cur += hh + G.VGAP;
  }
  for (let r = 1; r < B.upper.length; r++) {
    for (const id of B.upper[r]) {
      const [a, b] = B.byId[id].sources;
      place(id, r, (pos[a.match].cy + pos[b.match].cy) / 2);
    }
  }
  B.columns.filter((c) => c.section === 'upper').forEach((c, i) => colLabel(i, top, c.label));
  let bottom = cur - G.VGAP;

  // Нижняя сетка
  if (B.lower.length) {
    y = bottom + G.SECTION_GAP;
    titles.push({ x: G.PAD, y, text: 'Нижняя сетка' });
    top = y + G.HEAD;
    cur = top;
    B.lower[0].forEach((id, k) => {
      const h1 = heightOf(visOf(B.byId[id], RES.matches[id], admin));
      const nid = B.lower[1] ? B.lower[1][k] : null;
      const h2 = nid ? heightOf(visOf(B.byId[nid], RES.matches[nid], admin)) : 0;
      const rowH = Math.max(h1, h2);
      place(id, 0, cur + rowH / 2);
      cur += rowH + G.VGAP;
    });
    for (let i = 1; i < B.lower.length; i++) {
      for (const id of B.lower[i]) {
        const srcs = B.byId[id].sources.filter((s) => s.type === 'winner' && B.byId[s.match].section === 'lower');
        const cy = srcs.reduce((acc, s) => acc + pos[s.match].cy, 0) / srcs.length;
        place(id, i, cy);
      }
    }
    B.columns.filter((c) => c.section === 'lower').forEach((c, i) => colLabel(i, top, c.label));
    bottom = cur - G.VGAP;
  }

  let maxCol = B.upper.length - 1;
  if (B.format === 'double') {
    const R = B.rounds;
    const gfCol = B.lower.length ? Math.max(R, B.lower.length) : R;
    const ub = pos[`W${R}-1`];
    const lb = B.lower.length ? pos[B.lower[B.lower.length - 1][0]] : null;
    const cy = lb ? (ub.cy + lb.cy) / 2 : ub.cy;
    place('GF1', gfCol, cy);
    labels.push({ x: colX(gfCol), y: cy - G.FULL_H / 2 - 46, text: 'Гранд-финал', gold: true });
    maxCol = gfCol;
    if (B.byId.GF2) {
      place('GF2', gfCol + 1, cy);
      if (pos.GF2.vis !== 'hidden') labels.push({ x: colX(gfCol + 1), y: cy - G.FULL_H / 2 - 46, text: 'Перезапуск финала', gold: true });
      maxCol = gfCol + 1;
    }
  } else if (B.third) {
    const fin = pos[`W${B.rounds}-1`];
    const cy = fin.cy + G.FULL_H + 96;
    place(B.third, B.rounds - 1, cy);
    labels.push({ x: colX(B.rounds - 1), y: cy - G.FULL_H / 2 - 46, text: 'Матч за 3-е место' });
  }

  let maxBottom = bottom;
  for (const id of Object.keys(pos)) maxBottom = Math.max(maxBottom, pos[id].top + pos[id].h);
  const width = colX(maxCol) + G.CW + G.PAD + (admin ? G.ADV : 0);
  const height = maxBottom + G.PAD + 8;
  return { pos, titles, labels, width, height };
}

function numberMatches(B, RES) {
  const nums = Object.create(null);
  let n = 0;
  for (const m of B.matches) {
    const p = RES.matches[m.id].p;
    if (p[0] !== null && p[1] !== null) nums[m.id] = ++n;
  }
  return nums;
}

/* ================================================================== */
/* Отрисовка                                                           */
/* ================================================================== */

function renderAll({ keepSettings = false } = {}) {
  renderHeader();
  renderChampion();
  renderAdminBar();
  renderBracket();
  if (ui.tab === 'players') renderPlayers();
  // keepSettings: правка пришла из самой панели (текстовое поле) — не пересоздаём её DOM,
  // иначе теряется фокус и клик/Tab, который как раз переводит его на следующее поле.
  if (ui.settingsOpen && !keepSettings) renderSettings();
}

function formatLabel(state) {
  return state.format === 'double' ? 'Двойное выбывание' : 'Одиночное выбывание';
}

function renderHeader() {
  const s = ui.state;
  if (!s) return;
  el.title.textContent = s.title;
  document.title = `${s.title} — турнирная сетка`;
  const n = s.participants.length;
  el.subtitle.textContent = `${formatLabel(s)} · ${n} ${plural(n, ['участник', 'участника', 'участников'])}`;

  const champ = ui.res.champion;
  const started = Object.keys(s.results).length > 0;
  let mode = 'soon';
  let label = 'Скоро старт';
  if (champ) {
    mode = 'done';
    label = 'Завершён';
  } else if (started) {
    mode = 'live';
    label = 'LIVE';
  }
  el.live.dataset.mode = mode;
  el.liveLabel.textContent = label;
  el.liveTime.textContent = s.updatedAt ? `Обновлено: ${fmtDateTime(s.updatedAt)}` : '';
  const src = ui.source === 'api' ? 'GitHub API' : ui.source === 'static' ? 'файл сайта' : 'нет данных';
  el.live.title = `Источник данных: ${src}${ui.lastCheck ? `. Проверено: ${new Date(ui.lastCheck).toLocaleTimeString('ru-RU')}` : ''}. Автообновление каждую минуту.`;
}

function renderChampion() {
  const champ = ui.res.champion;
  if (!champ) {
    el.champion.hidden = true;
    el.champion.replaceChildren();
    return;
  }
  const nameOf = (id) => (ui.byId.get(id) || { name: '—' }).name;
  const byPlace = (p) => [...ui.standings.entries()].filter(([, v]) => v.place && v.place[0] === p && v.place[1] === p).map(([id]) => id);
  const second = byPlace(2);
  const third = byPlace(3);
  el.champion.replaceChildren(
    h('div', { class: 'champ-inner' },
      trophyIcon('ic champ-ic'),
      h('div', { class: 'champ-text' },
        h('span', { class: 'champ-kicker' }, 'Чемпион турнира'),
        h('strong', { class: 'champ-name' }, nameOf(champ))),
      h('div', { class: 'champ-podium' },
        second.length ? h('span', null, h('b', null, '2'), ' ', nameOf(second[0])) : null,
        third.length ? h('span', null, h('b', null, '3'), ' ', nameOf(third[0])) : null)),
  );
  el.champion.hidden = false;
}

function renderAdminBar() {
  el.adminBar.hidden = !ui.admin;
  document.body.classList.toggle('is-admin', ui.admin);
  el.adminBtnText.textContent = ui.admin ? 'Просмотр' : 'Админ';
  el.adminBtn.setAttribute('aria-label', ui.admin ? 'Выйти в режим просмотра' : 'Режим администратора');
  if (!ui.admin) return;
  el.undoBtn.disabled = ui.hIndex <= 0;
  el.redoBtn.disabled = ui.hIndex >= ui.history.length - 1;
  const dirty = isDirty();
  el.dirtyState.textContent = dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены';
  el.dirtyState.classList.toggle('is-dirty', dirty);
  el.saveBtn.disabled = ui.saving;
  el.saveBtn.textContent = ui.saving ? 'Сохранение…' : S.currentToken() ? 'Сохранить' : 'Сохранить…';
  el.saveBtn.title = S.currentToken() ? `Опубликовать в ${S.repoLabel()}` : 'Нужно войти с токеном GitHub';
}

function hintFor(m, side) {
  const src = m.sources[side];
  if (src.type === 'reset') return 'если потребуется';
  if (src.type === 'winner' || src.type === 'loser') {
    const n = ui.nums[src.match];
    if (n) return `${src.type === 'winner' ? 'Победитель' : 'Проигравший'} #${n}`;
    // Матч-источник — авто-проход (BYE против ещё неизвестного): берём подсказку его реальной стороны
    const r = ui.res.matches[src.match];
    if (src.type === 'winner' && r && r.status === 'pending') {
      const realSide = r.p[0] === null ? 1 : r.p[1] === null ? 0 : -1;
      if (realSide >= 0) return hintFor(ui.res.bracket.byId[src.match], realSide);
    }
  }
  return 'ожидается';
}

function rowEl(m, r, side, isDecider, compact = false) {
  const pid = r.p[side];
  const admin = ui.admin;
  const w1 = m.section === 'upper' && m.round === 1;
  const row = h('div', { class: 'row', 'data-mid': m.id, 'data-side': String(side) });
  if (admin && w1) row.dataset.slot = String(m.sources[side].index);

  if (pid === undefined) {
    row.classList.add('tbd');
    row.append(h('span', { class: 'seed' }), h('span', { class: 'name' }, hintFor(m, side)),
      compact ? h('span', { class: 'tag' }, 'BYE') : h('span', { class: 'score' }));
    return row;
  }
  if (pid === null) {
    row.classList.add('bye');
    row.append(h('span', { class: 'seed' }), h('span', { class: 'name' }, 'BYE'), h('span', { class: 'score' }));
    return row;
  }

  const P = ui.byId.get(pid);
  const name = P ? P.name : '—';
  row.dataset.pid = pid;
  const done = r.status === 'done';
  const both = !!(r.p[0] && r.p[1]);
  if ((done || r.status === 'bye') && r.winner === pid) row.classList.add('win');
  if (done && r.loser === pid) row.classList.add('lose');
  if (isDecider && r.winner === pid) row.classList.add('champ');
  const info = ui.standings.get(pid);
  const editable = admin && both && (r.status === 'ready' || done);

  const seedEl = h('span', { class: 'seed' }, info && info.seed ? String(info.seed) : '');
  const nameEl = editable
    ? h('button', {
      type: 'button', class: 'name pick', 'data-act': 'pick', 'data-mid': m.id, 'data-side': String(side), title: name,
      'aria-label': `${name}: отметить победу`, 'aria-pressed': done && r.winner === pid ? 'true' : 'false',
    }, name)
    : h('span', { class: 'name', title: name }, name);

  let scoreEl;
  if (compact) {
    scoreEl = h('span', { class: 'tag' }, 'проход');
  } else if (editable) {
    scoreEl = h('input', {
      class: 'score-in', name: `score-${m.id}-${side}`, type: 'number', inputmode: 'numeric', min: '0', max: '99', step: '1', placeholder: '–',
      value: r.score ? String(r.score[side]) : '', 'data-mid': m.id, 'data-side': String(side), 'aria-label': `Счёт: ${name}`,
    });
  } else {
    let txt = '';
    if (done) txt = r.score ? String(r.score[side]) : r.winner === pid ? 'W' : 'L';
    scoreEl = h('span', { class: 'score' }, txt);
  }
  row.append(seedEl, nameEl, scoreEl);
  if (admin && (w1 || editable)) row.classList.add('draggable');
  return row;
}

function cardEl(m, r, p, num) {
  const champ = ui.res.champion;
  const isDecider = !!champ && ui.res.bracket.deciders.includes(m.id) && r.winner === champ && (r.status === 'done' || r.status === 'bye');
  const cls = ['match', `st-${r.status}`, `vis-${p.vis}`, `sec-${m.section}`];
  if (isDecider) cls.push('decider');
  if (m.id === 'GF2' && r.status === 'pending') cls.push('maybe');
  const card = h('div', {
    class: cls.join(' '), 'data-mid': m.id, role: 'group',
    'aria-label': num ? `Матч #${num}` : 'Авто-проход',
    style: `left:${p.x}px;top:${p.top}px;width:${G.CW}px;height:${p.h}px`,
  });
  const bo = ui.state.bestOf[m.key];
  if (p.vis === 'full') {
    const meta = h('div', { class: 'meta' },
      num ? h('span', { class: 'mnum' }, `#${num}`) : null,
      h('span', { class: 'meta-sp' }),
      bo ? h('span', { class: 'bo' }, `BO${bo}`) : null);
    if (ui.admin && r.status === 'done') {
      meta.append(h('button', {
        type: 'button', class: 'clear-btn', 'data-act': 'clear', 'data-mid': m.id,
        'aria-label': `Сбросить результат матча ${num ? `#${num}` : m.id}`,
      }, 'сбросить'));
    }
    const top = rowEl(m, r, 0, isDecider);
    const bot = rowEl(m, r, 1, isDecider);
    top.classList.add('row-top');
    bot.classList.add('row-bot');
    card.append(meta, top, bot);
    if (ui.admin && r.p[0] && r.p[1] && (r.status === 'ready' || r.status === 'done')) {
      card.append(h('div', { class: 'adv-zone', 'data-mid': m.id, 'aria-hidden': 'true' }, 'Победа'));
    }
  } else {
    const side = r.p[0] === null ? 1 : 0;
    const solo = rowEl(m, r, side, isDecider, true);
    solo.classList.add('row-top', 'row-bot');
    card.append(solo);
  }
  return card;
}

function connectorPath(x1, y1, x2, y2) {
  const xm = x2 - G.CGAP / 2;
  if (Math.abs(y2 - y1) < 1) return `M${x1} ${y1}H${x2}`;
  const dir = y2 > y1 ? 1 : -1;
  const rr = Math.min(8, Math.abs(y2 - y1) / 2);
  return `M${x1} ${y1}H${xm - rr}Q${xm} ${y1} ${xm} ${y1 + dir * rr}V${y2 - dir * rr}Q${xm} ${y2} ${xm + rr} ${y2}H${x2}`;
}

/** Порядок Tab внутри карточки: имя 1 → имя 2 → счёт 1 → счёт 2 (оба поля счёта подряд). */
function cardTabOrder(card) {
  const q = (sel) => card.querySelector(sel);
  return [q('.row-top .pick'), q('.row-bot .pick'), q('.row-top .score-in'), q('.row-bot .score-in')].filter(Boolean);
}

function onCardKeydown(e) {
  const t = e.target;
  if (!t.classList || !(t.classList.contains('score-in') || t.classList.contains('pick'))) return;
  const card = t.closest('.match');
  if (!card) return;
  if (e.key === 'Enter' && t.classList.contains('score-in')) {
    e.preventDefault();
    const other = card.querySelector(`.score-in[data-side="${t.dataset.side === '0' ? '1' : '0'}"]`);
    // Enter в первом поле переходит ко второму (если оно пустое), иначе — фиксирует счёт.
    if (t.dataset.side === '0' && other && other.value.trim() === '') other.focus();
    else {
      // blur фиксирует счёт и перерисовывает сетку; возвращаем фокус в ту же карточку
      const mid = t.dataset.mid;
      t.blur();
      setTimeout(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        const q = (sel) => el.canvas.querySelector(`${sel}[data-mid="${mid}"]`);
        const target = q('.score-in[data-side="1"]') || q('.pick') || q('.score-in');
        if (target) target.focus();
      }, 0);
    }
    return;
  }
  if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey) return;
  const order = cardTabOrder(card);
  if (order.length < 2 || !order.some((n) => n.classList.contains('score-in'))) return;
  const i = order.indexOf(t);
  if (i < 0) return;
  const j = e.shiftKey ? i - 1 : i + 1;
  // Выход за пределы карточки — естественный порядок (первый/последний элемент совпадают с DOM).
  if (j < 0 || j >= order.length) return;
  e.preventDefault();
  order[j].focus();
}

function focusKeyOf(node) {
  if (!node || !node.dataset) return null;
  const cls = node.classList.contains('score-in') ? 'score-in' : node.classList.contains('pick') ? 'pick' : null;
  if (!cls || !node.dataset.mid) return null;
  return `.${cls}[data-mid="${node.dataset.mid}"][data-side="${node.dataset.side}"]`;
}

function renderBracket() {
  if (!ui.state) return;
  const B = ui.res.bracket;
  const RES = ui.res;
  const L = computeLayout(B, RES, ui.admin);
  ui.layout = L;
  ui.nums = numberMatches(B, RES);
  ui.hl = null;
  el.canvas.classList.remove('hovering');
  const focusSel = el.canvas.contains(document.activeElement) ? focusKeyOf(document.activeElement) : null;

  const frag = document.createDocumentFragment();
  const svg = svgEl('svg', { class: 'lines', width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`, 'aria-hidden': 'true' });
  for (const m of B.matches) {
    const to = L.pos[m.id];
    if (to.vis === 'hidden') continue;
    m.sources.forEach((src, side) => {
      if (src.type === 'seed' || src.type === 'loser') return;
      if (src.type === 'reset' && side === 1) return;
      const from = L.pos[src.match];
      if (!from || from.vis === 'hidden') return;
      const fr = RES.matches[src.match];
      const traveller = src.type === 'winner' ? fr.winner : null;
      const path = svgEl('path', { d: connectorPath(from.x + G.CW, from.cy, to.x, to.cy), class: 'ln' });
      if (traveller) {
        path.classList.add('ln-done');
        path.dataset.pid = traveller;
      }
      if (from.vis === 'compact' || src.type === 'reset') path.classList.add('ln-soft');
      svg.append(path);
    });
  }
  frag.append(svg);

  for (const t of L.titles) frag.append(h('div', { class: 'sec-title', style: `left:${t.x}px;top:${t.y}px` }, t.text));
  for (const lb of L.labels) {
    frag.append(h('div', { class: `col-label${lb.gold ? ' gold' : ''}`, style: `left:${lb.x}px;top:${lb.y}px;width:${G.CW}px` }, lb.text));
  }
  for (const m of B.matches) {
    const p = L.pos[m.id];
    if (p.vis === 'hidden') continue;
    frag.append(cardEl(m, RES.matches[m.id], p, ui.nums[m.id]));
  }
  el.canvas.replaceChildren(frag);
  el.canvas.style.width = `${L.width}px`;
  el.canvas.style.height = `${L.height}px`;
  applyZoom();

  if (focusSel) {
    const again = el.canvas.querySelector(focusSel);
    if (again) again.focus({ preventScroll: true });
  }
}

function setHighlight(pid) {
  if (pid === ui.hl) return;
  ui.hl = pid;
  for (const n of el.canvas.querySelectorAll('.hl, .has-hl')) n.classList.remove('hl', 'has-hl');
  el.canvas.classList.toggle('hovering', !!pid);
  if (!pid) return;
  for (const n of el.canvas.querySelectorAll('[data-pid]')) {
    if (n.dataset.pid !== pid) continue;
    n.classList.add('hl');
    const card = n.closest('.match');
    if (card) card.classList.add('has-hl');
  }
}

/* ---------------- Участники ---------------- */

function renderPlayers() {
  const s = ui.state;
  const rows = s.participants.map((p) => ({ p, info: ui.standings.get(p.id) }))
    .sort((a, b) => (a.info.seed ?? 999) - (b.info.seed ?? 999));
  let alive = 0;
  let out = 0;
  const body = rows.map(({ p, info }) => {
    let pill;
    if (info.status === 'champion') pill = h('span', { class: 'pill pill-gold' }, trophyIcon('ic ic-xs'), 'чемпион');
    else if (info.status === 'out') {
      out++;
      pill = h('span', { class: 'pill pill-out' }, 'выбыл');
    } else {
      alive++;
      pill = h('span', { class: 'pill pill-alive' }, 'в игре');
    }
    const place = info.place ? (info.place[0] === info.place[1] ? String(info.place[0]) : `${info.place[0]}–${info.place[1]}`) : '—';
    return h('tr', { class: `pl-${info.status}` },
      h('td', { class: 'seedcell' }, info.seed ? String(info.seed) : '—'),
      h('td', { class: 'namecell' }, h('span', { class: 'pname', title: p.name }, p.name)),
      h('td', null, pill),
      h('td', { class: 'num col-games' }, `${info.wins}–${info.losses}`),
      h('td', { class: 'num' }, place));
  });
  el.playersBody.replaceChildren(...body);
  const n = s.participants.length;
  const champ = ui.res.champion;
  const parts = [
    h('span', null, h('b', null, String(n)), ` ${plural(n, ['участник', 'участника', 'участников'])}`),
    h('span', null, 'в игре: ', h('b', null, String(alive))),
    h('span', null, 'выбыло: ', h('b', null, String(out))),
  ];
  if (champ && ui.byId.has(champ)) parts.push(h('span', { class: 'gold' }, 'чемпион: ', h('b', null, ui.byId.get(champ).name)));
  el.playersSummary.replaceChildren(...parts);
}

/* ---------------- Настройки ---------------- */

function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
}

function section(title, ...content) {
  return h('section', { class: 'set-sec' }, h('h3', null, title), ...content);
}

function renderSettings() {
  const s = ui.state;
  const body = el.settingsBody;
  const active = document.activeElement;
  const focusKey = body.contains(active) && active.dataset ? active.dataset.fk : null;
  const B = ui.res.bracket;

  const titleInput = h('input', { type: 'text', name: 'title', value: s.title, maxlength: String(E.MAX_TITLE_LENGTH), 'data-fk': 'title' });
  titleInput.addEventListener('change', () => {
    const next = E.updateSettings(ui.state, { title: titleInput.value });
    if (titleInput.value !== next.title) titleInput.value = next.title;
    apply(next, { keepSettings: true });
  });

  const fmtBtn = (value, text) => h('button', {
    type: 'button', class: `seg-btn${s.format === value ? ' on' : ''}`, 'aria-pressed': s.format === value ? 'true' : 'false', 'data-fk': `fmt-${value}`,
    onclick: () => { if (ui.state.format !== value) apply(E.updateSettings(ui.state, { format: value })); },
  }, text);

  const check = (key, text, disabled) => {
    const input = h('input', { type: 'checkbox', name: key, 'data-fk': key });
    input.checked = !!s[key];
    input.disabled = !!disabled;
    input.addEventListener('change', () => apply(E.updateSettings(ui.state, { [key]: input.checked })));
    return h('label', { class: `check${disabled ? ' disabled' : ''}` }, input, h('span', null, text));
  };

  const boRows = E.roundKeys(s).map(({ key, label }) => {
    const sel = h('select', { name: `bo-${key}`, 'data-fk': `bo-${key}`, 'aria-label': `Формат матчей: ${label}` },
      h('option', { value: '' }, '—'),
      ...E.BEST_OF_VALUES.map((v) => h('option', { value: String(v) }, `BO${v}`)));
    sel.value = s.bestOf[key] ? String(s.bestOf[key]) : '';
    sel.addEventListener('change', () => apply(E.setBestOf(ui.state, key, sel.value || null)));
    return h('div', { class: 'bo-row' }, h('span', null, label), sel);
  });

  const n = s.participants.length;
  const seedOf = (id) => (ui.standings.get(id) || {}).seed;
  const plist = s.participants.map((p, i) => {
    const inp = h('input', { type: 'text', name: `participant-${p.id}`, value: p.name, maxlength: String(E.MAX_NAME_LENGTH), 'data-fk': `pn-${p.id}`, 'aria-label': `Имя участника ${i + 1}` });
    inp.addEventListener('change', () => {
      const cur = ui.byId.get(p.id);
      if (!cur) return;
      const v = inp.value.trim();
      if (!v) {
        inp.value = cur.name;
        return;
      }
      const next = E.renameParticipant(ui.state, p.id, v);
      const np = next.participants.find((x) => x.id === p.id);
      // обновляем панель на месте (нормализованное имя, подпись кнопки удаления), без перерисовки
      if (np) {
        if (inp.value !== np.name) inp.value = np.name;
        del.setAttribute('aria-label', `Удалить участника ${np.name}`);
      }
      apply(next, { keepSettings: true });
    });
    const del = h('button', {
      type: 'button', class: 'btn btn-icon btn-danger-quiet', 'aria-label': `Удалить участника ${p.name}`, title: 'Удалить', 'data-fk': `pd-${p.id}`,
      disabled: n <= MIN_PLAYERS,
      onclick: () => removePlayer(p.id),
    }, '×');
    const sd = seedOf(p.id);
    return h('li', { class: 'p-item' }, h('span', { class: 'p-num', title: 'Посев' }, sd ? String(sd) : '—'), inp, del);
  });

  const bulk = h('textarea', { rows: '6', name: 'bulk', 'data-fk': 'bulk', placeholder: 'Одно имя на строку' });
  const bulkBtn = h('button', {
    type: 'button', class: 'btn',
    onclick: () => {
      const names = bulk.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (names.length < MIN_PLAYERS || names.length > MAX_PLAYERS) {
        toast(`Нужно от ${MIN_PLAYERS} до ${MAX_PLAYERS} имён (сейчас ${names.length}).`, 'error');
        return;
      }
      const list = names.map((name, i) => (i < ui.state.participants.length ? { id: ui.state.participants[i].id, name } : { name }));
      apply(E.setParticipants(ui.state, list)).then((ok) => { if (ok) toast('Список участников обновлён', 'success'); });
    },
  }, 'Применить список');

  body.replaceChildren(
    section('Турнир', field('Название', titleInput)),
    section('Формат',
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Формат турнира' }, fmtBtn('double', 'Двойное выбывание'), fmtBtn('single', 'Одиночное выбывание')),
      check('thirdPlace', 'Матч за 3-е место', s.format !== 'single'),
      check('grandFinalReset', 'Перезапуск гранд-финала (если победит финалист нижней сетки)', s.format !== 'double'),
      h('p', { class: 'muted small' }, `Сетка на ${B.size} мест: ${B.size - n ? `${B.size - n} BYE (авто-проход для лучших посевов)` : 'без BYE'}.`)),
    section('Формат матчей', h('div', { class: 'bo-list' }, ...boRows)),
    section('Посев',
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: shuffleSeeding }, 'Перемешать посев'),
        h('button', { type: 'button', class: 'btn', onclick: () => apply(E.resetSeeding(ui.state)) }, 'Посев по списку'),
        h('button', { type: 'button', class: 'btn btn-danger', onclick: clearAll }, 'Сбросить все результаты')),
      h('p', { class: 'muted small' }, 'Посев по списку: первый в списке — 1-й посев. Можно также перетаскивать участников по слотам 1-го раунда прямо в сетке.')),
    section(`Участники (${n})`,
      h('ol', { class: 'p-list' }, ...plist),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', disabled: n >= MAX_PLAYERS, onclick: addPlayer }, '+ Добавить участника')),
      h('details', { class: 'bulk' },
        h('summary', null, 'Вставить список целиком'),
        h('p', { class: 'muted small' }, 'Имена по одному на строку, по порядку посева. Существующие участники переименуются по порядку.'),
        bulk, bulkBtn)),
  );

  if (focusKey) {
    const again = body.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`);
    if (again) again.focus({ preventScroll: true });
  }
}

function openSettings() {
  ui.settingsOpen = true;
  renderSettings();
  el.settings.hidden = false;
  el.drawerBackdrop.hidden = false;
  el.settingsBtn.setAttribute('aria-expanded', 'true');
  el.settingsClose.focus();
}

function closeSettings() {
  if (!ui.settingsOpen) return;
  ui.settingsOpen = false;
  el.settings.hidden = true;
  el.drawerBackdrop.hidden = true;
  el.settingsBtn.setAttribute('aria-expanded', 'false');
  if (ui.admin) el.settingsBtn.focus();
}

/* ================================================================== */
/* Действия администратора                                            */
/* ================================================================== */

function pickWinner(mid, side) {
  const r = ui.res.matches[mid];
  if (!r || (r.status === 'done' && r.winnerIdx === side)) return;
  const next = tryOp(() => E.setResult(ui.state, mid, side));
  if (next) apply(next, { except: mid });
}

function clearMatch(mid) {
  const next = tryOp(() => E.clearResult(ui.state, mid));
  if (next) apply(next, { except: mid });
}

function onScoreChange(mid) {
  const inputs = el.canvas.querySelectorAll(`input.score-in[data-mid="${mid}"]`);
  if (inputs.length !== 2) return;
  const parse = (v) => {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(99, Math.floor(n)) : null;
  };
  const a = parse(inputs[0].value);
  const b = parse(inputs[1].value);
  const r = ui.res.matches[mid];
  if (a === null && b === null) {
    if (r.status === 'done' && r.score) apply(tryOp(() => E.setResult(ui.state, mid, r.winnerIdx, null)), { except: mid });
    return;
  }
  if (a === null || b === null) return; // ждём второе число
  let w = a > b ? 0 : b > a ? 1 : null;
  if (w === null) w = r.status === 'done' ? r.winnerIdx : null;
  if (w === null) {
    toast('Счёт равный — выберите победителя кликом по имени.', 'info');
    return;
  }
  const next = tryOp(() => E.setResult(ui.state, mid, w, [a, b]));
  if (next) apply(next, { except: mid });
}

async function shuffleSeeding() {
  if (Object.keys(ui.state.results).length) {
    const ok = await confirmDialog('Перемешать посев? Результаты сыгранных матчей будут сброшены.', 'Перемешать');
    if (!ok) return;
  }
  apply(E.shuffleSeeding(ui.state), { ask: false });
}

async function clearAll() {
  const n = Object.keys(ui.state.results).length;
  if (!n) {
    toast('Результатов пока нет.', 'info');
    return;
  }
  const ok = await confirmDialog(`Сбросить все результаты (${n})? Это можно отменить кнопкой «Отменить».`, 'Сбросить всё');
  if (ok) apply(E.clearAllResults(ui.state), { ask: false });
}

function addPlayer() {
  if (ui.state.participants.length >= MAX_PLAYERS) return;
  apply(E.addParticipant(ui.state)).then((ok) => {
    if (!ok || !ui.settingsOpen) return;
    const items = el.settingsBody.querySelectorAll('.p-item input');
    const last = items[items.length - 1];
    if (last) {
      last.focus();
      last.select();
    }
  });
}

async function removePlayer(id) {
  const p = ui.byId.get(id);
  if (!p || ui.state.participants.length <= MIN_PLAYERS) return;
  const next = E.removeParticipant(ui.state, id);
  const removed = E.removedResults(ui.state, next).length;
  const extra = removed ? ` Будет сброшено результатов: ${removed}.` : '';
  const sizeChange = next.slots.length !== ui.state.slots.length ? ' Размер сетки изменится, посев будет пересчитан.' : '';
  const ok = await confirmDialog(`Удалить участника «${p.name}»?${extra}${sizeChange}`, 'Удалить');
  if (ok) apply(next, { ask: false });
}

function exportJson() {
  const blob = new Blob([E.serialize(ui.state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: 'bracket.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Файл bracket.json скачан.', 'success');
}

async function importJson(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    toast('Файл слишком большой.', 'error');
    return;
  }
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('Не удалось прочитать JSON: файл повреждён.', 'error');
    return;
  }
  let next;
  try {
    next = E.normalizeState(data);
  } catch {
    toast('Не удалось разобрать данные сетки в файле.', 'error');
    return;
  }
  const ok = await confirmDialog(`Заменить текущую сетку данными из «${file.name}» (${next.participants.length} участн.)? Это можно отменить.`, 'Импортировать');
  if (!ok) return;
  pushState(next);
  toast('Импортировано. Нажмите «Сохранить», чтобы опубликовать.', 'success');
}

/* ---------------- вход / выход ---------------- */

let checkingToken = false;
async function openAdmin() {
  if (ui.admin || checkingToken) return;
  const token = S.currentToken();
  if (!token) {
    openLogin();
    return;
  }
  // Сохранённый токен мог истечь или быть отозван — проверяем до входа, а не при первом сохранении.
  checkingToken = true;
  let v;
  try {
    v = await S.verifyToken(token);
  } finally {
    checkingToken = false;
  }
  if (ui.admin) return;
  if (v.ok) {
    enterAdmin();
  } else if (v.status === 0) {
    enterAdmin();
    toast('Не удалось проверить токен: нет связи с GitHub. Сохранение может не сработать.', 'error', 7000);
  } else {
    S.clearToken();
    openLogin(`Сохранённый токен не подошёл: ${v.error}`);
  }
}

function openLogin(error = '') {
  el.loginError.textContent = error;
  el.loginError.hidden = !error;
  el.tokenInput.value = '';
  el.rememberInput.checked = false;
  el.loginSubmit.disabled = false;
  el.loginSubmit.textContent = 'Войти';
  if (!el.loginDlg.open) el.loginDlg.showModal();
  el.tokenInput.focus();
}

async function submitLogin(e) {
  e.preventDefault();
  const token = el.tokenInput.value.trim();
  el.loginError.hidden = true;
  el.loginSubmit.disabled = true;
  el.loginSubmit.textContent = 'Проверка…';
  const v = await S.verifyToken(token);
  el.loginSubmit.disabled = false;
  el.loginSubmit.textContent = 'Войти';
  if (!v.ok) {
    el.loginError.textContent = v.error;
    el.loginError.hidden = false;
    el.tokenInput.focus();
    return;
  }
  S.storeToken(token, el.rememberInput.checked);
  el.tokenInput.value = '';
  el.loginDlg.close();
  toast('Вход выполнен.', 'success', 2500);
  if (!ui.admin) enterAdmin();
  else renderAdminBar();
  if (ui.pendingSave) {
    ui.pendingSave = false;
    save();
  }
}

async function enterAdmin() {
  ui.admin = true;
  if (location.hash !== '#admin') history.replaceState(null, '', '#admin');
  ui.history = [ui.state];
  ui.hIndex = 0;
  renderAll();
  // Зритель мог видеть устаревший файл GitHub Pages (или пустую сетку после ошибки загрузки):
  // перечитываем данные через API с токеном, пока админ ещё ничего не изменил.
  ui.draftHold = true;
  try {
    if (S.currentToken() || ui.source !== 'api') {
      const res = await S.load({ useApi: true, fresh: true });
      if (res.tokenRejected) toast('Сохранённый токен GitHub недействителен и удалён. Войдите заново.', 'error', 8000);
      if (ui.admin && !res.notModified && ui.history.length === 1 && !isDirty() && res.text !== ui.baselineText) {
        adoptLoaded(res);
        toast('Загружена актуальная версия сетки с GitHub.', 'info', 3500);
      }
    }
  } catch {
    /* остаёмся на уже загруженных данных; конфликт при сохранении всё равно будет проверен */
  } finally {
    ui.draftHold = false;
  }
  if (ui.admin) await offerDraft();
  if (ui.admin && isDirty()) saveDraft(); // правки, сделанные пока перечитывали данные
}

async function leaveAdmin({ forget = false } = {}) {
  if (!ui.admin) return;
  if (ui.saving) {
    toast('Подождите, идёт сохранение…', 'info');
    return;
  }
  if (isDirty()) {
    const ok = await confirmDialog('Есть несохранённые изменения. Они останутся черновиком в этом браузере. Выйти из режима админа?', 'Выйти');
    if (!ok) return;
  }
  ui.admin = false;
  closeSettings();
  if (forget) S.clearToken();
  if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
  resetHistory(ui.savedState);
  if (forget) toast('Вы вышли. Токен удалён из этого браузера.', 'info');
}

/* ---------------- сохранение ---------------- */

async function save() {
  if (!ui.admin || ui.saving) return;
  const token = S.currentToken();
  if (!token) {
    ui.pendingSave = true;
    openLogin();
    return;
  }
  const snapshot = ui.state;
  const preKey = stateKey(snapshot);
  const next = { ...snapshot, updatedAt: new Date().toISOString() };
  const text = E.serialize(next);
  const message = `Обновление сетки: ${new Date().toLocaleString('ru-RU')}`;
  ui.saving = true;
  renderAdminBar();
  try {
    let r = await S.save(text, { token, baselineText: ui.baselineText, message });
    if (r.conflict) {
      const why = ui.baselineText == null
        ? 'При открытии страницы данные сетки не загрузились, а на GitHub уже есть сохранённая сетка.'
        : 'Данные на GitHub изменились после того, как вы открыли страницу (возможно, сохранял другой админ).';
      const ok = await confirmDialog(`${why} Перезаписать их вашей версией?`, 'Перезаписать', 'Не перезаписывать');
      if (ok !== true) {
        if (ok === false && r.remoteText != null) await offerRemote(r.remoteText);
        return;
      }
      r = await S.save(text, { token, force: true, message });
    }
    ui.baselineText = text;
    ui.etag = null;
    ui.savedState = next;
    ui.savedKey = stateKey(next);
    ui.source = ui.source === 'default' ? 'api' : ui.source;
    if (!ui.admin) {
      // админ-режим успели закрыть во время сохранения — показываем опубликованную версию
      resetHistory(next);
    } else if (stateKey(ui.state) === preKey) {
      // за время сохранения ничего не менялось — подставляем версию с новым updatedAt
      const i = ui.history.indexOf(ui.state);
      if (i >= 0) ui.history[i] = next;
      setState(next, { keepSettings: true });
      lsDel(DRAFT_KEY);
    } else {
      // админ продолжал править во время сохранения: его правки остаются (и остаются несохранёнными)
      renderAll({ keepSettings: true });
      saveDraft();
    }
    const msg = h('span', null,
      h('b', null, 'Сохранено. '),
      'Зрители, загружающие сетку через GitHub API, увидят изменения сразу; файл на GitHub Pages обновится примерно через минуту.',
      r.commitUrl ? h('a', { href: r.commitUrl, target: '_blank', rel: 'noopener noreferrer', class: 'toast-link' }, ' Коммит') : null);
    toast(msg, 'success', 9000);
  } catch (err) {
    toast(err && err.message ? err.message : 'Не удалось сохранить.', 'error', 9000);
    if (err && err.status === 401) S.clearToken();
  } finally {
    ui.saving = false;
    renderAdminBar();
  }
}

/** После отказа перезаписывать: предлагает загрузить версию с GitHub (локальные правки остаются в истории). */
async function offerRemote(remoteText) {
  let state;
  try {
    state = E.normalizeState(JSON.parse(remoteText));
  } catch {
    toast('Версия на GitHub повреждена. Можно перезаписать её своей или экспортировать JSON.', 'error', 8000);
    return;
  }
  const ok = await confirmDialog(
    'Загрузить актуальную версию с GitHub? Ваши правки не пропадут: их можно вернуть кнопкой «Отменить» (или экспортировать JSON заранее).',
    'Загрузить с GitHub',
    'Оставить мою версию',
  );
  if (ok !== true) return;
  ui.baselineText = remoteText;
  ui.savedState = state;
  ui.savedKey = stateKey(state);
  if (ui.source === 'default') ui.source = 'api';
  pushState(state);
  toast('Загружена версия с GitHub. «Отменить» вернёт ваши правки.', 'info', 7000);
}

/* ================================================================== */
/* Масштаб и панорамирование                                           */
/* ================================================================== */

function applyZoom() {
  const L = ui.layout;
  if (!L) return;
  el.canvas.style.transform = `scale(${ui.zoom})`;
  el.sizer.style.width = `${Math.ceil(L.width * ui.zoom)}px`;
  el.sizer.style.height = `${Math.ceil(L.height * ui.zoom)}px`;
  const pct = Math.round(ui.zoom * 100);
  el.zoomReset.textContent = `${pct}%`;
  el.zoomReset.setAttribute('aria-label', `Масштаб ${pct}% — сбросить до 100%`);
}

function setZoom(z, anchor) {
  const vp = el.viewport;
  const nz = clamp(Math.round(z * 100) / 100, 0.2, 2);
  const rect = vp.getBoundingClientRect();
  const ax = anchor ? anchor.x - rect.left : vp.clientWidth / 2;
  const ay = anchor ? anchor.y - rect.top : vp.clientHeight / 2;
  const cx = (vp.scrollLeft + ax) / ui.zoom;
  const cy = (vp.scrollTop + ay) / ui.zoom;
  ui.zoom = nz;
  applyZoom();
  vp.scrollLeft = cx * nz - ax;
  vp.scrollTop = cy * nz - ay;
  lsSet(ZOOM_KEY, String(nz));
}

function fitZoom() {
  const L = ui.layout;
  if (!L) return;
  const vp = el.viewport;
  const z = Math.min((vp.clientWidth - 8) / L.width, (vp.clientHeight - 8) / L.height);
  setZoom(clamp(z, 0.2, 1.25));
  vp.scrollTo({ left: 0, top: 0 });
}

function initialZoom() {
  if (ui.zoomInit || !ui.layout) return;
  ui.zoomInit = true;
  const saved = Number(lsGet(ZOOM_KEY));
  if (saved >= 0.2 && saved <= 2) ui.zoom = saved;
  else ui.zoom = clamp(el.viewport.clientWidth / ui.layout.width, 0.6, 1);
  applyZoom();
}

let pan = null;
function onViewportPointerDown(e) {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  if (e.target.closest('button, input, select, textarea, a, .draggable')) return;
  pan = { id: e.pointerId, x: e.clientX, y: e.clientY, sl: el.viewport.scrollLeft, st: el.viewport.scrollTop, moved: false };
}

/* ================================================================== */
/* Drag & drop (Pointer Events — мышь и касание)                       */
/* ================================================================== */

let drag = null;

function onCanvasPointerDown(e) {
  if (!ui.admin) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('input, .clear-btn')) return;
  const row = e.target.closest('.row.draggable');
  if (!row || !row.dataset.pid) return;
  drag = {
    row, pid: row.dataset.pid, mid: row.dataset.mid, side: Number(row.dataset.side),
    id: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, targets: new Map(), ghost: null, over: null,
  };
}

function addTarget(node, action) {
  if (!node || drag.targets.has(node)) return;
  node.classList.add('drop-ok');
  drag.targets.set(node, action);
}

function startDrag() {
  drag.started = true;
  try { drag.row.setPointerCapture(drag.id); } catch { /* ignore */ }
  setHighlight(null);
  const B = ui.res.bracket;
  const m = B.byId[drag.mid];
  const r = ui.res.matches[drag.mid];
  const { mid, side } = drag;

  if (m.section === 'upper' && m.round === 1) {
    const mySlot = m.sources[side].index;
    for (const t of el.canvas.querySelectorAll('.row[data-slot]')) {
      const s = Number(t.dataset.slot);
      if (s !== mySlot) addTarget(t, () => swapAction(mySlot, s));
    }
  }
  if (r.p[0] && r.p[1] && (r.status === 'ready' || r.status === 'done')) {
    const nx = B.winnerTo[mid];
    if (nx) addTarget(el.canvas.querySelector(`.row[data-mid="${nx.match}"][data-side="${nx.side}"]`), () => pickWinner(mid, side));
    const zone = el.canvas.querySelector(`.adv-zone[data-mid="${mid}"]`);
    if (zone) {
      zone.classList.add('show');
      addTarget(zone, () => pickWinner(mid, side));
    }
  }
  const P = ui.byId.get(drag.pid);
  drag.ghost = h('div', { class: 'ghost', 'aria-hidden': 'true' }, P ? P.name : '');
  document.body.append(drag.ghost);
  document.body.classList.add('dragging');
  drag.row.classList.add('drag-src');
}

function swapAction(i, j) {
  const next = tryOp(() => E.swapSlots(ui.state, i, j));
  if (next) apply(next);
}

function onWindowPointerMove(e) {
  if (pan && e.pointerId === pan.id) {
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) > 3) {
      pan.moved = true;
      el.viewport.classList.add('panning');
    }
    if (pan.moved) {
      el.viewport.scrollLeft = pan.sl - dx;
      el.viewport.scrollTop = pan.st - dy;
    }
    return;
  }
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    startDrag();
  }
  e.preventDefault();
  drag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 10}px)`;

  // автопрокрутка у краёв
  const vr = el.viewport.getBoundingClientRect();
  const edge = 44;
  if (e.clientX < vr.left + edge) el.viewport.scrollLeft -= 16;
  else if (e.clientX > vr.right - edge) el.viewport.scrollLeft += 16;
  if (e.clientY < vr.top + edge) el.viewport.scrollTop -= 16;
  else if (e.clientY > vr.bottom - edge) el.viewport.scrollTop += 16;

  const under = document.elementFromPoint(e.clientX, e.clientY);
  let target = null;
  if (under) {
    for (const t of drag.targets.keys()) {
      if (t === under || t.contains(under)) {
        target = t;
        break;
      }
    }
  }
  if (target !== drag.over) {
    if (drag.over) drag.over.classList.remove('drop-hover');
    if (target) target.classList.add('drop-hover');
    drag.over = target;
  }
}

function endDrag(e, cancelled) {
  if (pan && e.pointerId === pan.id) {
    if (pan.moved) {
      ui.suppressClick = true;
      setTimeout(() => { ui.suppressClick = false; }, 0);
    }
    el.viewport.classList.remove('panning');
    pan = null;
  }
  if (!drag || e.pointerId !== drag.id) return;
  const d = drag;
  drag = null;
  if (!d.started) return;
  ui.suppressClick = true;
  setTimeout(() => { ui.suppressClick = false; }, 0);
  for (const t of d.targets.keys()) t.classList.remove('drop-ok', 'drop-hover', 'show');
  d.row.classList.remove('drag-src');
  if (d.ghost) d.ghost.remove();
  document.body.classList.remove('dragging');
  if (!cancelled && d.over && d.targets.has(d.over)) d.targets.get(d.over)();
}

/* ================================================================== */
/* Загрузка и автообновление                                           */
/* ================================================================== */

function adoptLoaded(res) {
  ui.baselineText = res.text ?? null;
  ui.etag = res.etag || null;
  ui.source = res.source;
  ui.lastCheck = Date.now();
  ui.savedState = res.state;
  ui.savedKey = stateKey(res.state);
  resetHistory(res.state);
}

async function refresh() {
  if (ui.refreshing || ui.admin || !ui.state) return;
  ui.refreshing = true;
  try {
    // Каждую минуту читаем файл GitHub Pages (без лимитов), а GitHub API — раз в 5 минут
    // (с сохранённым токеном — каждую минуту: у авторизованных запросов лимит 5000/час и 304 бесплатны).
    const apiEvery = S.currentToken() ? REFRESH_MS : API_REFRESH_MS;
    const useApi = Date.now() - ui.lastApiCheck >= apiEvery - 1000;
    if (useApi) ui.lastApiCheck = Date.now();
    const res = await S.load({ etag: ui.etag, useApi });
    ui.lastCheck = Date.now();
    if (res.tokenRejected) toast('Сохранённый токен GitHub недействителен и удалён из браузера.', 'error', 8000);
    if (!res.notModified && res.text !== ui.baselineText) {
      const cur = Date.parse(ui.state.updatedAt || 0) || 0;
      const nw = Date.parse(res.state.updatedAt || 0) || 0;
      // не откатываемся на более старую версию (например, кэш GitHub Pages после лимита API)
      if (nw >= cur && !ui.admin) adoptLoaded(res);
    } else if (res.source) {
      ui.source = res.source;
    }
    renderHeader();
  } catch {
    /* сеть недоступна — попробуем в следующий раз */
  } finally {
    ui.refreshing = false;
  }
}

/* ================================================================== */
/* Вкладки                                                             */
/* ================================================================== */

function setTab(tab) {
  ui.tab = tab;
  const isBracket = tab === 'bracket';
  el.tabBracket.setAttribute('aria-selected', String(isBracket));
  el.tabPlayers.setAttribute('aria-selected', String(!isBracket));
  el.tabBracket.tabIndex = isBracket ? 0 : -1;
  el.tabPlayers.tabIndex = isBracket ? -1 : 0;
  el.viewBracket.hidden = !isBracket;
  el.viewPlayers.hidden = isBracket;
  el.zoomCtl.hidden = !isBracket;
  if (!isBracket) renderPlayers();
}

/* ================================================================== */
/* Инициализация                                                       */
/* ================================================================== */

function cacheEls() {
  for (const id of ['title', 'subtitle', 'live', 'liveLabel', 'liveTime', 'adminBtn', 'adminBtnText', 'champion', 'adminBar',
    'undoBtn', 'redoBtn', 'dirtyState', 'settingsBtn', 'exportBtn', 'importBtn', 'saveBtn', 'logoutBtn', 'tabBracket', 'tabPlayers',
    'zoomCtl', 'zoomOut', 'zoomIn', 'zoomReset', 'zoomFit', 'viewBracket', 'viewPlayers', 'viewport', 'sizer', 'canvas', 'loading',
    'playersBody', 'playersSummary', 'settings', 'settingsBody', 'settingsClose', 'drawerBackdrop', 'loginDlg', 'loginForm',
    'loginRepo', 'tokenInput', 'rememberInput', 'loginError', 'loginLocal', 'loginCancel', 'loginSubmit', 'confirmDlg',
    'confirmText', 'confirmOk', 'confirmCancel', 'toasts', 'importFile']) {
    el[id] = document.getElementById(id);
  }
}

function bindEvents() {
  el.loginRepo.textContent = S.repoLabel();

  el.adminBtn.addEventListener('click', () => (ui.admin ? leaveAdmin() : openAdmin()));
  el.logoutBtn.addEventListener('click', () => leaveAdmin({ forget: true }));
  el.undoBtn.addEventListener('click', undo);
  el.redoBtn.addEventListener('click', redo);
  el.saveBtn.addEventListener('click', save);
  el.exportBtn.addEventListener('click', exportJson);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', () => {
    const f = el.importFile.files && el.importFile.files[0];
    el.importFile.value = '';
    importJson(f);
  });
  el.settingsBtn.addEventListener('click', () => (ui.settingsOpen ? closeSettings() : openSettings()));
  el.settingsClose.addEventListener('click', closeSettings);
  el.drawerBackdrop.addEventListener('click', closeSettings);

  el.loginForm.addEventListener('submit', submitLogin);
  el.loginCancel.addEventListener('click', () => {
    ui.pendingSave = false;
    el.loginDlg.close();
  });
  el.loginDlg.addEventListener('close', () => {
    if (!ui.admin && location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
  });
  el.loginLocal.addEventListener('click', () => {
    ui.pendingSave = false;
    el.loginDlg.close();
    if (!ui.admin) enterAdmin();
    toast('Режим без токена: можно редактировать и экспортировать JSON. Для публикации войдите с токеном.', 'info', 7000);
  });

  el.confirmOk.addEventListener('click', () => finishConfirm(true));
  el.confirmCancel.addEventListener('click', () => finishConfirm(false));
  el.confirmDlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    finishConfirm(null);
  });

  // вкладки
  el.tabBracket.addEventListener('click', () => setTab('bracket'));
  el.tabPlayers.addEventListener('click', () => setTab('players'));
  for (const t of [el.tabBracket, el.tabPlayers]) {
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = ui.tab === 'bracket' ? 'players' : 'bracket';
      setTab(next);
      (next === 'bracket' ? el.tabBracket : el.tabPlayers).focus();
    });
  }

  // масштаб
  el.zoomIn.addEventListener('click', () => setZoom(ui.zoom * 1.2));
  el.zoomOut.addEventListener('click', () => setZoom(ui.zoom / 1.2));
  el.zoomReset.addEventListener('click', () => setZoom(1));
  el.zoomFit.addEventListener('click', fitZoom);
  el.viewport.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(ui.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  el.viewport.addEventListener('pointerdown', onViewportPointerDown);

  // сетка: подсветка, клики, счёт, drag & drop
  el.canvas.addEventListener('pointerover', (e) => {
    if (drag && drag.started) return;
    const row = e.target.closest('.row[data-pid]');
    setHighlight(row ? row.dataset.pid : null);
  });
  el.canvas.addEventListener('pointerleave', () => setHighlight(null));
  el.canvas.addEventListener('focusin', (e) => {
    const row = e.target.closest('.row[data-pid]');
    setHighlight(row ? row.dataset.pid : null);
  });
  el.canvas.addEventListener('click', (e) => {
    if (ui.suppressClick) {
      ui.suppressClick = false;
      return;
    }
    if (!ui.admin) return;
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'pick') pickWinner(btn.dataset.mid, Number(btn.dataset.side));
    else if (btn.dataset.act === 'clear') clearMatch(btn.dataset.mid);
  });
  el.canvas.addEventListener('change', (e) => {
    const inp = e.target.closest('input.score-in');
    if (inp) onScoreChange(inp.dataset.mid);
  });
  el.canvas.addEventListener('keydown', onCardKeydown);
  el.canvas.addEventListener('pointerdown', onCanvasPointerDown);
  el.canvas.addEventListener('contextmenu', (e) => { if (drag && drag.started) e.preventDefault(); });
  window.addEventListener('pointermove', onWindowPointerMove, { passive: false });
  window.addEventListener('pointerup', (e) => endDrag(e, false));
  window.addEventListener('pointercancel', (e) => endDrag(e, true));

  // клавиатура
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.settingsOpen && !el.confirmDlg.open) {
      closeSettings();
      return;
    }
    if (!ui.admin || !(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    const inText = e.target.closest && e.target.closest('input[type="text"], textarea');
    if (k === 's') {
      e.preventDefault();
      save();
    } else if (!inText && (k === 'z' || k === 'я') && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if (!inText && (k === 'y' || k === 'н' || ((k === 'z' || k === 'я') && e.shiftKey))) {
      e.preventDefault();
      redo();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (ui.admin && isDirty()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#admin') openAdmin();
  });

  // автообновление (только просмотр, только когда вкладка видна)
  setInterval(() => {
    if (document.visibilityState === 'visible' && !ui.admin) refresh();
  }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !ui.admin && Date.now() - ui.lastCheck > REFRESH_MS) refresh();
  });
}

async function init() {
  cacheEls();
  bindEvents();
  let res;
  try {
    res = await S.load();
    ui.lastApiCheck = Date.now();
    if (res.tokenRejected) toast('Сохранённый токен GitHub недействителен и удалён из браузера.', 'error', 8000);
  } catch {
    res = { state: E.createState(24), text: null, source: 'default' };
    toast('Не удалось загрузить данные сетки — показана пустая сетка.', 'error', 8000);
  }
  adoptLoaded(res);
  el.loading.hidden = true;
  initialZoom();
  if (location.hash === '#admin') openAdmin();
}

init();
