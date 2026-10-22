/**
 * engine.js — чистая логика турнирной сетки (без DOM).
 * ES-модуль: работает и в браузере, и в Node (node --test).
 *
 * Все функции, меняющие состояние, неизменяемы: возвращают новый объект state
 * и никогда не трогают входной (это нужно для undo/redo).
 */

export const DEFAULT_TITLE = 'Dota 2 Турнир';
export const MAX_PARTICIPANTS = 128;
export const MAX_NAME_LENGTH = 48;
export const MAX_TITLE_LENGTH = 120;
export const BEST_OF_VALUES = [1, 3, 5];

const RESULT_KEY_RE = /^(?:[WL][1-9]\d{0,2}-[1-9]\d{0,3}|GF[12]|3RD)$/;
const ROUND_KEY_RE = /^(?:[WL][1-9]\d{0,2}|GF|3RD)$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/* ------------------------------------------------------------------ */
/* Посев                                                               */
/* ------------------------------------------------------------------ */

export function nextPow2(n) {
  let s = 2;
  while (s < n) s *= 2;
  return s;
}

/** Размер сетки (степень двойки, минимум 2) для заданного числа участников. */
export function bracketSizeFor(count) {
  return nextPow2(Math.max(2, Number(count) | 0));
}

/**
 * Стандартный рекурсивный порядок посева: для 8 — [1,8,4,5,2,7,3,6].
 * Элемент i — номер посева, стоящий в слоте i первого раунда.
 */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const len = order.length * 2;
    const next = [];
    for (const s of order) next.push(s, len + 1 - s);
    order = next;
  }
  return order;
}

/** Слоты по умолчанию: посев 1..n — участники по порядку списка, остальное — BYE (null). */
export function defaultSlots(participants, size = bracketSizeFor(participants.length)) {
  const n = participants.length;
  return seedOrder(size).map((seed) => (seed <= n ? participants[seed - 1].id : null));
}

/** Номер посева для слота index (по стандартному порядку). */
export function seedOfSlot(size, index) {
  return seedOrder(size)[index];
}

/* ------------------------------------------------------------------ */
/* Нормализация данных (никогда не падает на плохом JSON)              */
/* ------------------------------------------------------------------ */

function cleanText(value, max) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function idNumber(id) {
  const m = /^p(\d{1,9})$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** Приводит список участников к виду [{id, name}] с уникальными id. */
export function normalizeParticipants(list) {
  const items = Array.isArray(list) ? list.slice(0, MAX_PARTICIPANTS) : [];
  const parsed = [];
  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number') parsed.push({ id: '', name: item });
    else if (item && typeof item === 'object') parsed.push({ id: item.id, name: item.name });
  }
  const seen = new Set();
  let maxNum = 0;
  for (const p of parsed) {
    const id = cleanText(p.id, 64);
    p.id = id && !seen.has(id) ? id : '';
    if (p.id) {
      seen.add(p.id);
      maxNum = Math.max(maxNum, idNumber(p.id));
    }
  }
  return parsed.map((p, i) => {
    let id = p.id;
    if (!id) {
      do id = `p${++maxNum}`; while (seen.has(id));
      seen.add(id);
    }
    const name = cleanText(p.name, MAX_NAME_LENGTH) || `Участник ${i + 1}`;
    return { id, name };
  });
}

/** Проверяет и чинит слоты: длина = размер сетки, каждый участник ровно один раз. */
export function normalizeSlots(slots, participants, size = bracketSizeFor(participants.length)) {
  if (!Array.isArray(slots) || slots.length !== size) return defaultSlots(participants, size);
  const ids = new Set(participants.map((p) => p.id));
  const used = new Set();
  const out = slots.map((v) => {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const id = String(v);
    if (!ids.has(id) || used.has(id)) return null;
    used.add(id);
    return id;
  });
  const missing = participants.filter((p) => !used.has(p.id));
  if (missing.length) {
    // Заполняем пустые слоты в порядке посева (сначала лучшие свободные посевы).
    const order = seedOrder(size);
    const posBySeed = [];
    order.forEach((seed, pos) => { posBySeed[seed] = pos; });
    for (let seed = 1; seed <= size && missing.length; seed++) {
      const pos = posBySeed[seed];
      if (out[pos] === null) out[pos] = missing.shift().id;
    }
  }
  return out;
}

