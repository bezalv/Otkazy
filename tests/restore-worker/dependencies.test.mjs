import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createWorkerDependencies } from '../../app/src/worker/dependencies.mjs';

test('подготовка зависимостей не обращается к базе или сети', () => {
  const forbidden = () => assert.fail('подготовка не должна подключаться к сервисам');
  const result = createWorkerDependencies({ pool: { query: forbidden, connect: forbidden },
    bitrixBaseUrl: 'https://example.invalid/rest/1/test/', polzaKey: 'fixture',
    sttUrl: 'http://127.0.0.1:8790', sttKey: 'fixture', tempRoot: tmpdir(), judgePrompt: 'судья', writerPrompt: 'писатель', fetchImpl: forbidden });
  assert.equal(typeof result.pump.tick, 'function');
  assert.equal(typeof result.queue.claim, 'function');
});

test('пустой промпт блокирует подготовку конвейера', () => {
  assert.throws(() => createWorkerDependencies({ pool: { query() {}, connect() {} }, judgePrompt: '', writerPrompt: 'a' }), /промпты/i);
});

test('отсутствующий или относительный каталог аудио запрещён', () => {
  const input = { pool: { query() {}, connect() {} }, judgePrompt: 'судья', writerPrompt: 'писатель' };
  assert.throws(() => createWorkerDependencies(input), /временный каталог/);
  assert.throws(() => createWorkerDependencies({ ...input, tempRoot: 'relative' }), /временный каталог/);
});
