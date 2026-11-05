/** Загружает файл с ограничением размера до сохранения его целиком в памяти. */
export async function downloadFile(url, { maxBytes, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Нужен положительный лимит файла');

  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error('Не удалось скачать файл');
  }
  if (!response.ok || !response.body) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error('Не удалось скачать файл');
  }
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => {});
    throw new Error('Превышен лимит размера файла');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Превышен лимит размера файла');
      chunks.push(Buffer.from(value));
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error('Не удалось скачать файл целиком в пределах лимита');
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
