import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPolzaBudgetGuard } from '../../app/src/pilot/polza-budget.mjs';

const baseline = 3361.06059107;
const response = cost => ({ choices: [{ message: { content: 'test' } }], usage: { cost_rub: cost } });
function fixture({ reads = [baseline], save = async () => {}, signal = new AbortController().signal, state, priorReservedRub = 0 } = {}) {
  const saved = []; let i = 0;
  const guard = createPolzaBudgetGuard({ baselineRub: baseline, limitRub: 500, priorReservedRub, signal, state,
    getUsage: async () => reads[Math.min(i++, reads.length - 1)],
    persistState: async item => { await save(item); saved.push(structuredClone(item)); },
  });
  return { guard, saved };
}

test('до сетевого вызова записывается резерв; обе стоимости учитываются с запасом', async () => {
  const f = fixture({ reads: [baseline + 2, baseline + 2.3] });
  const result = await f.guard.run(10, async () => {
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].outstanding.reserve_rub, 10);
    return response(0.3);
  });
  assert.equal(result.settled, true);
  assert.equal(f.saved.at(-1).outstanding, null);
  assert.equal(result.budget.blocked, false);
  assert.ok(Math.abs(result.budget.conservative_spent_rub - 2.6) < 1e-7);
});

test('при запаздывании счётчика подтверждённые расходы не теряются', async () => {
  const f = fixture({ reads: [baseline, baseline, baseline, baseline] });
  await f.guard.run(200, async () => response(190));
  let called = false;
  await assert.rejects(() => f.guard.run(311, async () => { called = true; return response(1); }), /Недостаточно бюджета/);
  assert.equal(called, false);
  assert.equal(f.guard.snapshot().confirmed_rub, 190);
});

test('расход общего ключа до опыта учитывается целиком', async () => {
  const f = fixture({ reads: [baseline + 490] });
  let called = false;
  await assert.rejects(() => f.guard.run(11, async () => { called = true; return response(1); }), /Недостаточно бюджета/);
  assert.equal(called, false);
  assert.equal(f.saved.length, 0);
});

test('таймаут сохраняет резерв и блокирует новые запросы даже после восстановления', async () => {
  const f = fixture();
  await assert.rejects(() => f.guard.run(30, async () => { throw new Error('timeout'); }), /timeout/);
  assert.equal(f.saved.at(-1).blocked, true);
  assert.equal(f.saved.at(-1).outstanding.reserve_rub, 30);
  await assert.rejects(() => f.guard.run(1, async () => response(1)), /исход прошлого/);
  const resumed = fixture({ state: f.saved.at(-1) });
  await assert.rejects(() => resumed.guard.run(1, async () => response(1)), /исход прошлого/);
});

test('отсутствующая или превышающая резерв стоимость не освобождает его', async () => {
  for (const value of [undefined, null, '0.1', -1, 101, NaN]) {
    const f = fixture();
    const result = await f.guard.run(100, async () => ({ usage: { cost_rub: value } }));
    assert.equal(result.settled, false);
    assert.equal(result.budget.blocked, true);
    assert.equal(f.saved.at(-1).outstanding.reserve_rub, 100);
    await assert.rejects(() => f.guard.run(1, async () => response(1)), /исход прошлого/);
  }
});

test('до получения актуального счётчика цена после ответа остаётся в резерве', async () => {
  const f = fixture({ reads: [baseline, baseline - 1] });
  const result = await f.guard.run(20, async () => response(1));
  assert.equal(result.settled, false);
  assert.equal(result.budget.blocked, true);
  assert.equal(result.budget.outstanding.reserve_rub, 20);
});

test('невозможность сохранить резерв предотвращает вызов провайдера', async () => {
  const f = fixture({ save: async () => { throw new Error('disk unavailable'); } });
  let called = false;
  await assert.rejects(() => f.guard.run(2, async () => { called = true; return response(1); }), /Резерв не сохранён/);
  assert.equal(called, false);
  assert.equal(f.guard.snapshot().blocked, true);
});

test('две параллельные операции не запускаются', async () => {
  const f = fixture();
  let release; const pause = new Promise(resolve => { release = resolve; });
  const first = f.guard.run(5, async () => { await pause; return response(1); });
  await assert.rejects(() => f.guard.run(5, async () => response(1)), /Бюджет занят/);
  release();
  assert.equal((await first).settled, true);
});

test('отмена после отправки оставляет резерв', async () => {
  const controller = new AbortController(), f = fixture({ signal: controller.signal });
  await assert.rejects(() => f.guard.run(20, async () => { controller.abort(); return response(1); }), /abort/i);
  assert.equal(f.saved.at(-1).blocked, true);
  assert.equal(f.saved.at(-1).outstanding.reserve_rub, 20);
});

test('битое сохранённое состояние не восстанавливается', () => {
  assert.throws(() => fixture({ state: { baseline_rub: baseline } }), /Некорректный сохранённый бюджет/);
});

const unpriced = text => ({ http_status: 200, body: { text } });

