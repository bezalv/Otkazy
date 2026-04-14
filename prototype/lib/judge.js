import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { JUDGE_MODEL, JUDGE_TEMPERATURE, JUDGE_MAX_TOKENS } from './models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Judge — вызывает LLM для вынесения вердикта по сделке.
 *
 * Принимает facts-пакет (deal_card, metrics, facts).
 * Возвращает { parsed, raw, parseMethod, model, usage }.
 */
export async function runJudge(factsPacket) {
  const systemPrompt = readFileSync(join(__dirname, '..', 'prompts', 'judge_v1.md'), 'utf8');

  const userPayload = {
    deal_card: factsPacket.deal_card,
    metrics:   factsPacket.metrics,
    facts:     factsPacket.facts,
  };

  const body = {
    model: JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    temperature: JUDGE_TEMPERATURE,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: JSON.stringify(userPayload, null, 2) },
    ],
  };

  const resp = await fetch(process.env.POLZA_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.POLZA_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Polza API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const raw = data.choices?.[0]?.message?.content || '';

  const result = parseJudgeResponse(raw);
  result.model = data.model || null;
  result.usage = data.usage || null;
  return result;
}

/**
 * Парсинг ответа Judge: JSON.parse → regex fallback → raw.
 */
function parseJudgeResponse(raw) {
  // 1. Прямой JSON.parse
  try {
    return { parsed: JSON.parse(raw), raw, parseMethod: 'direct' };
  } catch (_) { /* fallback */ }

  // 2. Regex: первый { до последнего }
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return { parsed: JSON.parse(match[0]), raw, parseMethod: 'regex' };
    } catch (_) { /* fallback */ }
  }

  // 3. Не распарсилось — вернуть raw
  return { parsed: null, raw, parseMethod: 'failed' };
}
