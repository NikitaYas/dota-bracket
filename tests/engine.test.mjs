import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/engine.js';

/* ---------- helpers ---------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

function readyMatches(state) {
  const res = E.resolve(state);
  return res.bracket.matches.filter((m) => res.matches[m.id].status === 'ready').map((m) => m.id);
}

/** Играет случайные результаты до конца. Возвращает финальное состояние и число сыгранных матчей. */
function playOut(state, rng, { withScore = false } = {}) {
  let s = state;
  let played = 0;
  for (let guard = 0; guard < 1000; guard++) {
    const ready = readyMatches(s);
    if (!ready.length) return { state: s, played };
    const id = ready[Math.floor(rng() * ready.length)];
    const w = rng() < 0.5 ? 0 : 1;
    const score = withScore ? (w === 0 ? [2, Math.floor(rng() * 2)] : [Math.floor(rng() * 2), 2]) : undefined;
    s = E.setResult(s, id, w, score);
    played++;
  }
  throw new Error('playOut did not terminate');
}

function lossCounts(state) {
  const res = E.resolve(state);
  const losses = new Map();
  const upperLosses = new Map();
  for (const m of res.bracket.matches) {
    const r = res.matches[m.id];
    if (r.status !== 'done') continue;
    losses.set(r.loser, (losses.get(r.loser) || 0) + 1);
    if (m.section === 'upper') upperLosses.set(r.loser, (upperLosses.get(r.loser) || 0) + 1);
  }
  return { losses, upperLosses };
}

const COUNTS = [2, 3, 5, 8, 16, 24, 32, 33];
const CONFIGS = [
  { format: 'single', thirdPlace: true },
  { format: 'single', thirdPlace: false },
  { format: 'double', grandFinalReset: true },
  { format: 'double', grandFinalReset: false },
];

/* ---------- seeding ---------- */

describe('посев', () => {
  test('стандартный порядок 32', () => {
    const o = E.seedOrder(32);
    assert.deepEqual(o.slice(0, 8), [1, 32, 16, 17, 8, 25, 9, 24]);
    assert.equal(o.length, 32);
    assert.deepEqual([...o].sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i + 1));
    // каждая пара в сумме даёт 33
    for (let i = 0; i < 32; i += 2) assert.equal(o[i] + o[i + 1], 33);
  });

  test('24 участника: посевы 1–8 получают BYE в первом раунде', () => {
    const s = E.createState(24);
    assert.equal(s.slots.length, 32);
    assert.equal(s.slots.filter((x) => x === null).length, 8);
    const res = E.resolve(s);
    const w1 = res.bracket.upper[0].map((id) => res.matches[id]);
    assert.equal(w1.filter((r) => r.status === 'bye').length, 8);
    assert.equal(w1.filter((r) => r.status === 'ready').length, 8);
    const byeWinners = w1.filter((r) => r.status === 'bye').map((r) => r.winner).sort();
    assert.deepEqual(byeWinners, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].sort());
    // первый матч: 1 против BYE, второй 16 против 17
    assert.deepEqual(res.matches['W1-1'].p, ['p1', null]);
    assert.deepEqual(res.matches['W1-2'].p, ['p16', 'p17']);
  });

  test('размер сетки = следующая степень двойки', () => {
    assert.equal(E.createState(2).slots.length, 2);
    assert.equal(E.createState(3).slots.length, 4);
    assert.equal(E.createState(5).slots.length, 8);
    assert.equal(E.createState(24).slots.length, 32);
    assert.equal(E.createState(32).slots.length, 32);
    assert.equal(E.createState(33).slots.length, 64);
    assert.equal(E.createState(64).slots.length, 64);
  });

  test('shuffleSeeding сохраняет позиции BYE и всех участников', () => {
    const s = E.createState(24);
    const sh = E.shuffleSeeding(s, mulberry32(7));
    s.slots.forEach((v, i) => assert.equal(v === null, sh.slots[i] === null));
    assert.deepEqual([...sh.slots.filter(Boolean)].sort(), [...s.slots.filter(Boolean)].sort());
    assert.deepEqual(E.resetSeeding(sh).slots, s.slots);
  });
});

/* ---------- structure ---------- */

