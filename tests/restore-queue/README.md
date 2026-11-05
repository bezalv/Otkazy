# Проверки очереди

`node --test tests/restore-queue/run.mjs` запускает быстрые моки.

Для проверки SQL в отдельной PostgreSQL-базе в памяти установить тестовую
зависимость в игнорируемый каталог и запустить:

```powershell
npm install --prefix tmp/pgtest --no-save --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.5.15
node --test tests/restore-queue/postgres.test.mjs
```

PGlite выполняет SQL в PostgreSQL WebAssembly и не подключается к Supabase.
Этот тест проверяет схему, ограничения и последовательные переходы статусов.
Для конкурентного захвата несколькими независимыми соединениями необходим
дополнительный тест на отдельном сервере PostgreSQL.
