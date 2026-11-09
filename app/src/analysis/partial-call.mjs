import { detectNoConversation, hasMachineMarker, hasObservedClientContent } from './no-conversation.mjs';

// Доступные слова и неизвестные фрагменты оцениваются отдельно: найденный
// автоответчик не доказывает, что за пределами расшифровки не было человека.
function splitObserved(text, manager = false) {
  const human = [], machine = [], ambiguous = [], nonMachineInOrder = [];
  let notClient = false;
  for (const part of String(text || '').split(/(?<=[.!?])\s+/u).map(s => s.trim()).filter(Boolean)) {
    const detected = manager ? detectNoConversation('',part,0,false) : detectNoConversation(part,'',0,false);
    if (detected?.reason === 'machine') { machine.push(part); continue; }
    if (!manager && detected?.reason === 'not_client') { ambiguous.push(part); nonMachineInOrder.push(part); notClient = true; continue; }
    // Если робот и осмысленные слова слиплись, бережём текст как неизвестного
    // говорящего: приписывать системные слова клиенту нельзя.
    if (hasMachineMarker(part, manager)) {
      ambiguous.push(part); nonMachineInOrder.push(part); continue;
    }
    human.push(part); nonMachineInOrder.push(part);
  }
  // Один канал может содержать нескольких людей. Признак чужого собеседника
  // не позволяет назначить остальные его реплики клиенту без подтверждения.
  if (notClient) { human.length = 0; ambiguous.splice(0, ambiguous.length, ...nonMachineInOrder); }
  return {human, machine, ambiguous};
}

export function partialCallObservations(call, mono = false) {
  const client = splitObserved(call.transcript_client_text);
  const manager = splitObserved(call.transcript_manager_text, true);
  if (mono) return {status:'unknown',client,manager};
  const clientText=client.human.join(' ');
  // Одних слов менеджера недостаточно для подтверждения контакта.
  const observed = hasObservedClientContent(clientText);
  return {status:observed ? 'observed_client' : 'unknown',client,manager};
}