describe('структура сетки', () => {
  test('количество матчей', () => {
    const single = E.buildBracket(E.createState(24, { format: 'single', thirdPlace: true }));
    assert.equal(single.matches.length, 31 + 1);
    const double = E.buildBracket(E.createState(24, { format: 'double', grandFinalReset: true }));
    assert.equal(double.matches.filter((m) => m.section === 'upper').length, 31);
    assert.equal(double.matches.filter((m) => m.section === 'lower').length, 30);
    assert.deepEqual(double.final, ['GF1', 'GF2']);
    assert.equal(double.lower.length, 8);
    assert.deepEqual(double.lower.map((c) => c.length), [8, 8, 4, 4, 2, 2, 1, 1]);
  });

  for (const n of [2, 4, 8, 16, 32, 64]) {
    test(`граф корректен (размер ${n})`, () => {
      for (const cfg of CONFIGS) {
        const b = E.buildBracket(E.createState(n, cfg));
        const seen = new Set();
        const winnerUse = new Map();
        const loserUse = new Map();
        for (const m of b.matches) {
          for (const src of m.sources) {
            if (src.type === 'seed') continue;
            assert.ok(seen.has(src.match), `${m.id} ссылается на ещё не построенный ${src.match}`);
            if (src.type === 'winner') winnerUse.set(src.match, (winnerUse.get(src.match) || 0) + 1);
            if (src.type === 'loser') loserUse.set(src.match, (loserUse.get(src.match) || 0) + 1);
          }
          seen.add(m.id);
        }
        for (const v of winnerUse.values()) assert.equal(v, 1);
        for (const v of loserUse.values()) assert.equal(v, 1);
        if (cfg.format === 'double') {
          // каждый проигравший верхней сетки попадает в нижнюю (или в ГФ при 2 участниках)
          for (const m of b.matches.filter((x) => x.section === 'upper')) assert.equal(loserUse.get(m.id), 1, m.id);
          // каждый матч НС кроме финала отдаёт победителя дальше
          for (const m of b.matches.filter((x) => x.section === 'lower')) assert.equal(winnerUse.get(m.id), 1, m.id);
        }
        // все seed-индексы использованы ровно один раз
        const seeds = b.matches.flatMap((m) => m.sources.filter((s) => s.type === 'seed').map((s) => s.index)).sort((x, y) => x - y);
        assert.deepEqual(seeds, Array.from({ length: n }, (_, i) => i));
      }
    });
  }

  test('стабильные id матчей', () => {
    const b = E.buildBracket(E.createState(24));
    for (const id of ['W1-1', 'W1-16', 'W5-1', 'L1-1', 'L8-1', 'GF1', 'GF2']) assert.ok(b.byId[id], id);
    const s = E.buildBracket(E.createState(24, { format: 'single' }));
    assert.ok(s.byId['3RD']);
    assert.ok(!s.byId.GF1);
  });

  test('раунд вливания НС избегает повторных встреч из 1-го раунда (полная сетка)', () => {
    for (const n of [8, 16, 32, 64]) {
      for (let seed = 1; seed <= 10; seed++) {
        const rng = mulberry32(seed * 31 + n);
        let s = E.createState(n);
        // играем верхнюю сетку 1-2 раунда и НС 1 раунд
        for (const id of E.buildBracket(s).upper[0]) s = E.setResult(s, id, rng() < 0.5 ? 0 : 1);
        for (const id of E.buildBracket(s).upper[1]) s = E.setResult(s, id, rng() < 0.5 ? 0 : 1);
        for (const id of E.buildBracket(s).lower[0]) s = E.setResult(s, id, rng() < 0.5 ? 0 : 1);
        const res = E.resolve(s);
        const w1pairs = new Set(res.bracket.upper[0].map((id) => [...res.matches[id].p].sort().join('|')));
        for (const id of res.bracket.lower[1]) {
          const pair = [...res.matches[id].p].sort().join('|');
          assert.ok(!w1pairs.has(pair), `повтор ${pair} в ${id}`);
        }
      }
    }
  });
});

/* ---------- full simulations ---------- */

