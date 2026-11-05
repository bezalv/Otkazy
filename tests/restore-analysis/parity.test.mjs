import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

import { buildJournal } from '../../app/src/analysis/journal.mjs';
import { buildCommunicationAnalytics } from '../../app/src/analysis/communication-analytics.mjs';
import { assembleFacts } from '../../app/src/analysis/facts-assembler.mjs';

// В старом n8n даты журнала при сверке с базой совпали с UTC.
process.env.TZ = 'UTC';

const require = createRequire(import.meta.url);
const fixtures = require('../b45/fixtures.js');
const backupDir = resolve('tmp/backup/GLQ2iuzRaCQZM7QU');
const prompt = 'Тестовый промпт судьи';
const now = new Date('2026-10-19T12:00:00.000Z');
const snapshots = {
  journal: resolve(backupDir, 'блок-4-хронологический-журнал-2026-10-19.js'),
  analytics: resolve(backupDir, 'b4-5-comm-analytics-2026-10-19.js'),
  facts: resolve(backupDir, 'agent-facts-assembler-2026-10-19.js'),
};

function runSnapshot(snapshot, input) {
  const code = readFileSync(snapshot, 'utf8');
  const nodeInput = { first: () => ({ json: input }) };
  const getNode = (name) => {
    assert.equal(name, 'Set: Judge System Prompt');
    return { first: () => ({ json: { content: prompt } }) };
  };
  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now.getTime();
    }
  }
  return new Function('$input', '$', 'Date', code)(nodeInput, getNode, FixedDate)[0].json;
}

const cases = {
  ...fixtures.real,
  ...fixtures.edge,
  conversations: {
    deal_id: 999999,
    title: 'Проверочная сделка',
    lose_date: '2026-10-19T10:00:00Z',
    communications: [
      { type: 'call', date: '2026-10-18T09:00:00Z', direction: 'incoming', duration_seconds: 9, transcript_client_text: 'Алло' },
      { type: 'call', date: '2026-10-18T10:00:00Z', direction: 'outgoing', duration_seconds: 80, _transcript_mode: 'mono', transcript: 'Говорящий: Я заказал окна у конкурента' },
      { type: 'chat', date: '2026-10-18T11:00:00Z', direction: 'incoming', role: 'client', text: 'Спасибо, подумаю' },
      { type: 'comment', date: '2026-10-18T12:00:00Z', text: 'Обсудили стоимость', screenshot_turns: [{ speaker: 'client', text: 'Слишком дорого', ts: '2026-10-18T11:30:00Z' }] },
      { type: 'comment', date: '2026-10-18T13:00:00Z', text: 'AI-анализ отказа' },
      { type: 'task', date: '2026-10-18T14:00:00Z', title: 'Позвонить клиенту', status: '5' },
    ],
  },
};

for (const [name, input] of Object.entries(cases)) {
  test(`перенесённые ноды совпадают с выгрузкой: ${name}`, {
    skip: !Object.values(snapshots).every(existsSync),
  }, () => {
    const oldJournal = runSnapshot(snapshots.journal, structuredClone(input));
    const newJournal = buildJournal(structuredClone(input));
    assert.deepStrictEqual(newJournal, oldJournal);

    const oldAnalytics = runSnapshot(snapshots.analytics, oldJournal);
    const newAnalytics = buildCommunicationAnalytics(newJournal, now);
    assert.deepStrictEqual(newAnalytics, oldAnalytics);

    const oldFacts = runSnapshot(snapshots.facts, oldAnalytics);
    const newFacts = assembleFacts(newAnalytics, prompt);
    assert.deepStrictEqual(newFacts, oldFacts);
  });
}

test('сборщик исключает собственный комментарий и сохраняет реплики скриншота', () => {
  const input = cases.conversations;
  const result = assembleFacts(input, prompt);
  assert.equal(result.facts_packet.facts.some((fact) => fact.content === 'AI-анализ отказа'), false);
  assert.equal(result.facts_packet.facts.some((fact) => fact.source === 'screenshot_chat' && fact.actor === 'client'), true);
  assert.equal(result.judge_request_body.messages[0].content, prompt);
});

test('теги Битрикса с подчёркиванием не считаются текстом чата', () => {
  const result = buildCommunicationAnalytics({
    lose_date: '2026-10-19T10:00:00Z',
    communications: [
      { type: 'chat', date: '2026-10-18T11:00:00Z', direction: 'incoming', text: '[USER_TAG=123]' },
    ],
  }, now);
  assert.equal(result.comm_analytics.chats_total, 0);
});

test('детектор разговора совпадает с исходником проекта', () => {
  const source = readFileSync('prototype/lib/no-conversation.js', 'utf8').replace(/\r\n/g, '\n').trimEnd();
  const module = readFileSync('app/src/analysis/no-conversation.mjs', 'utf8').replace(/\r\n/g, '\n').trimEnd();
  assert.equal(module, `${source}\n\nexport { detectNoConversation };`);
});

test('сообщение с файлом и служебной фразой сохраняет распознанную речь', () => {
  const communication = {
    type: 'chat',
    date: '2026-10-18T11:00:00Z',
    role: 'client',
    direction: 'incoming',
    _has_files: true,
    _has_audio: true,
    _has_audio_transcript: true,
    transcript: 'Клиент: Я хочу заказать окна',
    text: 'Сессия закрыта\n\n[Голосовое сообщение]: Я хочу заказать окна',
  };
  const input = {
    lose_date: '2026-10-19T10:00:00Z',
    communications: [communication],
  };
  assert.equal(buildCommunicationAnalytics(input, now).comm_analytics.chats_total, 1);
  const facts = assembleFacts(input, prompt).facts_packet.facts;
  assert.equal(facts.length, 1);
  assert.equal(facts[0].source, 'chat_voice_transcript');
  assert.match(facts[0].content, /Я хочу заказать окна/);
});

test('служебная фраза без файлов по-прежнему исключается', () => {
  const input = {
    lose_date: '2026-10-19T10:00:00Z',
    communications: [{
      type: 'chat',
      date: '2026-10-18T11:00:00Z',
      text: 'Сессия закрыта',
    }],
  };
  assert.equal(buildCommunicationAnalytics(input, now).comm_analytics.chats_total, 0);
  assert.equal(assembleFacts(input, prompt).facts_packet.facts.length, 0);
});

test('журнал и метрики используют UTC независимо от пояса процесса', () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Novosibirsk';
  try {
    const input = {
      lose_date: '2026-09-29T07:07:38Z',
      communications: [{
        type: 'chat',
        date: '2026-09-26T00:36:40+03:00',
        role: 'client',
        direction: 'incoming',
        text: 'Здравствуйте',
      }],
    };
    assert.match(buildJournal(input).journal_text, /\[25\.09\.2026 21:36\]/);
    assert.equal(buildCommunicationAnalytics(input, now).comm_analytics.chats_last_client_msg, '25.09.2026');
  } finally {
    process.env.TZ = previousTimezone;
  }
});
