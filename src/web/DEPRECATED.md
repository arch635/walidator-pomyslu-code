# DEPRECATED 2026-05-16

Frontend walidatora **nie jest już** deployowany z tego katalogu.

**Source of truth (od 2026-05-16):**
`/Users/aracicki/AI-Biznes/projekty/autofirma/theinnerspace-code/src/walidator/`

**Powód:** @cmo edytował bezpośrednio S3 (`space-racicki-prod/walidator/`), kod żył w 2 miejscach jednocześnie. Po incydencie 2026-05-16 (deploy z tego repo nadpisał TIS-brandowane wersje wgrane przez @cmo, regresja brandu) skonsolidowane do `theinnerspace-code` jako jedyne źródło.

**Co zostało w tym repo:**
- backend (Lambda + Bedrock + API GW) - `src/handler.js`, `serverless.yml`
- prompty - `src/prompts/`
- testy

**Co zniknęło z tego repo (od 2026-05-16):**
- sync frontu w `scripts/deploy.sh` (krok build/.build + aws s3 cp)

**Deploy frontu:**
```bash
cd ../../theinnerspace-code && ./deploy.sh
```

Pliki w tym katalogu (`index.html`, `styles.css`, `app.js`, `stars.svg`) są zachowane jako referencja historyczna. Do usunięcia po pierwszym czystym deployu z `theinnerspace-code` (planowo: 2026-05-23).
