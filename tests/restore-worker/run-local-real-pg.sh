#!/usr/bin/env bash
set -Eeuo pipefail

# Бинарники предоставляются вызывающим. Никаких установок и загрузок.
for name in OTKAZY_LOCAL_PG_BIN OTKAZY_LOCAL_PG_CLIENT_BIN OTKAZY_LOCAL_PG_SHARE OTKAZY_LOCAL_PG_LIB OTKAZY_LOCAL_PG_NODE; do
  value=${!name:-}
  if [[ "$value" != /* || ! -e "$value" ]]; then
    printf '%s: задайте существующий абсолютный путь\n' "$name" >&2
    exit 1
  fi
  printf -v "$name" '%s' "$(realpath -e -- "$value")"
done
pgbin=$OTKAZY_LOCAL_PG_BIN
clientbin=$OTKAZY_LOCAL_PG_CLIENT_BIN
share=$OTKAZY_LOCAL_PG_SHARE
lib=$OTKAZY_LOCAL_PG_LIB
nodebin=$OTKAZY_LOCAL_PG_NODE
project=$(realpath -e -- "$(dirname -- "${BASH_SOURCE[0]}")/../..")
for path in "$pgbin/initdb" "$pgbin/pg_ctl" "$pgbin/postgres" "$clientbin/createdb" "$nodebin"; do
  if [[ ! -x "$path" ]]; then printf 'Нет исполняемого файла: %s\n' "$path" >&2; exit 1; fi
done
if [[ ! -f "$share/postgres.bki" || ! -d "$lib" ]]; then
  printf 'Не найдены файлы инициализации или каталог библиотек\n' >&2
  exit 1
fi
if [[ "$(env -i PATH=/usr/bin:/bin "$nodebin" -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  printf 'Для теста требуется Node.js 24\n' >&2
  exit 1
fi

test_root=$(mktemp -d /tmp/otkazy-local-pg-XXXXXXXX)
safe_root() {
  [[ "$test_root" =~ ^/tmp/otkazy-local-pg-[A-Za-z0-9]{8}$ ]] \
    && [[ -d "$test_root" && ! -L "$test_root" ]] \
    && [[ "$(realpath -e -- "$test_root")" == "$test_root" ]]
}
if ! safe_root; then printf 'Неожиданный временный путь; запуск отменён\n' >&2; exit 1; fi
run_clean() { env -i HOME="$test_root" LANG=C PATH=/usr/bin:/bin LD_LIBRARY_PATH="$lib" "$@"; }
cleanup() {
  local rc=$?
  trap - EXIT
  if ! safe_root; then
    printf 'Временный путь изменился; остановка и удаление отменены\n' >&2
    exit 1
  fi
  if [[ -e "$test_root/data/postmaster.pid" ]]; then
    if ! run_clean "$pgbin/pg_ctl" -D "$test_root/data" -m fast -w stop; then
      printf 'Не удалось остановить тестовый PostgreSQL; каталог сохранён: %s\n' "$test_root" >&2
      exit 1
    fi
  fi
  if ! safe_root; then printf 'Временный путь изменился; удаление отменено\n' >&2; exit 1; fi
  rm -rf --one-file-system -- "$test_root"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_clean "$pgbin/initdb" -D "$test_root/data" -L "$share" \
  --username=otkazytest --auth-host=trust --auth-local=trust --no-locale --encoding=UTF8 >/dev/null
run_clean "$pgbin/pg_ctl" -D "$test_root/data" -l "$test_root/server.log" \
  -o "-c listen_addresses='' -p 56471 -k $test_root -c unix_socket_permissions=0700 -c shared_buffers=16MB -c max_connections=12" -w start
run_clean "$clientbin/createdb" -h "$test_root" -p 56471 -U otkazytest -T template0 otkazytest
cd "$project"
case "${OTKAZY_LOCAL_PG_SUITE:-role}" in
  role) test_file=tests/restore-worker/author-inference-real-pg.test.mjs ;;
  prejudge) test_file=tests/restore-worker/prejudge-real-pg.test.mjs ;;
  manual-schema) test_file=tests/restore-worker/manual-staging-schema-real-pg.test.mjs ;;
  manual-prejudge) test_file=tests/restore-worker/manual-prejudge-real-pg.test.mjs ;;
  *) printf 'Неизвестный тестовый набор\n' >&2; exit 1 ;;
esac
env -i PATH=/usr/bin:/bin HOME="$test_root" LD_LIBRARY_PATH="$lib" \
  OTKAZY_LOCAL_PG_TEST=1 OTKAZY_LOCAL_PG_SOCKET="$test_root" OTKAZY_LOCAL_PG_PORT=56471 \
  "$nodebin" --test --test-reporter=spec "$test_file"
