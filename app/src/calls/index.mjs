import { copyNeutralReactionTrust } from '../analysis/chat-role-trust.mjs';
import { pgSafeReason } from '../rules/pipeline-gate.mjs';
import { ambiguousProcessingOnly } from './transcript-quality.mjs';
import { PrejudgeStageError } from '../persistence/prejudge.mjs';

function pickAudioUrl(call) {
  for (const file of call.audio_files || []) {
    if (file?.url && String(file.url).trim()) return String(file.url).trim();
  }
  return call.audio_url && String(call.audio_url).trim() ? String(call.audio_url).trim() : '';
}

function needsTranscription(call) {
  if (call._needs_transcription === false) return false;
  if (call._needs_transcription === undefined || call._needs_transcription === null) {
    return Boolean(pickAudioUrl(call));
  }
  return call._needs_transcription === true
    || (typeof call._needs_transcription === 'string' && /^https?:\/\//i.test(call._needs_transcription.trim()));
}

function errorText(result, fallback) {
  const error = result?.error;
  if (error && typeof error === 'object') return String(error.message || error.code || fallback);
  return String(error || fallback);
}

function monoFallback(result) {
  if (result?.success === false) {
    const message = errorText(result, '');
    return result.channels_mismatch === true
      || (/channels?/i.test(message) && /requested/i.test(message));
  }
  return result?.success === true && !String(result.formatted_dialog || '').trim();
}

function durationSeconds(call) {
  if (Number(call.duration_seconds) > 0) return Number(call.duration_seconds);
  const start = Date.parse(call.duration_start);
  const end = Date.parse(call.duration_end);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 1000) : 0;
}

function safeError(value) {
  return pgSafeReason(value).replace(/https?:\/\/[^\s]+/gi, '[адрес]').slice(0, 300) || 'Ошибка распознавания';
}

function transcriptMode(result, requested) {
  if (requested === 1 || result._transcript_mode === 'mono' || Number(result.channel_count) === 1
      || /(^|\n)[ \t]*Говорящий[ \t]*:/.test(result.formatted_dialog || '')) return 'mono';
  return 'stereo';
}

function mergeTranscript(call, result) {
  const out = { ...call };
  if (!result) return out;
  if (result.transcription_coverage) out.transcription_coverage = result.transcription_coverage;
  if (result.formatted_dialog && result.formatted_dialog.length > 0) {
    out.transcript = result.formatted_dialog;
    out.transcript_conversation = result.conversation;
    out.transcript_replicas = result.total_replicas;
    out.transcript_manager_text = result.manager_text;
    out.transcript_client_text = result.client_text;
    out._transcribed = true;
    out._transcript_mode = result._transcript_mode;
    out.transcript_engine = result.transcript_engine || 'speechkit';
  } else {
    out._transcription_attempted = true;
    out._transcription_empty = true;
  }
  return out;
}

