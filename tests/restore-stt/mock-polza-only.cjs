'use strict';
// Только в дочернем тестовом сервисе; реальные сетевые вызовы запрещены.
let count = 0;
global.fetch = async url => {
  if (url !== 'https://api.polza.ai/api/v1/audio/transcriptions') throw new Error('external network forbidden');
  count++;
  return Response.json({ text: process.env.OTKAZY_MOCK_EMPTY_EVERY === '2' && count % 2 === 0 ? '' : 'тестовая реплика' });
};
