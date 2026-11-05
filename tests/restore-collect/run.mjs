import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectDeal } from '../../app/src/collect/index.mjs';

const NOW = Date.parse('2026-11-05T00:00:00Z');
const wait = async () => {};

function fixture({ reason = '123', reasonText = 'Другая', respond } = {}) {
  const calls = [];
  const client = {
    async request(method, body) {
      calls.push({ method, body });
      const overridden = await respond?.(method, body, calls);
      if (overridden !== undefined) return overridden;
      switch (method) {
        case 'crm.deal.userfield.list':
          return { result: [{ LIST: [{ ID: reason, VALUE: reasonText }] }] };
        case 'crm.deal.get':
          return { result: {
            ID: '42', STAGE_ID: 'C23:LOSE', ASSIGNED_BY_ID: '65',
            UF_CRM_1584703948317: reason, TITLE: 'Тестовая сделка',
          } };
        case 'crm.stagehistory.list':
          return { result: { items: [
            { STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' },
            { STAGE_ID: 'C23:UC_GDK5HI', CREATED_TIME: '2026-11-03T00:00:00Z' },
          ] } };
        case 'crm.activity.list':
        case 'crm.timeline.comment.list':
        case 'imopenlines.crm.chat.get':
          return { result: [] };
        case 'tasks.task.list':
          return { result: { tasks: [] } };
        default:
          throw new Error(`Неожиданный метод ${method}`);
      }
    },
  };
  return { client, calls };
}

test('техническая причина пропускается после истории стадий и до сбора коммуникаций', async () => {
  for (const [reason, reasonText, expected] of [
    ['3297', 'Переименованное значение', 'дубль'],
    ['7777', ' Дополнительный контакт ', 'дополнительный контакт'],
  ]) {
    const { client, calls } = fixture({ reason, reasonText });
    const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
    assert.equal(result._status, 'skipped_by_reason');
    assert.equal(result._skip_reason_key, expected);
    assert.equal(result.deal_data.lose_date, '2026-11-04T00:00:00Z');
    assert.equal(result.deal_data.previous_stage_id, 'C23:UC_GDK5HI');
    assert.equal(result.deal_data.days_in_lost, 1);
    assert.deepEqual(result.deal_data.communications, []);
    assert.equal(calls.some(call => call.method === 'crm.activity.list'), false);
    assert.equal(result.ready_for_analysis, false);
  }
});

test('необновлённая история не подставляет старый отказ текущей сделке', async () => {
  const { client, calls } = fixture({ respond(method) {
    if (method === 'crm.stagehistory.list') return { result: { items: [
      { STAGE_ID: 'C23:NEW', CREATED_TIME: '2026-11-04T00:01:00Z' },
      { STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-10-01T00:00:00Z' },
    ] } };
  } });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
  assert.equal(result._status, 'error');
  assert.equal(calls.some(call => call.method === 'crm.activity.list'), false);
});

test('свежий отказ ждёт готовности записи и перепроверяет стадию', async () => {
  const waits = [];
  const { client, calls } = fixture({ respond(method) {
    if (method === 'crm.stagehistory.list') return { result: { items: [
      { STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T23:59:00Z' },
    ] } };
  } });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait: async ms => { waits.push(ms); } });
  assert.equal(result._status, 'pending_normalization');
  assert.deepEqual(waits, [240000]);
  assert.equal(calls.filter(call => call.method === 'crm.deal.get').length, 2);
  assert.equal(calls.filter(call => call.method === 'crm.stagehistory.list').length, 2);
});

test('при смене стадии во время ожидания общение не собирается', async () => {
  let dealReads = 0;
  const { client, calls } = fixture({ respond(method) {
    if (method === 'crm.deal.get' && ++dealReads === 2) return { result: { STAGE_ID: 'C23:NEW' } };
    if (method === 'crm.stagehistory.list') return { result: { items: [
      { STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T23:59:00Z' },
    ] } };
  } });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait: async () => {} });
  assert.equal(result._status, 'skipped');
  assert.equal(calls.some(call => call.method === 'crm.activity.list'), false);
});

test('собираются все страницы и уникальные сессии, файлы остаются в сыром ответе', async () => {
  const attachment = { id: 7, type: 'audio', extension: 'ogg' };
  const { client, calls } = fixture({
    respond(method, body) {
      if (method === 'crm.stagehistory.list' && body.start === 0) {
        return { result: { items: [{ STAGE_ID: 'C23:LOSE', CREATED_TIME: '2026-11-04T00:00:00Z' }] }, next: 50 };
      }
      if (method === 'crm.stagehistory.list' && body.start === 50) {
        return { result: { items: [{ STAGE_ID: 'C23:EXECUTING' }] } };
      }
      if (method === 'crm.activity.list' && body.filter.TYPE_ID === 2) {
        return body.start === 0 ? { result: [{ ID: '1' }], next: 50 } : { result: [{ ID: '2' }] };
      }
      if (method === 'crm.activity.list' && body.filter.PROVIDER_ID) {
        return { result: [{ ASSOCIATED_ENTITY_ID: '99' }, { ASSOCIATED_ENTITY_ID: '99' }] };
      }
      if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: '25' }] };
      if (method === 'imopenlines.session.history.get') {
        return { result: { message: { 1: { senderid: 0, text: '', params: { FILE_ID: [7] } } }, chat: { 25: {} }, files: { 7: attachment } } };
      }
    },
  });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
  assert.equal(result._status, 'pending_normalization');
  assert.equal(result.ready_for_analysis, false);
  assert.equal(result.raw.calls.length, 2);
  assert.equal(result.deal_data.previous_stage_id, 'C23:EXECUTING');
  assert.equal(result.raw.sessions.length, 1);
  assert.deepEqual(result.raw.sessions[0].history.files[7], attachment);
  assert.deepEqual(result.raw.sessions[0].history.message[1].params.FILE_ID, [7]);
  assert.equal(calls.filter(call => call.method === 'imopenlines.session.history.get').length, 1);
  assert.ok(Object.values(result._sources).every(source => source.complete));
});