test('успешный ответ STT без цены учитывает весь резерв в лимите, но не как реальную цену', async () => {
  const f = fixture({ priorReservedRub: 60, reads: [baseline, baseline, baseline, baseline] });
  const first = await f.guard.runUnpriced(20, async () => {
    assert.equal(f.saved.at(-1).outstanding.reserve_rub, 20);
    assert.equal(f.saved.at(-1).unpriced_reserved_rub, 60);
    return unpriced('первый фрагмент');
  });
  assert.equal(first.settled, true);
  assert.equal(first.accounted_as, 'unpriced_reserve');
  assert.equal(first.budget.confirmed_rub, 0);
  assert.equal(first.budget.unpriced_reserved_rub, 80);
  assert.equal(first.budget.conservative_spent_rub, 80);
  assert.equal(f.saved.at(-1).outstanding, null);
  const second = await f.guard.runUnpriced(20, async () => unpriced('второй фрагмент'));
  assert.equal(second.settled, true);
  assert.equal(second.budget.unpriced_reserved_rub, 100);
  const restored = fixture({ priorReservedRub: 60, state: f.saved.at(-1) });
  assert.equal(restored.guard.snapshot().unpriced_reserved_rub, 100);
  assert.equal(restored.guard.snapshot().confirmed_rub, 0);
});

test('неизвестную цену нельзя освободить обычным run', async () => {
  const f = fixture({ priorReservedRub: 60 });
  const result = await f.guard.run(20, async () => ({ text: 'ответ без цены' }));
  assert.equal(result.settled, false);
  assert.equal(result.budget.blocked, true);
  assert.equal(result.budget.outstanding.reserve_rub, 20);
  assert.equal(result.budget.unpriced_reserved_rub, 60);
});

test('runUnpriced принимает только законченный HTTP 200 с непустым текстом и без иных полей', async () => {
  const invalid = [null, {}, { http_status: 500, body: { text: 'ошибка' } },
    { http_status: 200, body: { text: '' } }, { http_status: 200, body: { text: '   ' } },
    { http_status: 200, body: { text: 'x'.repeat(30001) } },
    { http_status: 200, body: { text: 'ok', usage: { cost_rub: 0 } } },
    { http_status: 200, body: { text: 'ok' }, extra: 1 }, response(1)];
  for (const value of invalid) {
    const f = fixture({ priorReservedRub: 60 });
    const result = await f.guard.runUnpriced(20, async () => value);
    assert.equal(result.settled, false);
    assert.equal(result.budget.blocked, true);
    assert.equal(result.budget.outstanding.reserve_rub, 20);
    assert.equal(result.budget.unpriced_reserved_rub, 60);
    await assert.rejects(() => f.guard.runUnpriced(1, async () => unpriced('x')), /исход прошлого/);
  }
});

test('runUnpriced учитывает расход всего ключа и прежние резервы до нового запроса', async () => {
  const f = fixture({ priorReservedRub: 60, reads: [baseline + 421] });
  let called = false;
  await assert.rejects(() => f.guard.runUnpriced(20, async () => { called = true; return unpriced('x'); }), /Недостаточно бюджета/);
  assert.equal(called, false);
  assert.equal(f.saved.length, 0);
});

test('таймаут runUnpriced сохраняет резерв и после восстановления блокирует продолжение', async () => {
  const f = fixture({ priorReservedRub: 60 });
  await assert.rejects(() => f.guard.runUnpriced(20, async () => { throw new Error('timeout'); }), /timeout/);
  assert.equal(f.saved.at(-1).outstanding.reserve_rub, 20);
  assert.equal(f.saved.at(-1).unpriced_reserved_rub, 60);
  const restored = fixture({ priorReservedRub: 60, state: f.saved.at(-1) });
  await assert.rejects(() => restored.guard.runUnpriced(1, async () => unpriced('x')), /исход прошлого/);
});

test('после успешного текста сбой записи удерживает резерв и не разрешает повтор', async () => {
  let calls = 0;
  const f = fixture({ priorReservedRub: 60, save: async () => { if (++calls >= 2) throw new Error('disk'); } });
  const result = await f.guard.runUnpriced(20, async () => unpriced('текст'));
  assert.equal(result.settled, false);
  assert.equal(result.budget.blocked, true);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].outstanding.reserve_rub, 20);
  const restored = fixture({ priorReservedRub: 60, state: f.saved[0] });
  await assert.rejects(() => restored.guard.runUnpriced(1, async () => unpriced('x')), /исход прошлого/);
});

test('предыдущее состояние версии 1 восстанавливается и недостающие старые резервы учитываются', async () => {
  const state = { version: 1, baseline_rub: baseline, limit_rub: 500, max_usage_rub: baseline,
    confirmed_rub: 3, outstanding: null, blocked: false };
  const restored = fixture({ state, priorReservedRub: 60 });
  assert.equal(restored.guard.snapshot().version, 2);
  assert.equal(restored.guard.snapshot().conservative_spent_rub, 63);
  await restored.guard.runUnpriced(20, async () => unpriced('x'));
  assert.equal(restored.saved.at(-1).unpriced_reserved_rub, 80);
  assert.throws(() => fixture({ state: restored.saved.at(-1), priorReservedRub: 81 }), /Некорректный сохранённый бюджет/);
});

