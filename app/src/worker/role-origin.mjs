// Вызывается внутри транзакции после блокировки задания с живой арендой.
// ID роли должен принадлежать именно исходному переходу этой сделки.
export async function verifyRoleOrigin(query, { job, dealId, loseDate, stageHistoryId } = {}) {
  if (typeof query !== 'function' || !job || !/^[1-9]\d{0,29}$/.test(String(stageHistoryId ?? ''))
      || !Number.isSafeInteger(Number(dealId)) || Number(dealId) <= 0 || !Number.isFinite(new Date(loseDate).getTime())) return false;
  const stage=String(stageHistoryId), key=job.request_key, trigger=job.trigger_type;
  if (['live','backfill'].includes(trigger)) return key === `bitrix24:deal-stage-history:${stage}`;
  if (!['manual','nightly','audio_wait'].includes(trigger)) return false;
  // Зафиксированный origin всегда имеет преимущество над более поздним
  // аудиоожиданием; другой ID не может переопределить уже принятое решение.
  if (['manual','nightly'].includes(trigger) && job.origin_stage_history_id != null) {
    return job.origin_stage_history_id === stage;
  }
  const origin=await query(`SELECT deal_id FROM public.lost_audio_wait
    WHERE deal_id=$1 AND lose_date=$2::timestamptz AND origin_stage_history_id=$3
      AND state IN ('waiting','done','expired','cancelled')
      AND ($4::text <> 'audio_wait' OR (state='waiting' AND $5::text = 'audio-wait:' || deal_id::text || ':' ||
        (extract(epoch from lose_date) * 1000000)::bigint::text || ':' ||
        (extract(epoch from next_check_at) * 1000000)::bigint::text)) FOR UPDATE`,
    [Number(dealId),loseDate,stage,trigger,key]);
  return origin.rowCount===1 || origin.rows?.length===1;
}
