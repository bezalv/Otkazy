# Проверка аудиосервиса

`node --test tests/restore-stt/run.cjs tests/restore-stt/child.test.mjs` выполняет
локальные проверки протокола и процесса без внешних запросов.

Дополнительный `real-audio.test.mjs` генерирует синтетическую тишину и тон,
использует реальные `ffmpeg`/`ffprobe` и локальную заглушку Polza. Он запускается
только при наличии тестовых бинарников в `tmp/fftools`; без них помечается skipped.
Подготовка с корня репозитория:

```powershell
npm install --prefix tmp/fftools ffmpeg-static@5.3.0 @derhuerst/ffprobe-static@5.3.0
node --test tests/restore-stt/real-audio.test.mjs
```

Пакеты скачивают бинарники с GitHub при установке. Тест не отправляет аудио в
Polza и не подтверждает качество распознавания речи или работоспособность Linux
бинарников в галактике.