describe('симуляция до конца', () => {
  for (const n of COUNTS) {
    for (const cfg of CONFIGS) {
      test(`${n} участников, ${JSON.stringify(cfg)}`, () => {
        for (let seed = 1; seed <= 12; seed++) {
          const rng = mulberry32(seed * 1000 + n);
          let s = E.createState(n, cfg);
          if (seed % 3 === 0) s = E.shuffleSeeding(s, rng);
          if (seed % 4 === 0) {
            // случайные перестановки слотов (включая BYE ↔ участник, возможны BYE vs BYE)
            for (let k = 0; k < 10; k++) s = E.swapSlots(s, Math.floor(rng() * s.slots.length), Math.floor(rng() * s.slots.length));
          }
          const { state: done } = playOut(s, rng, { withScore: seed % 2 === 0 });
          const res = E.resolve(done);

          // никаких pending/ready не осталось
          for (const m of res.bracket.matches) {
            const st = res.matches[m.id].status;
            assert.ok(st === 'done' || st === 'bye', `${m.id} остался ${st}`);
          }
          // ровно один чемпион, реальный участник
          const ids = new Set(done.participants.map((p) => p.id));
          assert.ok(res.champion, 'нет чемпиона');
          assert.ok(ids.has(res.champion), 'чемпион — не участник (BYE?)');

          // поражения
          const { losses, upperLosses } = lossCounts(done);
          if (cfg.format === 'single') {
            for (const [pid, c] of upperLosses) assert.ok(c <= 1, `${pid} выбыл ${c} раз`);
            assert.ok(!upperLosses.has(res.champion));
          } else {
            for (const [pid, c] of losses) assert.ok(c <= 2, `${pid} проиграл ${c} раз`);
            assert.ok((losses.get(res.champion) || 0) <= 1);
          }

          // никто не появляется дважды в одном раунде
          for (const col of res.bracket.columns) {
            const seen = new Set();
            for (const id of col.matches) {
              for (const pid of res.matches[id].p) {
                if (!pid) continue;
                assert.ok(!seen.has(pid), `${pid} дважды в раунде ${col.key}`);
                seen.add(pid);
              }
            }
          }
          // каждый матч не содержит одного игрока дважды
          for (const m of res.bracket.matches) {
            const [a, b] = res.matches[m.id].p;
            if (a && b) assert.notEqual(a, b);
          }

          // итоги: один чемпион, остальные выбыли, места корректны
          const st = E.standings(done, res);
          const vals = [...st.values()];
          assert.equal(vals.filter((v) => v.status === 'champion').length, 1);
          assert.equal(vals.filter((v) => v.status === 'alive').length, 0);
          for (const v of vals) {
            assert.ok(v.place && v.place[0] >= 1 && v.place[1] <= n && v.place[0] <= v.place[1]);
          }
          if (n >= 2) assert.equal(vals.filter((v) => v.place[0] === 2).length, 1, '2-е место должно быть одно');
          if (cfg.format === 'single' && cfg.thirdPlace && n >= 4) {
            assert.equal(vals.filter((v) => v.place[0] === 3 && v.place[1] === 3).length, 1);
          }
          // результаты не теряются при повторной нормализации
          const re = E.normalizeState(JSON.parse(E.serialize(done)));
          assert.deepEqual(re, done);
        }
      });
    }
  }

  test('в процессе игры никто не находится в двух открытых матчах', () => {
    const rng = mulberry32(99);
    let s = E.createState(24);
    for (let step = 0; step < 200; step++) {
      const res = E.resolve(s);
      const active = new Map();
      for (const m of res.bracket.matches) {
        const r = res.matches[m.id];
        if (r.status !== 'ready' && r.status !== 'pending') continue;
        for (const pid of r.p) {
          if (!pid) continue;
          assert.ok(!active.has(pid), `${pid} в ${active.get(pid)} и ${m.id}`);
          active.set(pid, m.id);
        }
      }
      const ready = readyMatches(s);
      if (!ready.length) break;
      s = E.setResult(s, ready[Math.floor(rng() * ready.length)], rng() < 0.5 ? 0 : 1);
    }
  });
});

/* ---------- BYE ---------- */

describe('BYE', () => {
  test('BYE vs BYE даёт BYE, проигравший авто-прохода — BYE', () => {
    let s = E.createState(5); // размер 8
    // слоты: [1,8,4,5,2,7,3,6] -> p1,null,p4,p5,p2,null,p3,null
    assert.deepEqual(s.slots, ['p1', null, 'p4', 'p5', 'p2', null, 'p3', null]);
    // сделаем BYE vs BYE: переставим p3 на место BYE в матче 1 -> W1-1: p1 vs p3, W1-4: null vs null
    s = E.swapSlots(s, 1, 6);
    const res = E.resolve(s);
    assert.equal(res.matches['W1-4'].status, 'bye');
    assert.equal(res.matches['W1-4'].winner, null);
    assert.equal(res.matches['W1-3'].status, 'bye');
    assert.equal(res.matches['W1-3'].loser, null);
    // W2-2: p2 (авто) vs BYE -> авто-проход
    assert.deepEqual(res.matches['W2-2'].p, ['p2', null]);
    assert.equal(res.matches['W2-2'].status, 'bye');
    assert.equal(res.matches['W2-2'].winner, 'p2');
    // L1-2: проигравшие W1-3 и W1-4 -> BYE vs BYE
    assert.equal(res.matches['L1-2'].status, 'bye');
    assert.equal(res.matches['L1-2'].winner, null);
  });

  test('нельзя ставить результат в BYE- и pending-матч', () => {
    const s = E.createState(24);
    assert.throws(() => E.setResult(s, 'W1-1', 0)); // p1 vs BYE
    assert.throws(() => E.setResult(s, 'W2-1', 0)); // ещё не определены
    assert.throws(() => E.setResult(s, 'GF1', 0));
    assert.throws(() => E.setResult(s, 'NOPE', 0));
    assert.throws(() => E.setResult(s, 'W1-2', 2));
  });

  test('матч за 3-е место пропускается, если проигравший полуфинала — BYE', () => {
    let s = E.createState(3, { format: 'single', thirdPlace: true });
    // размер 4: W1-1 p1 vs BYE, W1-2 p2 vs p3
    s = E.setResult(s, 'W1-2', 0);
    const res = E.resolve(s);
    assert.equal(res.matches['3RD'].status, 'bye');
    assert.equal(res.matches['3RD'].winner, 'p3');
    s = E.setResult(s, 'W2-1', 1);
    assert.equal(E.champion(s), 'p2');
    const st = E.standings(s);
    assert.deepEqual(st.get('p2').place, [1, 1]);
    assert.deepEqual(st.get('p1').place, [2, 2]);
    assert.deepEqual(st.get('p3').place, [3, 3]);
  });
});

