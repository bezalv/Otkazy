// Доверие действует только для конкретного неизменённого объекта в этом процессе.
// JSON и произвольное копирование его не переносят.
const trusted = new WeakMap();
function snapshot(value) {
  try { return JSON.stringify(value); } catch { return null; }
}
export function trustNeutralReaction(event) {
  const state = snapshot(event);
  if (state !== null) trusted.set(event, state);
  return event;
}
export function isTrustedNeutralReaction(event) {
  const expected = event && trusted.get(event);
  return typeof expected === 'string' && snapshot(event) === expected;
}
export function copyNeutralReactionTrust(source, target) {
  if (isTrustedNeutralReaction(source) && snapshot(target) === snapshot(source)) trustNeutralReaction(target);
  return target;
}