test('только явное разрешение аудио допускает строго пустой текст с удержанием резерва', async () => {
  const f = fixture({ priorReservedRub: 60 });
  assert.throws(() => f.guard.runUnpricedAudio(20, async () => unpriced('')), /явное разрешение/);
  assert.throws(() => f.guard.runUnpricedAudio(20, async () => unpriced(''), { allowEmptyText: false }), /явное разрешение/);
  assert.throws(() => f.guard.runUnpricedAudio(20, async () => unpriced(''), { allowEmptyText: true, other: true }), /явное разрешение/);
  assert.equal(f.saved.length, 0);
  const result = await f.guard.runUnpricedAudio(20, async () => unpriced(''), { allowEmptyText: true });
  assert.equal(result.settled, true);
  assert.equal(result.empty_audio_text, true);
  assert.equal(result.accounted_as, 'unpriced_reserve');
  assert.equal(result.budget.unpriced_reserved_rub, 80);
  assert.equal(result.budget.confirmed_rub, 0);
  assert.equal(result.budget.blocked, false);
  assert.equal(f.saved.at(-1).blocked, true);
  const next = await f.guard.runUnpricedAudio(20, async () => unpriced('слова'), { allowEmptyText: true });
  assert.equal(next.settled, true);
  assert.equal(next.empty_audio_text, undefined);
  assert.equal(next.budget.unpriced_reserved_rub, 100);
});

test('пустой обычный STT и пробелы или HTTP-ошибка аудио не допускаются', async () => {
  const ordinary = fixture({ priorReservedRub: 60 });
  assert.equal((await ordinary.guard.runUnpriced(20, async () => unpriced(''))).settled, false);
  for (const value of [unpriced(' '), {http_status: 500, body: {text: ''}},
    {http_status: 200, body: {text: '', extra: 'x'}}, {http_status: 200, body: {text: null}}]) {
    const f = fixture({ priorReservedRub: 60 });
    const result = await f.guard.runUnpricedAudio(20, async () => value, { allowEmptyText: true });
    assert.equal(result.settled, false);
    assert.equal(result.budget.blocked, true);
    assert.equal(result.budget.outstanding.reserve_rub, 20);
    assert.equal(result.budget.unpriced_reserved_rub, 60);
  }
});

test('сбой после записи финального снимка оставляет восстановленный guard заблокированным', async () => {
  const durable = []; let writes = 0;
  const f = fixture({ priorReservedRub: 60, save: async item => {
    writes++;
    if (writes <= 2) durable.push(structuredClone(item));
    if (writes >= 2) throw new Error('fsync');
  } });
  const result = await f.guard.runUnpricedAudio(20, async () => unpriced(''), { allowEmptyText: true });
  assert.equal(result.settled, false);
  assert.equal(result.budget.blocked, true);
  assert.equal(durable.at(-1).blocked, true);
  assert.equal(durable.at(-1).unpriced_reserved_rub, 80);
  const restored = fixture({ priorReservedRub: 60, state: durable.at(-1) });
  await assert.rejects(() => restored.guard.runUnpricedAudio(1, async () => unpriced(''), { allowEmptyText: true }), /исход прошлого/);
});

test('при изменении объекта ответа во время записи возвращается проверенная копия', async () => {
  const reply = unpriced('исходный текст');
  let writes = 0;
  const f = fixture({ priorReservedRub: 60, save: async () => { if (++writes === 2) reply.body.text = 'подмена'; } });
  const result = await f.guard.runUnpricedAudio(20, async () => reply, { allowEmptyText: true });
  assert.equal(result.response.body.text, 'исходный текст');
  assert.equal(result.budget.unpriced_reserved_rub, 80);
});

test('отмена после пустого ответа сохраняет outstanding и закрывает продолжение', async () => {
  const controller = new AbortController(), f = fixture({ signal: controller.signal, priorReservedRub: 60 });
  await assert.rejects(() => f.guard.runUnpricedAudio(20, async () => { controller.abort(); return unpriced(''); },
    { allowEmptyText: true }), /abort/i);
  assert.equal(f.saved.at(-1).blocked, true);
  assert.equal(f.saved.at(-1).outstanding.reserve_rub, 20);
  assert.equal(f.saved.at(-1).unpriced_reserved_rub, 60);
});

test('отмена во время сохранения результата не разрешает следующий запрос', async () => {
  const controller = new AbortController(); let writes = 0;
  const f = fixture({ signal: controller.signal, priorReservedRub: 60,
    save: async () => { if (++writes === 2) controller.abort(); } });
  const result = await f.guard.runUnpricedAudio(20, async () => unpriced(''), { allowEmptyText: true });
  assert.equal(result.settled, false);
  assert.equal(result.budget.blocked, true);
  assert.equal(result.budget.outstanding.reserve_rub, 20);
  assert.equal(f.saved.at(-1).blocked, true);
  const restored = fixture({ priorReservedRub: 60, state: f.saved.at(-1) });
  await assert.rejects(() => restored.guard.runUnpricedAudio(1, async () => unpriced(''), { allowEmptyText: true }), /исход прошлого/);
});