/* ---------- invalidation ---------- */

describe('инвалидация', () => {
  test('изменение раннего результата каскадно сбрасывает зависимые', () => {
    const rng = mulberry32(5);
    const { state: done } = playOut(E.createState(24), rng);
    const res = E.resolve(done);
    const r = res.matches['W1-2'];
    const oldWinner = r.winner;
    const changed = E.setResult(done, 'W1-2', 1 - r.winnerIdx);
    const removed = E.removedResults(done, changed);
    assert.ok(removed.length > 0);
    assert.ok(!removed.includes('W1-2'));
    // каждый удалённый матч содержал либо старого победителя, либо старого проигравшего, либо был ниже по дереву
    const res2 = E.resolve(changed);
    for (const id of removed) assert.notEqual(res2.matches[id].status, 'done');
    // все оставшиеся результаты валидны
    for (const id of Object.keys(changed.results)) assert.equal(res2.matches[id].status, 'done');
    // путь старого победителя дальше W1-2 очищен
    const stillHasOld = Object.keys(changed.results).some((id) => id !== 'W1-2' && res2.matches[id].p.includes(oldWinner) && res.bracket.byId[id].section === 'upper');
    assert.ok(!stillHasOld);
    // независимые матчи сохранились
    assert.ok(changed.results['W1-4']);
    // идемпотентность
    assert.equal(E.pruneResults(changed), changed);
  });

  test('сброс результата очищает дальнейшие', () => {
    let s = E.createState(8, { format: 'single' });
    s = E.setResult(s, 'W1-1', 0);
    s = E.setResult(s, 'W1-2', 0);
    s = E.setResult(s, 'W2-1', 1);
    const c = E.clearResult(s, 'W1-2');
    assert.deepEqual(Object.keys(c.results).sort(), ['W1-1']);
    assert.deepEqual(E.removedResults(s, c).sort(), ['W1-2', 'W2-1']);
  });

  test('при возврате результата старые зависимые не воскресают', () => {
    let s = E.createState(8, { format: 'single' });
    s = E.setResult(s, 'W1-1', 0);
    s = E.setResult(s, 'W1-2', 0);
    s = E.setResult(s, 'W2-1', 1);
    s = E.setResult(s, 'W1-1', 1);
    s = E.setResult(s, 'W1-1', 0);
    assert.equal(s.results['W2-1'], undefined);
  });

  test('перестановка слотов сбрасывает результаты этих участников', () => {
    let s = E.createState(24);
    s = E.setResult(s, 'W1-2', 0);
    s = E.setResult(s, 'W1-4', 0);
    const sw = E.swapSlots(s, 2, 3); // меняем p16 и p17 местами внутри W1-2
    assert.equal(sw.results['W1-2'], undefined);
    assert.ok(sw.results['W1-4']);
  });

  test('ручной результат с подменёнными участниками игнорируется при нормализации', () => {
    const s = E.createState(8);
    const bad = { ...s, results: { 'W1-1': { winner: 0, p: ['p2', 'p7'] } } };
    assert.deepEqual(E.normalizeState(bad).results, {});
  });

  test('неизменяемость', () => {
    const s = deepFreeze(E.createState(24));
    const a = E.setResult(s, 'W1-2', 0, [2, 1]);
    deepFreeze(a);
    E.setResult(a, 'W1-2', 1);
    E.clearResult(a, 'W1-2');
    E.swapSlots(a, 0, 5);
    E.shuffleSeeding(a);
    E.updateSettings(a, { format: 'single' });
    E.setParticipants(a, [...a.participants, { name: 'Новый' }]);
    assert.equal(a.results['W1-2'].winner, 0);
    assert.deepEqual(a.results['W1-2'].score, [2, 1]);
  });
});

/* ---------- grand final ---------- */

