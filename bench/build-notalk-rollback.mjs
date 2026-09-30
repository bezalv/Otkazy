// Сборка готовых операций откaта для правки детектора «разговора не было».
// Собирается машинно из файла детектора и известных якорей — код через контекст не переносится.
// Результат подаётся в n8n_update_partial_workflow как есть.
//
// Запуск: node bench/build-notalk-rollback.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const detector = fs.readFileSync(path.join(ROOT, 'prototype', 'lib', 'no-conversation.node.js'), 'utf8')
  .replace(/\r\n/g, '\n').replace(/\n$/, '');

// Ровно так детектор вставлялся: перед этими строками, с маркером конца после.
const ANCHOR_ASSEMBLER = "var input = $input.first().json;\nvar comms = input.communications || [];";
const ANCHOR_B45 = "var input = $input.first().json;\nvar commsRaw = input.communications || [];";
const DETECTOR_BLOCK = detector + '\n// === КОНЕЦ ДЕТЕКТОРА ===\n';

// Вторая вставка в сборщике: обработка звонка без разговора перед блоком реплики менеджера.
const ASSEMBLER_HOOK_ANCHOR = "    if (hasMgr) {\n      facts.push({\n        fact_id: nextId(), source: 'call_transcript', actor: 'manager',";
const ASSEMBLER_HOOK = `    // Разговора с клиентом не было: ответил автоответчик, помощник, чужой человек,
    // прозвучало только приветствие или не установилась связь. Такой звонок даёт один факт
    // с actor=system: иначе голос автоответчика уходит в факты репликой клиента и судья
    // считает его контактом (дефект сделки 119215).
    var ncMono = String(c.transcript || '').indexOf('Говорящий') !== -1;
    var noTalk = detectNoConversation(c.transcript_client_text, c.transcript_manager_text, dur, ncMono);
    if (noTalk) {
      vmStats.calls_no_conversation = (vmStats.calls_no_conversation || 0) + 1;
      var ntWhy = noTalk.reason === 'machine' ? 'ответил автоответчик или голосовой помощник'
        : noTalk.reason === 'not_client' ? 'трубку снял не клиент'
        : noTalk.reason === 'bad_line' ? 'связь не установилась, предложение до клиента не дошло'
        : 'прозвучало только приветствие, цель звонка не названа';
      var ntParts = [];
      if (c.transcript_client_text && c.transcript_client_text.trim()) ntParts.push('та сторона: «' + c.transcript_client_text.trim() + '»');
      if (c.transcript_manager_text && c.transcript_manager_text.trim()) ntParts.push('менеджер: «' + c.transcript_manager_text.trim() + '»');
      facts.push({
        fact_id: nextId(), source: 'call_event', actor: 'system',
        ts: ts, direction: c.direction || null,
        content: 'Звонок ' + (c.direction || '?') + ', ' + dur + ' сек: разговор не состоялся — ' + ntWhy
          + '. Не считать это контактом с клиентом и не приписывать ему слова с той стороны'
          + (ntParts.length ? '. Записано — ' + ntParts.join('; ') : '')
      });
      continue;
    }

`;

