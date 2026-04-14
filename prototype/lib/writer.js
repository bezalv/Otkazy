import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WRITER_MODEL, WRITER_TEMPERATURE, WRITER_MAX_TOKENS } from './models.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Writer — генерирует комментарий для Bitrix24.
 * Вызывается ТОЛЬКО если verdict="неправомерен".
 *
 * Принимает facts-пакет + вердикт judge.
 * Возвращает { text, model, usage }.
 */
export async function runWriter(factsPacket, judgeResult) {
  const systemPrompt = readFileSync(join(__dirname, '..', 'prompts', 'writer_v1.md'), 'utf8');

  const userPayload = {
    deal_card: factsPacket.deal_card,
    metrics:   factsPacket.metrics,
    facts:     factsPacket.facts,
    judge:     judgeResult,
  };

  const body = {
    model: WRITER_MODEL,
    max_tokens: WRITER_MAX_TOKENS,
    temperature: WRITER_TEMPERATURE,
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
  return {
    text:  data.choices?.[0]?.message?.content || '',
    model: data.model || null,
    usage: data.usage || null,
  };
}