function toGrandFinal(n, cfg, upperWins) {
  // Доводим до гранд-финала: в ВС всегда побеждает слот 0, в НС — случайно.
  const rng = mulberry32(42);
  let s = E.createState(n, cfg);
  for (let guard = 0; guard < 500; guard++) {
    const ready = readyMatches(s).filter((id) => !id.startsWith('GF'));
    if (!ready.length) break;
    const id = ready[0];
    s = E.setResult(s, id, id.startsWith('W') ? 0 : rng() < 0.5 ? 0 : 1);
  }
  assert.equal(E.resolve(s).matches.GF1.status, 'ready');
  return E.setResult(s, 'GF1', upperWins ? 0 : 1);
}

describe('гранд-финал', () => {
  test('победа финалиста ВС в GF1 — чемпион, GF2 не нужен', () => {
    const s = toGrandFinal(24, { grandFinalReset: true }, true);
    const res = E.resolve(s);
    assert.equal(res.matches.GF2.status, 'bye');
    assert.equal(res.champion, res.matches.GF1.p[0]);
    assert.equal(res.champion, 'p1');
  });

  test('победа финалиста НС в GF1 — перезапуск GF2', () => {
    let s = toGrandFinal(24, { grandFinalReset: true }, false);
    let res = E.resolve(s);
    assert.equal(res.matches.GF2.status, 'ready');
    assert.deepEqual(res.matches.GF2.p, res.matches.GF1.p);
    assert.equal(res.champion, null);
    const st = E.standings(s, res);
    assert.equal(st.get(res.matches.GF1.p[0]).status, 'alive');
    s = E.setResult(s, 'GF2', 0);
    res = E.resolve(s);
    assert.equal(res.champion, res.matches.GF1.p[0]);
    // изменение GF1 в пользу ВС удаляет GF2
    const s2 = E.setResult(s, 'GF1', 0);
    assert.equal(s2.results.GF2, undefined);
    assert.equal(E.champion(s2), res.matches.GF1.p[0]);
  });

  test('без перезапуска финалист НС становится чемпионом сразу', () => {
    const s = toGrandFinal(24, { grandFinalReset: false }, false);
    const res = E.resolve(s);
    assert.equal(res.matches.GF2, undefined);
    assert.equal(res.champion, res.matches.GF1.p[1]);
  });

  test('2 участника, двойное выбывание: проигравший получает второй шанс', () => {
    let s = E.createState(2, { format: 'double', grandFinalReset: true });
    s = E.setResult(s, 'W1-1', 0);
    const res = E.resolve(s);
    assert.deepEqual(res.matches.GF1.p, ['p1', 'p2']);
    s = E.setResult(s, 'GF1', 1);
    s = E.setResult(s, 'GF2', 1);
    assert.equal(E.champion(s), 'p2');
  });

  test('одиночное: финал сыгран раньше матча за 3-е место — места верные', () => {
    let s = E.createState(8, { format: 'single', thirdPlace: true });
    for (const id of ['W1-1', 'W1-2', 'W1-3', 'W1-4', 'W2-1', 'W2-2', 'W3-1']) s = E.setResult(s, id, 0);
    const res = E.resolve(s);
    const st = E.standings(s, res);
    assert.deepEqual(st.get(res.matches['W3-1'].loser).place, [2, 2]);
    assert.equal(st.get(res.matches['W2-1'].loser).status, 'alive');
    for (const id of ['W1-1', 'W1-2', 'W1-3', 'W1-4']) assert.deepEqual(st.get(res.matches[id].loser).place, [5, 8]);
  });

  test('места в двойном выбывании', () => {
    const rng = mulberry32(3);
    const { state: done } = playOut(E.createState(24), rng);
    const st = E.standings(done);
    const places = [...st.values()].map((v) => v.place.join('-')).sort();
    const count = (k) => places.filter((p) => p === k).length;
    assert.equal(count('1-1'), 1);
    assert.equal(count('2-2'), 1);
    assert.equal(count('3-3'), 1);
    assert.equal(count('4-4'), 1);
    assert.equal(count('5-6'), 2);
    assert.equal(count('7-8'), 2);
    assert.equal(count('9-12'), 4);
    assert.equal(count('13-16'), 4);
    assert.equal(count('17-24'), 8);
  });
});

/* ---------- normalization & participants ---------- */