function normScore(score) {
  if (!Array.isArray(score) || score.length !== 2) return undefined;
  const out = [];
  for (const v of score) {
    const n = primNumber(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    out.push(Math.min(999, Math.floor(n)));
  }
  return out;
}

/** Число из примитива (number / непустая строка); всё остальное — NaN. Number() на объекте может бросить. */
function primNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

function normBestOf(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const v = primNumber(raw[key]);
    if (ROUND_KEY_RE.test(key) && BEST_OF_VALUES.includes(v)) out[key] = v;
  }
  return out;
}

function normTitle(title) {
  return cleanText(title, MAX_TITLE_LENGTH) || DEFAULT_TITLE;
}

/**
 * Приводит произвольный (возможно, испорченный) объект к корректному state.
 * Неизвестные поля отбрасываются, отсутствующие получают значения по умолчанию.
 */
export function normalizeState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const participants = normalizeParticipants(src.participants);
  const size = bracketSizeFor(participants.length);
  const slots = normalizeSlots(src.slots, participants, size);

  const results = {};
  const legacy = {}; // результаты без p (написаны вручную) — попробуем «усыновить»
  const rawResults = src.results && typeof src.results === 'object' && !Array.isArray(src.results) ? src.results : {};
  for (const key of Object.keys(rawResults)) {
    const r = rawResults[key];
    if (!RESULT_KEY_RE.test(key) || !r || typeof r !== 'object') continue;
    const winner = primNumber(r.winner);
    if (winner !== 0 && winner !== 1) continue;
    const entry = { winner };
    const score = normScore(r.score);
    if (score) entry.score = score;
    const p = r.p;
    if (Array.isArray(p) && p.length === 2 && p.every((x) => x === null || typeof x === 'string')) {
      entry.p = [p[0], p[1]];
      results[key] = entry;
    } else {
      legacy[key] = entry;
    }
  }

  let updatedAt = null;
  if (typeof src.updatedAt === 'string' && !Number.isNaN(Date.parse(src.updatedAt))) updatedAt = src.updatedAt;

  let state = {
    version: 1,
    title: normTitle(src.title),
    format: src.format === 'single' ? 'single' : 'double',
    thirdPlace: typeof src.thirdPlace === 'boolean' ? src.thirdPlace : true,
    grandFinalReset: typeof src.grandFinalReset === 'boolean' ? src.grandFinalReset : true,
    participants,
    slots,
    results,
    bestOf: normBestOf(src.bestOf),
    updatedAt,
  };
  // Сначала «усыновляем» результаты без p (в порядке сетки), и только потом чистим:
  // иначе зависящие от них результаты с p были бы удалены как недействительные.
  if (Object.keys(legacy).length) state = adoptLegacyResults(state, legacy);
  return pruneResults(state);
}

function adoptLegacyResults(state, legacy) {
  let s = state;
  for (const m of buildBracket(s).matches) {
    if (!legacy[m.id] || s.results[m.id]) continue;
    const r = resolve(s).matches[m.id];
    if (r.status === 'ready') {
      s = { ...s, results: { ...s.results, [m.id]: { ...legacy[m.id], p: [r.p[0], r.p[1]] } } };
    }
  }
  return s;
}

