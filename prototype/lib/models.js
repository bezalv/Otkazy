export const JUDGE_MODEL  = 'anthropic/claude-opus-4.6';
export const WRITER_MODEL = 'anthropic/claude-opus-4.6';

// Temperature для Opus можно 0 — он и так достаточно разнообразен
// на сложных задачах.
export const JUDGE_TEMPERATURE  = 0;
export const WRITER_TEMPERATURE = 0.2;

// Токены: Opus любит писать подробнее, увеличим лимиты
export const JUDGE_MAX_TOKENS  = 4000;
export const WRITER_MAX_TOKENS = 2500;