describe('нормализация и участники', () => {
  test('мусор на входе не роняет', () => {
    for (const raw of [null, undefined, 5, 'x', [], { participants: 'x' }, { participants: [null, 5, { id: {}, name: [] }] },
      { slots: 'bad', results: [] }, { results: { 'W1-1': null, __proto__: { winner: 0 } } }, { format: 'triple', bestOf: { W1: 7, GF: 3, zz: 1 } }]) {
      const s = E.normalizeState(raw);
      assert.equal(s.version, 1);
      assert.ok(Array.isArray(s.participants));
      assert.ok(s.slots.length >= 2);
      E.resolve(s);
    }
    const s = E.normalizeState({ format: 'triple', bestOf: { W1: 7, GF: 3, zz: 1 } });
    assert.equal(s.format, 'double');
    assert.deepEqual(s.bestOf, { GF: 3 });
  });

  test('дубликаты id и пустые имена исправляются', () => {
    const s = E.normalizeState({ participants: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }, { name: '  ' }, 'Строка'] });
    const ids = s.participants.map((p) => p.id);
    assert.equal(new Set(ids).size, 4);
    assert.equal(s.participants[2].name, 'Участник 3');
    assert.equal(s.participants[3].name, 'Строка');
  });

  test('неполные/повторяющиеся слоты чинятся', () => {
    const base = E.createState(6);
    const s = E.normalizeState({ ...base, slots: ['p1', 'p1', 'p2', 'zzz', null, null, null, null] });
    const filled = s.slots.filter(Boolean);
    assert.equal(filled.length, 6);
    assert.equal(new Set(filled).size, 6);
  });

  test('результаты без p «усыновляются», если матч готов', () => {
    const base = E.createState(8, { format: 'single' });
    const s = E.normalizeState({ ...base, results: { 'W1-1': { winner: 1, score: [0, 2] }, 'W2-1': { winner: 0 } } });
    assert.deepEqual(s.results['W1-1'], { winner: 1, score: [0, 2], p: ['p1', 'p8'] });
    assert.equal(s.results['W2-1'], undefined); // W2-1 ещё не готов (W1-2 не сыгран)
  });

  test('добавление/удаление участников', () => {
    let s = E.createState(24);
    s = E.setResult(s, 'W1-2', 0);
    const added = E.addParticipant(s, 'Новичок');
    assert.equal(added.participants.length, 25);
    assert.equal(added.slots.length, 32);
    const newId = added.participants[24].id;
    assert.equal(newId, 'p25');
    // новый участник занимает слот посева 25 (против посева 8)
    assert.equal(added.slots[E.seedOrder(32).indexOf(25)], newId);
    assert.ok(added.results['W1-2'], 'результат независимого матча сохранён');

    const removed = E.removeParticipant(s, 'p16');
    assert.equal(removed.participants.length, 23);
    assert.ok(!removed.slots.includes('p16'));
    assert.equal(removed.results['W1-2'], undefined);

    // смена размера сетки
    const big = E.setParticipants(s, [...s.participants, ...Array.from({ length: 9 }, (_, i) => ({ name: `X${i}` }))]);
    assert.equal(big.slots.length, 64);
    const small = E.setParticipants(s, s.participants.slice(0, 2));
    assert.equal(small.slots.length, 2);
    assert.deepEqual(small.slots, ['p1', 'p2']);
  });

  test('переименование не трогает сетку', () => {
    const s = E.setResult(E.createState(24), 'W1-2', 0);
    const r = E.renameParticipant(s, 'p16', 'Team Spirit');
    assert.equal(r.participants[15].name, 'Team Spirit');
    assert.deepEqual(r.slots, s.slots);
    assert.deepEqual(r.results, s.results);
  });

  test('смена формата сохраняет результаты верхней сетки', () => {
    let s = E.createState(16);
    s = E.setResult(s, 'W1-1', 0);
    s = E.setResult(s, 'W1-2', 0);
    s = E.setResult(s, 'L1-1', 0);
    const single = E.updateSettings(s, { format: 'single' });
    assert.ok(single.results['W1-1'] && single.results['W1-2']);
    assert.equal(single.results['L1-1'], undefined);
    const back = E.updateSettings(single, { format: 'double' });
    assert.equal(E.resolve(back).matches['L1-1'].status, 'ready');
  });

  test('BO по раундам', () => {
    let s = E.createState(24);
    s = E.setBestOf(s, 'GF', 5);
    s = E.setBestOf(s, 'W1', 1);
    assert.deepEqual(s.bestOf, { GF: 5, W1: 1 });
    s = E.setBestOf(s, 'W1', null);
    assert.deepEqual(s.bestOf, { GF: 5 });
    const keys = E.roundKeys(s).map((k) => k.key);
    assert.deepEqual(keys, ['W1', 'W2', 'W3', 'W4', 'W5', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'GF']);
  });
});

/* ---------- регрессии (ревью, раунд 1) ---------- */

