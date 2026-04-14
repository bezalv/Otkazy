import { createClient } from '@supabase/supabase-js';

const EXCLUDED_RESPONSIBLE = '20903'; // Виталий Попов

/**
 * Facts Assembler — собирает детерминированный пакет фактов по сделке.
 * Использует Supabase REST API (supabase-js) — без проблем с SSL/jsonb.
 *
 * Возвращает:
 * {
 *   deal_card: { deal_id, title, opportunity, ... },
 *   metrics:   { comm_analytics fields },
 *   journal_text: string | null,
 *   facts:     [ { id: 'f001', source: 'call_transcript', ... }, ... ]
 * }
 */
export async function assembleFacts(dealId) {
  if (!Number.isInteger(dealId) || dealId <= 0) {
    throw new Error(`Invalid dealId: ${dealId}`);
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );

  // 1. Карточка сделки
  console.log('  [fa] query lost_deals...');
  const { data: deal, error: dealError } = await supabase
    .from('lost_deals')
    .select('*')
    .eq('deal_id', dealId)
    .single();

  if (dealError) throw new Error(`Failed to fetch deal: ${dealError.message}`);
  if (!deal) throw new Error(`Deal ${dealId} not found in lost_deals`);

  // Фильтр: исключённый менеджер
  if (deal.assigned_by_id === EXCLUDED_RESPONSIBLE) {
    throw new Error(`Deal ${dealId} excluded: assigned_by_id=${EXCLUDED_RESPONSIBLE} (excluded responsible)`);
  }

  // 2. Коммуникации
  console.log('  [fa] query communications...');
  const { data: comms, error: commsError } = await supabase
    .from('lost_deal_communications')
    .select('*')
    .eq('deal_id', dealId)
    .order('event_date', { ascending: true });

  if (commsError) throw new Error(`Failed to fetch comms: ${commsError.message}`);

  // 3. deal_card — все поля карточки кроме comm_analytics и journal_text
  const { comm_analytics, journal_text, ...deal_card } = deal;

  // 4. Метрики (comm_analytics jsonb — приходит как объект через REST)
  const metrics = comm_analytics || {};

  // 5. Facts — последовательные ID f001, f002...
  //    Поля source/actor/ts/content — как ожидает промпт Judge
  console.log(`  [fa] got ${comms.length} communications, building packet...`);
  const facts = [];
  let idx = 0;

  for (const c of comms) {
    idx++;
    const fid = 'f' + String(idx).padStart(3, '0');

    switch (c.event_type) {
      case 'call':
        if (c.transcript_status === 'transcribed' && c.transcript_formatted) {
          facts.push({
            id: fid,
            source: 'call_transcript',
            actor: null, // полный диалог, actor внутри content
            ts: c.event_date,
            direction: c.direction,
            duration_s: c.call_duration_seconds,
            replicas: c.transcript_replicas,
            content: c.transcript_formatted,
          });
        } else {
          facts.push({
            id: fid,
            source: 'call_event',
            actor: null,
            ts: c.event_date,
            direction: c.direction,
            duration_s: c.call_duration_seconds,
            has_audio: c.call_has_audio,
            content: `Звонок ${c.direction || '?'}, ${c.call_duration_seconds || 0} сек, транскрипция: ${c.transcript_status || 'нет'}`,
          });
        }
        break;

      case 'comment':
        facts.push({
          id: fid,
          source: 'crm_comment',
          actor: 'manager',
          ts: c.event_date,
          author_id: c.author_id,
          author_name: c.author_name,
          content: c.text_content || c.full_content || '',
          has_files: c.comment_has_files || false,
        });
        break;

      case 'task':
        facts.push({
          id: fid,
          source: 'crm_task',
          actor: 'manager',
          ts: c.event_date,
          content: c.task_title || '',
          task_status: c.task_status,
          closed_date: c.task_closed_date,
          created_by: c.task_created_by,
        });
        break;

      case 'chat':
        facts.push({
          id: fid,
          source: 'chat',
          actor: c.chat_is_system ? 'system' : (c.author_name || 'unknown'),
          ts: c.event_date,
          channel: c.chat_channel,
          content: c.text_content || c.full_content || '',
        });
        break;

      default:
        facts.push({
          id: fid,
          source: c.event_type || 'unknown',
          actor: null,
          ts: c.event_date,
          content: c.text_content || c.full_content || '',
        });
    }
  }

  return {
    deal_card,
    metrics,
    journal_text: journal_text || null,
    facts,
  };
}
