'use strict';
// Только в дочернем тестовом сервисе; реальные сетевые вызовы запрещены.
global.fetch = async url => {
  if (url !== 'https://api.polza.ai/api/v1/audio/transcriptions') throw new Error('external network forbidden');
  return Response.json({ text: 'тестовая реплика' });
};
