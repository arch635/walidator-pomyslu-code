# walidator-pomyslu-code

Kod i infra dla `walidator.racicki.com` - walidatora pomysłów biznesowych.

**Dokumentacja projektowa**: `../walidator-pomyslu/` (osobny katalog, nie commitowany
do tego repo). Czytaj w kolejności: `README.md` → `ARCHITECTURE.md` → `AWS-RESOURCES.md`.

## Szybki deploy

```bash
npm install               # raz, przy pierwszym uruchomieniu
./scripts/deploy.sh       # sls deploy + S3 sync + CloudFront invalidation
```

## Struktura

```
serverless.yml              # Lambda + API Gateway (Serverless Framework v4)
src/handler.js              # kod Lambdy
src/web/                    # frontend do S3 (index.html / styles.css / app.js)
scripts/deploy.sh           # pełny deploy (serverless + S3 + CF invalidation)
infra/config.sh             # IDki zasobów AWS (commitowane, to nie sekrety)
```

## Wymagania

- Node.js 20+
- AWS CLI v2 skonfigurowane (profil domyślny, user `claude-code-cli`)
- Konto AWS 502761806947

## Status

- Krok 5 (MVP szkielet): **done**. Placeholder response.
- Krok 5b (domena + HTTPS): **done**. ACM cert, alias CloudFront.
- Krok 5c (UI polish): **done**. Usunięte rozpraszacze z menu i sekcji tech.
- Krok 6 (Bedrock Claude Haiku 4.5, tryb one-shot): **done**. Raport markdown
  z 8 sekcjami, średnio 17s, $0.0166/walidacja.
- Krok 7 (DynamoDB + tryb wieloetapowy + chat UX + prompt caching): **done**.
  25 tur + raport finalny, cache ~82% input, ~$0.08/sesja. Endpoints:
  `POST /walidator/turn`, `GET /walidator/session/{id}`.
- Krok 8 (dzienny raport mailowy SES + EventBridge Scheduler): **done**.
  Lambda `walidatorDailyReport` + Scheduler `walidator-daily-report-prod`
  (cron 8:00 Europe/Warsaw). SES sandbox wystarczy, identity pending aż
  Artur kliknie link weryfikacyjny.
- Krok 9 (budget $10 + Cost Anomaly + SNS + 5 CloudWatch alarmów): **done**.
  Budżet zostaje na $10/mo (Artur potwierdził). SNS topic
  `alerts-walidator-prod`, alarmy: lambda-errors, daily-report-errors,
  lambda-duration-p99, ddb-throttles, daily-report-missed. Flaga
  `ENABLE_AUTO_SHUTDOWN=false` gotowa w env obu Lambd.
- Krok 10 (finalna mapa + diagram ARCHITECTURE.md): todo.

Więcej w `../walidator-pomyslu/CHANGELOG.md`.
