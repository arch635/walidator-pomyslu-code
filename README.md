# walidator-pomyslu-code

Kod i infra dla `walidator.racicki.com` - walidatora pomysłów biznesowych.

**Dokumentacja projektowa**: `../walidator-pomyslu/` (osobny katalog, nie commitowany
do tego repo). Czytaj w kolejności: `README.md` → `ARCHITECTURE.md` → `AWS-RESOURCES.md`.

## Jak działa

Użytkownik wchodzi na `walidator.racicki.com`, wpisuje pomysł biznesowy w 2-3 zdaniach
i przechodzi przez 25-turową sesję sokratejską z Claude Haiku 4.5 (Bedrock EU).
Po ostatniej turze dostaje raport finalny w 9 sekcjach z werdyktem 🟢/🟡/🟠/🔴.

Cała sesja żyje w DynamoDB (TTL 30 dni), frontend trzyma `session_id` w `localStorage`.
Codziennie o 8:00 (Europe/Warsaw) druga Lambda skanuje DDB i wysyła Arturowi mail
SES z podsumowaniem: ile sesji, jakie werdykty, top red flagi.

Pełna architektura + 3 flowy + mapa kosztów: `../walidator-pomyslu/ARCHITECTURE.md`.

## Szybki deploy

```bash
npm install               # raz, przy pierwszym uruchomieniu
./scripts/deploy.sh       # sls deploy + S3 sync + CloudFront invalidation
```

## Struktura

```
serverless.yml              # Lambda + API Gateway + DDB + SNS + 5 alarmów CW (Serverless v4)
src/handler.js              # kod walidator Lambdy (one-shot + multi-turn + router)
src/daily_report.js         # kod walidatorDailyReport Lambdy (DDB scan + SES)
src/web/                    # frontend do S3 (index.html / styles.css / app.js)
scripts/deploy.sh           # pełny deploy (serverless + S3 + CF invalidation)
infra/config.sh             # IDki zasobów AWS (commitowane, to nie sekrety)
```

## Jak stawiać (runbook dla przyszłego Artura)

Zakładając że konto AWS 502761806947 + IAM user `claude-code-cli` istnieją:

1. **Pre-flight**:
   ```bash
   aws sts get-caller-identity  # musi być claude-code-cli, NIE :root
   node --version               # >= 20
   npx serverless --version     # v4
   ```

2. **Deploy infra + kodu**:
   ```bash
   npm install
   ./scripts/deploy.sh          # tworzy CFN stack + S3 sync + CF invalidation
   ```

3. **Po pierwszym deployu (jednorazowo)**:
   - **SES verify**: kliknij link "AWS Email Address Verification" dla
     `artur@racicki.com` (przyjdzie po pierwszym deploy).
   - **SNS confirm**: kliknij "Confirm subscription" w mailu od
     `alerts-walidator-prod` (topic SNS), żeby alarmy dotarły.
   - **DNS** (OVH panel, NIE Route53):
     - `_<hash>.walidator` CNAME → `_<hash>.acm-validations.aws.` (ACM)
     - `walidator` CNAME → `d244o2qwmgzzsh.cloudfront.net.`
   - **Budget + Cost Anomaly** są zarządzane imperatywnie (istniały pre-stack).
     Komendy w `../walidator-pomyslu/AWS-RESOURCES.md`.

4. **Verify**:
   ```bash
   curl -X POST https://walidator.racicki.com/walidator/turn \
     -H "Content-Type: application/json" \
     -d '{"session_id":null,"message":"chcę zrobić SaaS dla prawników"}'
   ```
   + test w przeglądarce `https://walidator.racicki.com`.

5. **Daily report test** (ręczny invoke, nie czekać na 8:00):
   ```bash
   aws lambda invoke --function-name walidator-pomyslu-prod-walidatorDailyReport \
     --payload '{}' --cli-binary-format raw-in-base64-out /tmp/out.json
   ```

## Wymagania

- Node.js 20+
- AWS CLI v2 skonfigurowane (profil domyślny, user `claude-code-cli`)
- Konto AWS 502761806947

## Status

MVP **zamknięty** (2026-04-22). Sekwencja Mirka 5-9 kompletna.

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
- Krok 10 (finalna mapa + dokumentacja): **done**. Snapshot MVP:
  `ARCHITECTURE.md` (diagram + 3 flowy + mapa kosztów), `AWS-RESOURCES.md`
  (master inventory 26 zasobów), `CHANGELOG.md` (linki do commitów 5-9).
  Koszt realny przy 100 sesjach/mo: ~$6.40 (64% budżetu $10).

**Faza B (poza sekwencją Mirka)**: email-gate przed startem sesji, integracja
MailerLite, export raportu do PDF, auto-shutdown endpointu przy 100% budget,
rate limiting, analytics. Niezależne od MVP.

Więcej w `../walidator-pomyslu/CHANGELOG.md`.
