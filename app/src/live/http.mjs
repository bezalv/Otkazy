import { LiveAuthError, LiveInputError } from './index.mjs';

// Адаптер не создаёт сервер и не открывает маршрут самостоятельно.
export function createLiveHttpHandler({ inbox, maxBytes = 64 * 1024, bodyTimeoutMs = 10000 }) {
  if (!inbox || typeof inbox.acceptForm !== 'function') throw new TypeError('Не задан приёмник событий');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024
      || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 100 || bodyTimeoutMs > 60000) throw new TypeError('Некорректные ограничения запроса');
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let absoluteDeadline;
    const finish = status => {
      if (absoluteDeadline) clearTimeout(absoluteDeadline);
      if (res.headersSent || res.destroyed) return;
      if (status === 413 || status === 408) res.setHeader('Connection', 'close');
      res.writeHead(status);
      res.end();
    };
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); finish(405); req.resume(); return; }
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/x-www-form-urlencoded') { finish(415); req.resume(); return; }
    const declared = req.headers['content-length'];
    if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) { finish(413); req.resume(); return; }
    let size = 0, stopped = false;
    const chunks = [];
    req.setTimeout(bodyTimeoutMs, () => { stopped = true; finish(408); req.resume(); });
    // setTimeout у запроса считает только бездействие: абсолютная граница
    // не даст удерживать соединение отправкой одного байта за интервал.
    absoluteDeadline = setTimeout(() => { stopped = true; finish(408); req.resume(); }, bodyTimeoutMs);
    absoluteDeadline.unref?.();
    req.on('data', chunk => {
      if (stopped) return;
      size += chunk.length;
      if (size > maxBytes) { stopped = true; chunks.length = 0; finish(413); req.resume(); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { stopped = true; finish(400); });
    req.on('aborted', () => { stopped = true; });
    req.on('end', async () => {
      if (stopped) return;
      stopped = true;
      req.setTimeout(0);
      clearTimeout(absoluteDeadline);
      try {
        const result = await inbox.acceptForm(Buffer.concat(chunks, size));
        if (!result || !['accepted', 'ignored'].includes(result.status)) { finish(503); return; }
        finish(204);
      } catch (error) {
        finish(error instanceof LiveInputError ? 400 : error instanceof LiveAuthError ? 403 : 503);
      }
    });
  };
}
