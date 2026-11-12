import { exactMillisTimestamp } from '../time-precision.mjs';
import { readCurrentTransition } from '../live/index.mjs';

// Один проход без таймера. При каждом проходе перечитываем окно от начала
// пилота: смещение страниц или временный сбой не фиксирует пропущенный курсор.
export async function pollPilotRefusals({ bitrix, queue, enabledAt, maxPages = 100 } = {}) {
  const start = exactMillisTimestamp(enabledAt);
  if (!start || !bitrix?.request || !queue?.enqueue || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new TypeError('Не заданы границы пилота');
  }
  const seen = new Set(); let offset = 0, queued = 0;
  for (let pageNo = 0; pageNo < maxPages; pageNo++) {
    const response = await bitrix.request('crm.deal.list', {
      filter:{CATEGORY_ID:23,STAGE_ID:'C23:LOSE','>=DATE_MODIFY':start.toISOString()},
      select:['ID','STAGE_ID','DATE_MODIFY'],order:{ID:'ASC'},start:offset,
    });
    const items=response?.result;
    if (!Array.isArray(items) || items.length > 50) throw new Error('Неполная страница сделок');
    for (const item of items) {
      const id=String(item?.ID ?? '');
      if (!/^[1-9]\d{0,9}$/.test(id) || Number(id)>2147483647 || item.STAGE_ID!=='C23:LOSE' || seen.has(id)) {
        throw new Error('Некорректная страница сделок');
      }
      seen.add(id);
      const transition=await readCurrentTransition(bitrix,Number(id));
      if (!transition || Date.parse(transition.loseDate)<start.getTime()) continue;
      const result=await queue.enqueue({requestKey:`bitrix24:deal-stage-history:${transition.historyId}`,
        dealId:Number(id),loseDate:transition.loseDate,triggerType:'live',silent:false,screenshots:true});
      if (result.created) queued++;
    }
    if (response.next === undefined || response.next === null || response.next === false) {
      if (response.total != null && (!Number.isSafeInteger(Number(response.total)) || Number(response.total)>offset+items.length)) {
        throw new Error('Не подтверждена полнота списка сделок');
      }
      return {seen:seen.size,queued};
    }
    const next=Number(response.next);
    if (!items.length || !Number.isSafeInteger(next) || next !== offset+items.length) throw new Error('Не подтверждена пагинация');
    offset=next;
  }
  throw new Error('Достигнут предел страниц');
}