/** Последовательный перенос стерео/моно распознавания звонков из n8n. */
export async function transcribeCalls({ dealData, transcribe }) {
  if (!dealData || typeof dealData !== 'object' || !Array.isArray(dealData.communications)) {
    throw new TypeError('Не переданы коммуникации сделки');
  }
  if (dealData.communications.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError('Некорректная коммуникация сделки');
  }
  if (!Number.isSafeInteger(Number(dealData.deal_id)) || Number(dealData.deal_id) <= 0) {
    throw new TypeError('Некорректный ID сделки');
  }
  const calls = dealData.communications.filter(item => item?.type === 'call');
  const candidates = dealData.communications.flatMap((call, index) =>
    call?.type === 'call' && needsTranscription(call) ? [{ call, index }] : []);
  if (candidates.length && typeof transcribe !== 'function') throw new TypeError('Не подключён адаптер транскрибации');

  const results = [];
  const errors = [];
  const seen = new Set();
  for (const { call, index } of candidates) {
    const activityId = call.activity_id;
    const duration = durationSeconds(call);
    function fail(step, message, retryable = true, knownShortChannelMismatch = false) {
      errors.push({
        activity_id: activityId ?? null, step, error: safeError(message), retryable,
        technical_failure: !knownShortChannelMismatch, duration_sec: duration,
      });
    }
    if (!Number.isSafeInteger(Number(activityId)) || Number(activityId) <= 0) {
      fail('activity_id', 'Неизвестен ID звонка');
      continue;
    }
    if (seen.has(String(activityId))) {
      fail('activity_id', 'Повторяющийся ID звонка');
      continue;
    }
    seen.add(String(activityId));
    const url = pickAudioUrl(call);
    if (!url) {
      fail('resolve_url', 'Нет ссылки на аудиозапись');
      continue;
    }
    const fileMatch = url.match(/(?:[?&]|^)fileId=(\d+)(?:[&#]|$)/);
    if (!fileMatch) {
      fail('parse_url', 'Не удалось определить ID файла аудиозаписи');
      continue;
    }
    const request = {
      deal_id: dealData.deal_id,
      file_id: fileMatch[1],
      activity_id: activityId,
      call_date: call.date,
      call_direction: call.direction,
      comm_index: index,
      channel_count: 2,
    };
    let result;
    try {
      result = await transcribe(request);
    } catch (error) {
      if (error instanceof PrejudgeStageError) throw error;
      fail('pass1_stereo', error?.message || 'Ошибка стерео-прохода');
      continue;
    }
    if (result?.activity_id != null && String(result.activity_id) !== String(activityId)) {
      fail('pass1_stereo', 'Ответ относится к другому звонку');
      continue;
    }
    if (result?.success === true && typeof result.formatted_dialog !== 'string') {
      fail('pass1_stereo', 'Некорректный текст транскрипции');
      continue;
    }
    if (result?.success === true && ambiguousProcessingOnly(result)) {
      fail('pass1_stereo', 'Содержание распознавания неоднозначно: обнаружена только фраза ожидания обработки');
      continue;
    }
    if (result?.success === true && String(result.formatted_dialog || '').trim()) {
      const mode = transcriptMode(result, 2);
      const managerText = String(result.manager_text || '').trim();
      const clientText = String(result.client_text || '').trim();
      const managerLabel = /(^|\n)[ \t]*Менеджер[ \t]*:[ \t]*[^\s]/i.test(result.formatted_dialog);
      const clientLabel = /(^|\n)[ \t]*Клиент[ \t]*:[ \t]*[^\s]/i.test(result.formatted_dialog);
      if (mode === 'stereo'
          && ((!managerText && !clientText) || (managerLabel && !managerText) || (clientLabel && !clientText))) {
        fail('pass1_stereo', 'Стерео-транскрипт не содержит распознанного текста стороны');
        continue;
      }
      results.push({ ...result, activity_id: activityId, comm_index: index, _transcript_mode: mode });
      continue;
    }
    if (result?.success === true && result.transcription_coverage?.status === 'incomplete') {
      results.push({ ...result, activity_id: activityId, comm_index: index, _transcript_mode: 'stereo' });
      continue;
    }
    if (!monoFallback(result)) {
      fail('pass1_stereo', errorText(result, 'Стерео-проход не дал результата'), result?.retryable !== false);
      continue;
    }
    try {
      result = await transcribe({ ...request, channel_count: 1, speaker_role: 'Говорящий' });
    } catch (error) {
      if (error instanceof PrejudgeStageError) throw error;
      fail('pass2_mono', error?.message || 'Ошибка моно-прохода');
      continue;
    }
    if (result?.activity_id != null && String(result.activity_id) !== String(activityId)) {
      fail('pass2_mono', 'Ответ относится к другому звонку');
      continue;
    }
    if (result?.success === true && ambiguousProcessingOnly(result)) {
      fail('pass2_mono', 'Содержание распознавания неоднозначно: обнаружена только фраза ожидания обработки');
    } else if (result?.success === true && typeof result.formatted_dialog === 'string') {
      results.push({ ...result, activity_id: activityId, comm_index: index, _transcript_mode: 'mono' });
    } else {
      let message = result?.success === true ? 'Некорректный текст транскрипции' : errorText(result, 'Моно-проход не дал результата');
      const channelsMismatch = result?.channels_mismatch === true
        || (/channels?/i.test(message) && /requested/i.test(message));
      if (channelsMismatch && !(/channels?/i.test(message) && /requested/i.test(message))) {
        message = `Audio channels mismatch, mono requested: ${message}`;
      }
      const retryable = result?.success === true || result?.retryable !== false;
      const shortMismatch = channelsMismatch && !retryable && duration > 0 && duration <= 30;
      fail('pass2_mono', message, retryable, shortMismatch);
    }
  }

  const byId = new Map(results.map(result => [String(result.activity_id), result]));
  const communications = dealData.communications.map(call => call?.type === 'call' && call.activity_id
    ? mergeTranscript(call, byId.get(String(call.activity_id))) : copyNeutralReactionTrust(call, { ...call }));
  const stats = {
    calls_total: calls.length,
    calls_with_audio: candidates.length,
    calls_transcribed: results.filter(result => result.formatted_dialog && result.formatted_dialog.length > 0).length,
    calls_empty: results.filter(result => !result.formatted_dialog || result.formatted_dialog.length === 0).length,
    calls_failed: errors.length,
    calls_by_reserve: results.filter(result => String(result.transcript_engine || '').startsWith('reserve:')).length,
    calls_by_speechkit: results.filter(result => !result.transcript_engine || result.transcript_engine === 'speechkit').length,
    errors,
  };
  return {
    deal_id: dealData.deal_id,
    full_data: dealData,
    communications,
    transcription_results: results,
    transcription_errors: errors,
    calls_total: calls.length,
    calls_with_audio: candidates.length,
    transcription_stats: stats,
    ready_for_analysis: false,
  };
}
