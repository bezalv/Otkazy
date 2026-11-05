# Корневой сертификат Supabase

`supabase-root-ca-2021.crt` — публичный сертификат, загруженный по адресу из
[исходника интерфейса Supabase](https://github.com/supabase/supabase/blob/ebe8849f8be90d1cfef7b1e84ba52c51e7230c55/apps/studio/hooks/custom-content/custom-content.json)
и сверенный с [копией в репозитории Supabase](https://github.com/supabase/cli-monorepo-sandbox/blob/675a546d7a137e7efe8dc653992b273a4238a216/internal/gen/types/templates/prod-ca-2021.crt).

SHA-256 DER: `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`.
При TLS-проверке должны оставаться включёнными проверка цепочки и имени сервера.
Ротация CA требует повторной сверки с официальными источниками и проверки
подключения; отключать проверку сертификата нельзя.
