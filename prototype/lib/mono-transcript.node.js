// === МОНО-ЗАПИСЬ ЗВОНКА ===
// Источник с пояснениями: prototype/lib/mono-transcript.js. Править ТАМ, здесь — сборка.
// Тот же блок продублирован в нодах «Собрать итог», agent-facts-assembler, b4.5 Comm Analytics.
// Зачем: моно-проход (channel_count=1, speaker_role='Говорящий') отдаёт одну дорожку речи
// без разделения сторон, и подворкфлоу кладёт её целиком в manager_text. Сборщик делал из
// неё факт actor=manager, и судья цитировал клиента как менеджера. Таких звонков в базе 362.
var MONO_SPEAKER_RE = /(^|\n)[ \t]*Говорящий[ \t]*:/;
var MONO_SPEAKER_STRIP_RE = /(^|\n)[ \t]*Говорящий[ \t]*:[ \t]*/g;
function monoByText(text) { return MONO_SPEAKER_RE.test(String(text || '')); }
function detectTranscriptMode(result) {
  if (!result) return null;
  var mode = result._transcript_mode || result.transcript_mode || null;
  if (mode === 'mono' || mode === 'stereo') return mode;
  if (result.channel_count === 1) return 'mono';
  if (result.channel_count === 2 && !monoByText(result.formatted_dialog)) return 'stereo';
  return monoByText(result.formatted_dialog) ? 'mono' : 'stereo';
}
function isMonoTranscript(comm) {
  if (!comm) return false;
  if (comm._transcript_mode === 'mono') return true;
  if (comm._transcript_mode === 'stereo') return false;
  return monoByText(comm.transcript) || monoByText(comm.transcript_manager_text) || monoByText(comm.transcript_client_text);
}
function stripMonoPrefix(text) {
  return String(text || '').replace(MONO_SPEAKER_STRIP_RE, '$1').replace(/[ \t]+\n/g, '\n').trim();
}
function monoWholeText(comm) {
  var c = comm || {};
  var parts = [];
  var mgr = stripMonoPrefix(c.transcript_manager_text);
  var cli = stripMonoPrefix(c.transcript_client_text);
  if (mgr) parts.push(mgr);
  if (cli) parts.push(cli);
  if (!parts.length) { var whole = stripMonoPrefix(c.transcript); if (whole) parts.push(whole); }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
function monoFactContent(comm) {
  var text = monoWholeText(comm);
  if (!text) return '';
  return 'Запись без разделения сторон (одна звуковая дорожка, кто именно говорит — неизвестно): ' + text;
}
// === КОНЕЦ БЛОКА МОНО-ЗАПИСИ ===