// Правки метрик в b4.5 — пары «как стало» → «как было».
const B45_PAIRS = [
  {
    now: `calls.sort(function(a, b) { return a.ts - b.ts; });
chats.sort(function(a, b) { return a.ts - b.ts; });
// Звонки, где разговора с клиентом не было (автоответчик, помощник, чужой человек,
// одно приветствие, обрыв связи), не должны считаться успешными и сдвигать последний
// контакт: иначе «дни молчания» обнуляются о звонок автоответчику (дефект сделки 119215).
// Сам звонок из calls_total не выкидываем — попытка была, и РОП должен её видеть.
var noTalkIdx = {};
var callsNoConversation = 0;
for (var nci = 0; nci < calls.length; nci++) {
  var ncd = calls[nci].data;
  var ncMono = String(ncd.transcript || '').indexOf('Говорящий') !== -1;
  if (detectNoConversation(ncd.transcript_client_text, ncd.transcript_manager_text, getCallDuration(calls[nci]), ncMono)) {
    calls[nci].noConversation = true;
    noTalkIdx[calls[nci].index] = true;
    callsNoConversation++;
  }
}`,
    was: `calls.sort(function(a, b) { return a.ts - b.ts; });
chats.sort(function(a, b) { return a.ts - b.ts; });`
  },
  {
    now: `var meaningfulCalls = calls.filter(function(c) { return !c.noConversation && getCallDuration(c) > 15; });`,
    was: `var meaningfulCalls = calls.filter(function(c) { return getCallDuration(c) > 15; });`
  },
  {
    now: `for (var ai = 0; ai < comms.length; ai++) { if (noTalkIdx[ai]) continue; var ats = parseDate(comms[ai].date); if (ats) allEvents.push({ ts: ats, data: comms[ai] }); }`,
    was: `for (var ai = 0; ai < comms.length; ai++) { var ats = parseDate(comms[ai].date); if (ats) allEvents.push({ ts: ats, data: comms[ai] }); }`
  },
  {
    now: `for (var ii = 0; ii < comms.length; ii++) { var cm = comms[ii]; if (noTalkIdx[ii]) continue; if (cm.type === 'call') {`,
    was: `for (var ii = 0; ii < comms.length; ii++) { var cm = comms[ii]; if (cm.type === 'call') {`
  },
  {
    now: `var analytics = { cutoff_at: new Date(cutoffTs).toISOString(), cutoff_source: cutoffSource, calls_no_conversation: callsNoConversation,`,
    was: `var analytics = { cutoff_at: new Date(cutoffTs).toISOString(), cutoff_source: cutoffSource,`
  }
];

const ops = [
  {
    _что: 'Сборщик фактов: убрать обработку звонка без разговора',
    workflow: 'GLQ2iuzRaCQZM7QU',
    operation: {
      type: 'patchNodeField', nodeName: 'agent-facts-assembler', fieldPath: 'parameters.jsCode',
      patches: [{ find: ASSEMBLER_HOOK + ASSEMBLER_HOOK_ANCHOR, replace: ASSEMBLER_HOOK_ANCHOR }]
    }
  },
  {
    _что: 'Сборщик фактов: убрать код детектора',
    workflow: 'GLQ2iuzRaCQZM7QU',
    operation: {
      type: 'patchNodeField', nodeName: 'agent-facts-assembler', fieldPath: 'parameters.jsCode',
      patches: [{ find: DETECTOR_BLOCK + ANCHOR_ASSEMBLER, replace: ANCHOR_ASSEMBLER }]
    }
  },
  {
    _что: 'b4.5: вернуть метрики к состоянию до детектора',
    workflow: 'GLQ2iuzRaCQZM7QU',
    operation: {
      type: 'patchNodeField', nodeName: 'b4.5 Comm Analytics', fieldPath: 'parameters.jsCode',
      patches: B45_PAIRS.map(p => ({ find: p.now, replace: p.was }))
    }
  },
  {
    _что: 'b4.5: убрать код детектора',
    workflow: 'GLQ2iuzRaCQZM7QU',
    operation: {
      type: 'patchNodeField', nodeName: 'b4.5 Comm Analytics', fieldPath: 'parameters.jsCode',
      patches: [{ find: DETECTOR_BLOCK + ANCHOR_B45, replace: ANCHOR_B45 }]
    }
  }
];

const out = path.join(ROOT, 'tmp', 'backup', 'notalk-rollback-ops.json');
fs.writeFileSync(out, JSON.stringify({
  _что_это: 'Готовые операции откaта правки детектора «разговора не было». Подавать в n8n_update_partial_workflow по одной, в порядке ниже: сначала снимаются обращения к детектору, потом сам код.',
  _альтернатива: 'Полный откат — n8n_workflow_versions, mode rollback, versionId 508 (состояние прямо перед правкой, подтверждено диффом 508→509).',
  _собрано: new Date().toISOString(),
  операции: ops
}, null, 2), 'utf8');

console.log(`Операции откaта: ${path.relative(ROOT, out)}`);
console.log(`Детектор в сборке: ${detector.length} символов`);
for (const o of ops) console.log(`  ${o._что} — патчей ${o.operation.patches.length}`);
