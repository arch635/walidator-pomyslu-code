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

- Krok 5 (MVP szkielet): **done**. Placeholder response, bez AI.
- Krok 6 (Bedrock): todo.

Więcej w `../walidator-pomyslu/CHANGELOG.md`.