describe('регрессии', () => {
  test('normalizeState не падает на объектах в winner / bestOf / score', () => {
    const base = JSON.parse(E.serialize(E.setResult(E.createState(24), 'W1-2', 0)));
    const evil = { toString: 1 };
    const s1 = E.normalizeState({ ...base, results: { ...base.results, 'W1-4': { winner: evil, p: ['p9', 'p24'] } } });
    assert.ok(s1.results['W1-2'], 'корректный результат сохранён');
    assert.equal(s1.results['W1-4'], undefined, 'плохой результат отброшен');
    assert.equal(s1.participants.length, 24);
    const s2 = E.normalizeState({ ...base, bestOf: { W1: evil, W2: { valueOf: 1 }, GF: '3' } });
    assert.deepEqual(s2.bestOf, { GF: 3 });
    assert.equal(s2.participants.length, 24);
    const s3 = E.normalizeState({ ...base, results: { 'W1-2': { ...base.results['W1-2'], score: [evil, 1] } } });
    assert.ok(s3.results['W1-2']);
    assert.equal(s3.results['W1-2'].score, undefined);
    // строковые 0/1 по-прежнему понимаются
    const s4 = E.normalizeState({ ...base, results: { 'W1-2': { ...base.results['W1-2'], winner: '1' } } });
    assert.equal(s4.results['W1-2'].winner, 1);
  });

  test('normalizeState: фаззинг произвольным JSON', () => {
    const rng = mulberry32(2024);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const rand = (depth = 0) => {
      const t = Math.floor(rng() * (depth > 2 ? 5 : 8));
      if (t === 0) return null;
      if (t === 1) return rng() < 0.5;
      if (t === 2) return pick([0, 1, -1, 2, 1.5, 1e9]);
      if (t === 3) return pick(['', '0', '1', 'x', 'p1', 'W1-1']);
      if (t === 4) return pick([[], [0, 1], ['p1', 'p2']]);
      if (t === 5) return Array.from({ length: Math.floor(rng() * 4) }, () => rand(depth + 1));
      const o = {};
      for (let i = 0; i < 3; i++) o[pick(['winner', 'score', 'p', 'toString', 'valueOf', 'id', 'name', 'W1', 'GF'])] = rand(depth + 1);
      return o;
    };
    const base = JSON.parse(E.serialize(E.createState(24)));
    for (let i = 0; i < 3000; i++) {
      const raw = { ...base };
      for (const k of ['results', 'bestOf', 'slots', 'participants', 'title', 'format', 'thirdPlace', 'updatedAt']) {
        if (rng() < 0.3) raw[k] = rand();
      }
      if (rng() < 0.5) raw.results = { 'W1-2': rand(), 'W1-4': { winner: rand(), score: rand(), p: rand() } };
      if (rng() < 0.5) raw.bestOf = { W1: rand(), GF: rand(), L2: rand() };
      const s = E.normalizeState(JSON.parse(JSON.stringify(raw)));
      E.resolve(s);
      E.standings(s);
    }
  });

  test('место выбывшего не меняется по ходу турнира', () => {
    for (const cfg of CONFIGS) {
      for (const n of [5, 8, 13, 24, 32, 33]) {
        for (let seed = 1; seed <= 6; seed++) {
          const rng = mulberry32(seed * 77 + n);
          let s = E.createState(n, cfg);
          if (seed % 2 === 0) s = E.shuffleSeeding(s, rng);
          const first = new Map();
          for (let guard = 0; guard < 1000; guard++) {
            const st = E.standings(s);
            for (const [pid, v] of st) {
              if (v.status !== 'out') continue;
              if (!first.has(pid)) first.set(pid, v.place.join('-'));
              else assert.equal(v.place.join('-'), first.get(pid), `${pid}: место изменилось (${JSON.stringify(cfg)}, n=${n})`);
            }
            const ready = readyMatches(s);
            if (!ready.length) break;
            s = E.setResult(s, ready[Math.floor(rng() * ready.length)], rng() < 0.5 ? 0 : 1);
          }
          // итоговые места покрывают ровно 1..n
          const cover = new Map();
          for (const v of E.standings(s).values()) cover.set(v.place.join('-'), (cover.get(v.place.join('-')) || 0) + 1);
          let next = 1;
          for (const key of [...cover.keys()].sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]))) {
            const [from, to] = key.split('-').map(Number);
            assert.equal(from, next, `диапазон ${key}`);
            assert.equal(to - from + 1, cover.get(key), `в диапазоне ${key} ${cover.get(key)} участников`);
            next = to + 1;
          }
          assert.equal(next, n + 1);
        }
      }
    }
  });

  test('24, одиночное: проигравший 1/8 финала — 9–16, первый выбывший — 17–24', () => {
    let s = E.createState(24, { format: 'single', thirdPlace: true });
    s = E.setResult(s, 'W1-2', 0);
    assert.deepEqual(E.standings(s).get('p17').place, [17, 24]);
    for (const id of E.buildBracket(s).upper[0]) if (E.resolve(s).matches[id].status === 'ready') s = E.setResult(s, id, 0);
    s = E.setResult(s, 'W2-1', 0);
    assert.deepEqual(E.standings(s).get('p16').place, [9, 16]);
  });

  /** Для каждого раунда вливания: число матчей с возможной повторной встречей и минимально возможное. */
  function dropInAudit(n) {
    const b = E.buildBracket(E.createState(n));
    const span = Object.create(null); // матч ВС -> [lo, hi) по индексам матчей 1-го раунда
    for (const m of b.matches) {
      if (m.section !== 'upper') continue;
      span[m.id] = m.round === 1 ? [m.index, m.index + 1] : [span[m.sources[0].match][0], span[m.sources[1].match][1]];
    }
    const meet = (a, c) => (a[0] <= c[0] && c[1] <= a[1]) || (c[0] <= a[0] && a[1] <= c[1]);
    const clash = (P, Q) => P.some((x) => Q.some((y) => meet(span[x], span[y])));
    const pool = Object.create(null); // матч НС -> матчи ВС, где могли проиграть его игроки
    const rounds = [];
    for (const col of b.lower) {
      const kind = b.byId[col[0]].kind;
      const prevPools = [];
      const ups = [];
      for (const id of col) {
        const m = b.byId[id];
        const sides = m.sources.map((src) => (src.type === 'loser' ? [src.match] : pool[src.match]));
        pool[id] = [...sides[0], ...sides[1]];
        if (kind === 'dropin') {
          prevPools.push(sides[0]);
          ups.push(m.sources[1].match);
        }
      }
      if (kind !== 'dropin') continue;
      const m = col.length;
      let actual = 0;
      for (let k = 0; k < m; k++) if (clash(prevPools[k], [ups[k]])) actual++;
      // максимальное паросочетание без конфликтов (алгоритм Куна)
      const owner = new Array(m).fill(-1);
      const tryK = (k, seen) => {
        for (let j = 0; j < m; j++) {
          if (seen[j] || clash(prevPools[k], [ups[j]])) continue;
          seen[j] = true;
          if (owner[j] < 0 || tryK(owner[j], seen)) {
            owner[j] = k;
            return true;
          }
        }
        return false;
      };
      let matched = 0;
      for (let k = 0; k < m; k++) if (tryK(k, [])) matched++;
      rounds.push({ key: b.byId[col[0]].key, actual, min: m - matched });
    }
    return rounds;
  }

  test('раунды вливания НС: повторные встречи только там, где их не избежать (8–128)', () => {
    for (const n of [8, 16, 32, 64, 128]) {
      for (const r of dropInAudit(n)) assert.equal(r.actual, r.min, `размер ${n}, ${r.key}: ${r.actual} возможных повторов при минимуме ${r.min}`);
    }
    // сетка на 32 (24 участника) — классическая схема не изменилась
    const b = E.buildBracket(E.createState(24));
    const order = (key) => b.lower.find((c) => b.byId[c[0]].key === key).map((id) => b.byId[id].sources[1].match);
    assert.deepEqual(order('L2'), ['W2-8', 'W2-7', 'W2-6', 'W2-5', 'W2-4', 'W2-3', 'W2-2', 'W2-1']);
    assert.deepEqual(order('L4'), ['W3-3', 'W3-4', 'W3-1', 'W3-2']);
    assert.deepEqual(order('L6'), ['W4-2', 'W4-1']);
  });

  test('64 участника: в L6 нет повторных встреч из верхней сетки', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      let s = E.createState(64);
      const met = new Set();
      for (let guard = 0; guard < 400; guard++) {
        const res = E.resolve(s);
        const ready = readyMatches(s).filter((id) => id.startsWith('W') || Number(id.slice(1).split('-')[0]) < 6);
        if (!ready.length) break;
        const id = ready[Math.floor(rng() * ready.length)];
        if (id.startsWith('W')) met.add([...res.matches[id].p].sort().join('|'));
        s = E.setResult(s, id, rng() < 0.5 ? 0 : 1);
      }
      const res = E.resolve(s);
      for (const id of res.bracket.lower[5]) {
        const r = res.matches[id];
        if (r.p[0] && r.p[1]) assert.ok(!met.has([...r.p].sort().join('|')), `повтор в ${id} (seed ${seed})`);
      }
    }
  });
});

test('normalizeState: результат без p, записанный вручную, не удаляет зависящие от него результаты', () => {
  let s = E.createState(24);
  s = E.setResult(s, 'W1-2', 0);
  s = E.setResult(s, 'W2-1', 1);
  const j = JSON.parse(E.serialize(s));
  delete j.results['W1-2'].p;
  const n = E.normalizeState(j);
  assert.deepEqual(Object.keys(n.results).sort(), ['W1-2', 'W2-1']);
});
