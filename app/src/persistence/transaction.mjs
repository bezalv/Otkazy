export class CommitOutcomeUnknownError extends Error {
  constructor() {
    super('Неизвестно, была ли завершена транзакция. Автоматический повтор запрещён.');
    this.name = 'CommitOutcomeUnknownError';
    this.code = 'COMMIT_OUTCOME_UNKNOWN';
  }
}

/** Выполняет сохранение на одной выделенной сессии из пула PostgreSQL. */
export async function inTransaction(pool, action) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('Нужен пул PostgreSQL');
  const connection = await pool.connect();
  let committing = false;
  let discard = false;
  try {
    await connection.query('BEGIN');
    const result = await action(connection);
    committing = true;
    await connection.query('COMMIT');
    committing = false;
    return result;
  } catch (error) {
    if (committing) {
      discard = true;
      throw new CommitOutcomeUnknownError();
    }
    try {
      await connection.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    // pg удаляет соединение из пула, если передать ошибку в release().
    connection.release(discard ? new Error('Состояние сессии неизвестно') : undefined);
  }
}