test('при отсутствии сообщений в сессии вызывается запасной путь по чату', async () => {
  const { client, calls } = fixture({
    respond(method, body) {
      if (method === 'crm.activity.list' && body.filter.PROVIDER_ID) {
        return { result: [{ ASSOCIATED_ENTITY_ID: '99' }] };
      }
      if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: '25' }] };
      if (method === 'imopenlines.session.history.get') return { result: { message: {}, files: {} } };
    },
  });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
  assert.equal(result._status, 'pending_normalization');
  assert.deepEqual(calls.filter(call => call.method === 'imopenlines.session.history.get').map(call => call.body), [
    { SESSION_ID: 99 }, { CHAT_ID: 25 },
  ]);
});

test('сессия без ID не считается полностью полученной', async () => {
  const { client } = fixture({
    respond(method, body) {
      if (method === 'crm.activity.list' && body.filter.PROVIDER_ID) return { result: [{ ID: '3' }] };
      if (method === 'imopenlines.crm.chat.get') return { result: [] };
    },
  });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
  assert.equal(result._sources.openlines.complete, false);
});

test('история без поля message не считается полностью полученной', async () => {
  for (const badPath of ['session', 'chat']) {
    const { client } = fixture({
      respond(method, body) {
        if (method === 'crm.activity.list' && body.filter.PROVIDER_ID) {
          return { result: [{ ASSOCIATED_ENTITY_ID: '99' }] };
        }
        if (method === 'imopenlines.crm.chat.get') return { result: [{ CHAT_ID: '25' }] };
        if (method === 'imopenlines.session.history.get') {
          const isBad = (badPath === 'session') === Boolean(body.SESSION_ID);
          return { result: isBad ? {} : { message: {} } };
        }
      },
    });
    const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
    assert.equal(result._status, 'error');
    assert.equal(result._sources.openlines.complete, false);
    assert.equal(result.ready_for_analysis, false);
  }
});

test('ошибка источника после трёх попыток блокирует передачу на анализ и скрывает секрет', async () => {
  const delays = [];
  const { client, calls } = fixture({
    respond(method) {
      if (method === 'crm.timeline.comment.list') {
        const error = new Error('https://example.test/rest/65/секретный-токен/');
        error.status = 502;
        throw error;
      }
    },
  });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait: async ms => delays.push(ms) });
  assert.equal(result._status, 'error');
  assert.equal(result._step, 'collect_incomplete');
  assert.equal(result._sources.comments.complete, false);
  assert.equal(result._sources.comments.error, 'HTTP 502');
  assert.equal(result._sources.comments.attempts, 3);
  assert.equal(result.ready_for_analysis, false);
  assert.equal(JSON.stringify(result).includes('секретный-токен'), false);
  assert.deepEqual(delays, [2000, 4000]);
  assert.equal(calls.filter(call => call.method === 'crm.timeline.comment.list').length, 3);
});

test('повтор cursor не позволяет объявить неполную выборку полной', async () => {
  const { client } = fixture({
    respond(method, body) {
      if (method === 'crm.activity.list' && body.filter.TYPE_ID === 2) return { result: [], next: 0 };
    },
  });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
  assert.equal(result._status, 'error');
  assert.equal(result._sources.calls.complete, false);
  assert.equal(result.ready_for_analysis, false);
});

test('восстановленный после ошибки запрос отражает число попыток', async () => {
  let requests = 0;
  const { client } = fixture({
    respond(method, body) {
      if (method === 'crm.activity.list' && body.filter.TYPE_ID === 2 && ++requests === 1) {
        throw new Error('temporary');
      }
    },
  });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
  assert.equal(result._status, 'pending_normalization');
  assert.equal(result._sources.calls.attempts, 2);
});

test('сделка, вышедшая из отказа, не доходит до коммуникаций', async () => {
  const { client, calls } = fixture({
    respond(method) {
      if (method === 'crm.deal.get') return { result: { ID: '42', STAGE_ID: 'C23:WON' } };
    },
  });
  const result = await collectDeal({ client, dealId: 42, now: NOW, wait });
  assert.equal(result._status, 'error');
  assert.equal(result._step, 'check_stage');
  assert.equal(result._reason, 'not_in_lost_stage');
  assert.equal(calls.some(call => call.method === 'crm.activity.list'), false);
});