/** Новое состояние с count участниками «Участник 1..N». */
export function createState(count = 24, options = {}) {
  const participants = Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}`, name: `Участник ${i + 1}` }));
  return normalizeState({ title: DEFAULT_TITLE, ...options, participants, slots: null, results: {} });
}

/** JSON для data/bracket.json. */
export function serialize(state) {
  return JSON.stringify(state, null, 2) + '\n';
}

/* ------------------------------------------------------------------ */
/* Структура сетки                                                     */
/* ------------------------------------------------------------------ */

function upperLabel(count, format) {
  if (count === 1) return format === 'double' ? 'Финал верхней сетки' : 'Финал';
  if (count === 2) return 'Полуфинал';
  if (count === 4) return 'Четвертьфинал';
  return `1/${count} финала`;
}

const bracketCache = new Map();
const dropInCache = new Map();

/**
 * Перестановки раундов «вливания» нижней сетки: для раунда r (2..R) — константа c,
 * матч НС с индексом k получает проигравшего W{r}-{(k xor c) + 1}.
 * XOR сохраняет структуру поддеревьев (c = m-1 — разворот, c = m/2 — обмен половин, c = 1 — попарный обмен).
 * c выбирается жадно по раундам: минимум матчей вливания, где возможна повторная встреча
 * (игроки уже могли встречаться в верхней сетке), затем минимум таких матчей в следующем
 * внутреннем раунде; при равенстве — классическое чередование «разворот / обмен половин».
 * Для сеток до 32 мест это совпадает с классической схемой, для 64+ убирает лишние повторы.
 */
function dropInConstants(size) {
  const R = Math.round(Math.log2(size));
  let cs = dropInCache.get(size);
  if (cs) return cs;
  cs = [];
  // Пул матча НС — список диапазонов индексов матчей 1-го раунда ВС [lo, hi), откуда могли прийти его игроки.
  // Два игрока могли встретиться в ВС, если диапазоны матчей, где они проиграли, вложены друг в друга.
  const range = (r, k) => [k << (r - 1), (k + 1) << (r - 1)];
  const meet = (a, b) => (a[0] <= b[0] && b[1] <= a[1]) || (b[0] <= a[0] && a[1] <= b[1]);
  const clash = (P, Q) => P.some((a) => Q.some((b) => meet(a, b)));
  let pools = [];
  for (let k = 0; k < size >> 2; k++) pools.push([range(1, 2 * k), range(1, 2 * k + 1)]);
  for (let r = 2; r <= R; r++) {
    const m = size >> r;
    const pref = (r - 1) % 2 === 1 ? m - 1 : (m > 1 ? m / 2 : 0);
    let best = null;
    for (const c of [pref, ...Array.from({ length: m }, (_, i) => i).filter((i) => i !== pref)]) {
      const next = pools.map((P, k) => [...P, range(r, k ^ c)]);
      let drop = 0;
      for (let k = 0; k < m; k++) if (clash(pools[k], [range(r, k ^ c)])) drop++;
      let inner = 0;
      if (r < R) for (let k = 0; k + 1 < m; k += 2) if (clash(next[k], next[k + 1])) inner++;
      const score = drop * 10000 + inner;
      if (!best || score < best.score) best = { c, score, next };
      if (score === 0) break;
    }
    cs.push(best.c);
    pools = best.next;
    if (r < R) {
      const merged = [];
      for (let k = 0; k + 1 < m; k += 2) merged.push([...pools[k], ...pools[k + 1]]);
      pools = merged;
    }
  }
  dropInCache.set(size, cs);
  return cs;
}

/**
 * Граф матчей. Детерминированно зависит только от размера сетки и формата.
 * Источник слота: {type:'seed', index} | {type:'winner', match} | {type:'loser', match}
 *                 | {type:'reset', match:'GF1', side} (только GF2).
 */
export function buildBracket(state) {
  const size = state.slots.length;
  if (size < 2 || (size & (size - 1)) !== 0) throw new Error('Размер сетки должен быть степенью двойки');
  const format = state.format === 'single' ? 'single' : 'double';
  const third = format === 'single' && !!state.thirdPlace;
  const reset = format === 'double' && !!state.grandFinalReset;
  const key = `${size}|${format}|${third}|${reset}`;
  let b = bracketCache.get(key);
  if (!b) {
    b = makeBracket(size, format, third, reset);
    bracketCache.set(key, b);
  }
  return b;
}

function makeBracket(size, format, third, reset) {
  const R = Math.round(Math.log2(size));
  const matches = [];
  const byId = Object.create(null);
  const columns = [];
  const add = (m) => {
    matches.push(m);
    byId[m.id] = m;
    return m.id;
  };

  // Верхняя (основная) сетка
  const upper = [];
  for (let r = 1; r <= R; r++) {
    const count = size >> r;
    const ids = [];
    for (let k = 1; k <= count; k++) {
      const sources = r === 1
        ? [{ type: 'seed', index: 2 * (k - 1) }, { type: 'seed', index: 2 * (k - 1) + 1 }]
        : [{ type: 'winner', match: `W${r - 1}-${2 * k - 1}` }, { type: 'winner', match: `W${r - 1}-${2 * k}` }];
      ids.push(add({ id: `W${r}-${k}`, section: 'upper', round: r, index: k - 1, key: `W${r}`, sources }));
    }
    upper.push(ids);
    columns.push({ section: 'upper', key: `W${r}`, round: r, label: upperLabel(count, format), matches: ids });
  }

  // Нижняя сетка
  const lower = [];
  if (format === 'double' && R >= 2) {
    const dropIn = dropInConstants(size);
    let lr = 1;
    let ids = [];
    for (let k = 1; k <= size >> 2; k++) {
      ids.push(add({
        id: `L1-${k}`, section: 'lower', round: 1, index: k - 1, key: 'L1', kind: 'first',
        sources: [{ type: 'loser', match: `W1-${2 * k - 1}` }, { type: 'loser', match: `W1-${2 * k}` }],
      }));
    }
    lower.push(ids);
    for (let r = 2; r <= R; r++) {
      // Раунд «вливания»: победители НС против проигравших ВС раунда r.
      // Порядок вливания перемешан (см. dropInConstants), чтобы избежать повторных встреч.
      const m = size >> r;
      const c = dropIn[r - 2];
      lr++;
      ids = [];
      for (let k = 0; k < m; k++) {
        const j = k ^ c;
        ids.push(add({
          id: `L${lr}-${k + 1}`, section: 'lower', round: lr, index: k, key: `L${lr}`, kind: 'dropin',
          sources: [{ type: 'winner', match: `L${lr - 1}-${k + 1}` }, { type: 'loser', match: `W${r}-${j + 1}` }],
        }));
      }
      lower.push(ids);
      if (r < R) {
        // Внутренний раунд НС
        lr++;
        ids = [];
        for (let k = 1; k <= m / 2; k++) {
          ids.push(add({
            id: `L${lr}-${k}`, section: 'lower', round: lr, index: k - 1, key: `L${lr}`, kind: 'internal',
            sources: [{ type: 'winner', match: `L${lr - 1}-${2 * k - 1}` }, { type: 'winner', match: `L${lr - 1}-${2 * k}` }],
          }));
        }
        lower.push(ids);
      }
    }
    lower.forEach((ids2, i) => {
      columns.push({
        section: 'lower', key: `L${i + 1}`, round: i + 1, matches: ids2,
        label: i === lower.length - 1 ? 'Финал нижней сетки' : `Нижняя сетка — раунд ${i + 1}`,
      });
    });
  }

  const final = [];
  let thirdId = null;
  if (format === 'double') {
    const ubFinal = `W${R}-1`;
    const lbFinal = lower.length ? lower[lower.length - 1][0] : null;
    final.push(add({
      id: 'GF1', section: 'final', round: 1, index: 0, key: 'GF',
      sources: [{ type: 'winner', match: ubFinal }, lbFinal ? { type: 'winner', match: lbFinal } : { type: 'loser', match: ubFinal }],
    }));
    columns.push({ section: 'final', key: 'GF', round: 1, label: 'Гранд-финал', matches: ['GF1'] });
    if (reset) {
      final.push(add({
        id: 'GF2', section: 'final', round: 2, index: 0, key: 'GF',
        sources: [{ type: 'reset', match: 'GF1', side: 0 }, { type: 'reset', match: 'GF1', side: 1 }],
      }));
      columns.push({ section: 'final', key: 'GF', round: 2, label: 'Гранд-финал — перезапуск', matches: ['GF2'] });
    }
  } else if (third && R >= 2) {
    thirdId = add({
      id: '3RD', section: 'third', round: 1, index: 0, key: '3RD',
      sources: [{ type: 'loser', match: `W${R - 1}-1` }, { type: 'loser', match: `W${R - 1}-2` }],
    });
    columns.push({ section: 'third', key: '3RD', round: 1, label: 'Матч за 3-е место', matches: ['3RD'] });
  }

  // Куда уходят победитель / проигравший каждого матча
  const winnerTo = Object.create(null);
  const loserTo = Object.create(null);
  for (const m of matches) {
    m.sources.forEach((src, side) => {
      if (src.type === 'winner') winnerTo[src.match] = { match: m.id, side };
      else if (src.type === 'loser') loserTo[src.match] = { match: m.id, side };
    });
  }

  const deciders = format === 'double' ? final.slice() : [`W${R}-1`];
  return { size, rounds: R, format, matches, byId, upper, lower, final, third: thirdId, columns, winnerTo, loserTo, deciders };
}

/* ------------------------------------------------------------------ */
/* Разрешение участников и статусов                                    */
/* ------------------------------------------------------------------ */

function validResult(res, a, b) {
  return !!res && (res.winner === 0 || res.winner === 1) && Array.isArray(res.p) && res.p[0] === a && res.p[1] === b;
}

function settle(id, p, res) {
  const out = { id, p, status: 'pending', winner: undefined, loser: undefined, winnerIdx: undefined, score: undefined };
  const [a, b] = p;
  if (a === undefined || b === undefined) return out;
  if (a === null && b === null) {
    out.status = 'bye';
    out.winner = null;
    out.loser = null;
  } else if (a === null || b === null) {
    out.status = 'bye';
    out.winnerIdx = a === null ? 1 : 0;
    out.winner = p[out.winnerIdx];
    out.loser = null;
  } else if (validResult(res, a, b)) {
    out.status = 'done';
    out.winnerIdx = res.winner;
    out.winner = p[res.winner];
    out.loser = p[1 - res.winner];
    if (res.score) out.score = [res.score[0], res.score[1]];
  } else {
    out.status = 'ready';
  }
  return out;
}

/**
 * Для каждого матча: p:[a,b] (id | null = BYE | undefined = ещё неизвестен),
 * status: 'pending' | 'ready' | 'done' | 'bye', winner, loser, winnerIdx, score.
 * Результаты, не совпадающие с текущими участниками матча, игнорируются.
 */
export function resolve(state) {
  const bracket = buildBracket(state);
  const results = state.results || {};
  const M = Object.create(null);
  for (const m of bracket.matches) {
    let p;
    if (m.sources[0].type === 'reset') {
      const g = M[m.sources[0].match];
      if (g.status === 'done' && g.winnerIdx === 1) p = [g.p[0], g.p[1]];
      else if (g.status === 'done' || g.status === 'bye') p = [null, null]; // перезапуск не нужен
      else p = [undefined, undefined];
    } else {
      p = m.sources.map((src) => {
        if (src.type === 'seed') return state.slots[src.index] ?? null;
        const r = M[src.match];
        return src.type === 'winner' ? r.winner : r.loser;
      });
    }
    M[m.id] = settle(m.id, p, Object.prototype.hasOwnProperty.call(results, m.id) ? results[m.id] : undefined);
  }

  let champion;
  if (bracket.format === 'double') {
    const g1 = M.GF1;
    champion = M.GF2 && g1.status === 'done' && g1.winnerIdx === 1 ? M.GF2.winner : g1.winner;
  } else {
    champion = M[`W${bracket.rounds}-1`].winner;
  }
  return { bracket, matches: M, champion: champion ?? null };
}

export function champion(state) {
  return resolve(state).champion;
}

/** Удаляет результаты, которые больше не соответствуют участникам матча (каскадно). */
export function pruneResults(state) {
  const res = resolve(state);
  const keep = {};
  let changed = false;
  for (const id of Object.keys(state.results || {})) {
    const r = res.matches[id];
    if (r && r.status === 'done') keep[id] = state.results[id];
    else changed = true;
  }
  return changed ? { ...state, results: keep } : state;
}

/** id результатов, которые есть в before, но пропали в after. */
export function removedResults(before, after) {
  return Object.keys(before.results || {}).filter((id) => !Object.prototype.hasOwnProperty.call(after.results || {}, id));
}

/* ------------------------------------------------------------------ */
/* Операции (все неизменяемые)                                         */
/* ------------------------------------------------------------------ */

export function setResult(state, matchId, winnerIdx, score) {
  const r = resolve(state).matches[matchId];
  if (!r) throw new Error(`Неизвестный матч: ${matchId}`);
  if (winnerIdx !== 0 && winnerIdx !== 1) throw new Error('Победитель должен быть 0 или 1');
  if (r.status !== 'ready' && r.status !== 'done') throw new Error('Матч ещё не готов: участники не определены');
  const entry = { winner: winnerIdx };
  let sc;
  if (score === undefined) sc = r.status === 'done' && r.winnerIdx === winnerIdx ? r.score : undefined;
  else sc = normScore(score);
  if (sc) entry.score = [sc[0], sc[1]];
  entry.p = [r.p[0], r.p[1]];
  return pruneResults({ ...state, results: { ...state.results, [matchId]: entry } });
}

export function clearResult(state, matchId) {
  if (!Object.prototype.hasOwnProperty.call(state.results, matchId)) return state;
  const results = { ...state.results };
  delete results[matchId];
  return pruneResults({ ...state, results });
}

export function clearAllResults(state) {
  return Object.keys(state.results).length ? { ...state, results: {} } : state;
}

export function swapSlots(state, i, j) {
  const n = state.slots.length;
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n) {
    throw new Error('Неверный номер слота');
  }
  if (i === j || state.slots[i] === state.slots[j]) return state;
  const slots = state.slots.slice();
  [slots[i], slots[j]] = [slots[j], slots[i]];
  return pruneResults({ ...state, slots });
}

export function resetSeeding(state) {
  return pruneResults({ ...state, slots: defaultSlots(state.participants, state.slots.length) });
}

/** Случайно распределяет участников по номерам посева (позиции BYE сохраняются). */
export function shuffleSeeding(state, rng = Math.random) {
  const perm = state.participants.slice();
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return pruneResults({ ...state, slots: defaultSlots(perm, state.slots.length) });
}

/** Обновляет настройки: title, format, thirdPlace, grandFinalReset, bestOf. */
export function updateSettings(state, patch = {}) {
  const next = { ...state };
  if ('title' in patch) next.title = normTitle(patch.title);
  if ('format' in patch) next.format = patch.format === 'single' ? 'single' : 'double';
  if ('thirdPlace' in patch) next.thirdPlace = !!patch.thirdPlace;
  if ('grandFinalReset' in patch) next.grandFinalReset = !!patch.grandFinalReset;
  if ('bestOf' in patch) next.bestOf = normBestOf(patch.bestOf);
  return pruneResults(next);
}

export function setBestOf(state, roundKey, value) {
  const bestOf = { ...state.bestOf };
  const v = primNumber(value);
  if (!Number.isFinite(v) || v === 0) delete bestOf[roundKey];
  else bestOf[roundKey] = v;
  return updateSettings(state, { bestOf });
}

/**
 * Заменяет список участников. Если размер сетки не меняется — посев сохраняется
 * (удалённые → BYE, новые — в свободные слоты по порядку посева); иначе — посев по списку.
 */
export function setParticipants(state, list) {
  const participants = normalizeParticipants(list);
  const size = bracketSizeFor(participants.length);
  const slots = size === state.slots.length
    ? normalizeSlots(state.slots, participants, size)
    : defaultSlots(participants, size);
  return pruneResults({ ...state, participants, slots });
}

export function renameParticipant(state, id, name) {
  return setParticipants(state, state.participants.map((p) => (p.id === id ? { id, name } : p)));
}

export function addParticipant(state, name) {
  return setParticipants(state, [...state.participants, { name: name || `Участник ${state.participants.length + 1}` }]);
}

export function removeParticipant(state, id) {
  return setParticipants(state, state.participants.filter((p) => p.id !== id));
}

/* ------------------------------------------------------------------ */
/* Итоги                                                               */
/* ------------------------------------------------------------------ */

/**
 * Статус каждого участника: Map id -> {status:'alive'|'out'|'champion', place:[from,to]|null, wins, losses, seed}.
 * Места считаются по этапу вылета. Сколько реальных участников вылетает на каждом этапе, определяется
 * только посевом (BYE распространяются детерминированно и не зависят от результатов), поэтому
 * место выбывшего известно сразу и больше не меняется по ходу турнира.
 */
export function standings(state, res = resolve(state)) {
  const { bracket } = res;
  const M = res.matches;
  const R = bracket.rounds;
  const last = new Map();
  const info = new Map();
  const order = seedOrder(state.slots.length);
  const seedOf = new Map();
  state.slots.forEach((id, idx) => { if (id) seedOf.set(id, order[idx]); });
  for (const p of state.participants) info.set(p.id, { status: 'alive', place: null, wins: 0, losses: 0, seed: seedOf.get(p.id) ?? null, stage: null });

  for (const m of bracket.matches) {
    const r = M[m.id];
    for (const pid of r.p) if (pid) last.set(pid, m.id);
    if (r.status === 'done') {
      info.get(r.winner).wins++;
      info.get(r.loser).losses++;
    }
  }

  const FINAL = 1000;
  const stageOf = (mid, won) => {
    const m = bracket.byId[mid];
    if (m.section === 'third') return won ? R - 0.25 : R - 0.5;
    if (m.section === 'final') return FINAL;
    if (m.section === 'lower') return m.round;
    return bracket.format === 'double' ? FINAL : m.round;
  };

  // Структурный подсчёт: сколько реальных участников (не BYE) заканчивает турнир на каждом этапе.
  const perStage = new Map();
  const bump = (st) => perStage.set(st, (perStage.get(st) || 0) + 1);
  const real = Object.create(null); // id матча -> {w, l}: будет ли победитель / проигравший реальным
  for (const m of bracket.matches) {
    if (m.section === 'final') continue;
    const sides = m.sources.map((src) => {
      if (src.type === 'seed') return state.slots[src.index] != null;
      return src.type === 'winner' ? real[src.match].w : real[src.match].l;
    });
    const w = sides[0] || sides[1];
    const l = sides[0] && sides[1];
    real[m.id] = { w, l };
    if (l && !bracket.loserTo[m.id]) bump(stageOf(m.id, false));
    if (w && m.section === 'third') bump(stageOf(m.id, true));
  }
  if (bracket.format === 'double' && bracket.byId.GF1) {
    const sides = bracket.byId.GF1.sources.map((src) => (src.type === 'winner' ? real[src.match].w : real[src.match].l));
    if (sides[0] && sides[1]) bump(FINAL); // 2-е место (проигравший GF1 или GF2)
  }
  const placeOf = (stage) => {
    let better = state.participants.length ? 1 : 0; // чемпион
    for (const [st, c] of perStage) if (st > stage) better += c;
    return [better + 1, better + (perStage.get(stage) || 1)];
  };

  for (const p of state.participants) {
    const it = info.get(p.id);
    if (p.id === res.champion) {
      it.status = 'champion';
      it.place = [1, 1];
      continue;
    }
    const mid = last.get(p.id);
    if (!mid) continue;
    const r = M[mid];
    if ((r.status === 'done' || r.status === 'bye') && r.loser === p.id && !bracket.loserTo[mid]) {
      it.status = 'out';
      it.stage = stageOf(mid, false);
    } else if ((r.status === 'done' || r.status === 'bye') && r.winner === p.id && bracket.byId[mid].section === 'third') {
      // Победитель матча за 3-е место закончил турнир (3 место)
      it.status = 'out';
      it.stage = stageOf(mid, true);
    }
    if (it.status === 'out') it.place = placeOf(it.stage);
  }
  return info;
}

/** Ключи раундов (для настройки BO) с подписями. */
export function roundKeys(state) {
  const b = buildBracket(state);
  const seen = new Set();
  const out = [];
  for (const c of b.columns) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    let label = c.label;
    if (c.section === 'upper' && b.format === 'double' && !/верхней/.test(label)) label = `ВС: ${label}`;
    if (c.key === 'GF') label = 'Гранд-финал';
    out.push({ key: c.key, label });
  }
  return out;
}
