# walidator-pomyslu-code CHANGELOG

## [2026-05-16] - incydent: regresja brandu po deployu PDF+email, naprawa + konsolidacja sources of truth (frontendy → theinnerspace-code)

**Status**: Naprawione. Frontend walidatora wyłącznie w `theinnerspace-code/src/walidator/`.

### Co się stało
Deploy PDF+email z tego repo (`scripts/deploy.sh`) o 13:44 nadpisał TIS-brandowane wersje frontend wgrane bezpośrednio przez @cmo na `s3://space-racicki-prod/walidator/` 15 maja. Regresja: nav "Artur Racicki" + ikona home → racicki.com, footer "© 2026 Artur Racicki · racicki.com", copy "Walidator korzysta z 20 lat doświadczeń biznesowych Artura Racickiego", brak logo SVG TIS, ścieżka CSS/JS bez prefix `/walidator/` (fallback do `/styles.css` root powodował "posypanie" layoutu — strona dziedziczyła style The Inner Space landing page).

### Naprawa
- Restore z S3 versioning: `walidator/index.html` v`e_.iYz1el8JgTWJNRCuqezH_1A2_YlZK` (13:03 16-05, TIS pre-PDF), `walidator/styles.css` v`QvdsG7rs8B6ot7rC_vw2x3qKlMOFh3x9` (13:03)
- Z restore zachowane: TIS nav (logo SVG wordmark), TIS footer ("© 2026 The Inner Space · Operator: Social Kiwi sp. z o.o."), copy bez Racickiego, prawidłowe ścieżki `/walidator/styles.css?v=...` i `/walidator/app.js?v=...`, info-box z notice "Najpierw porozmawiaj z 5 klientami", skala 4 kolorów + "Zielone jest rzadkie", bullet "Bez nazwisk", auth.js + cookie-banner.js
- Z post-PDF deployu zachowane: `app.js` v`UQWZGfkJkzDzjDW49j359UUaUNAUVzJU` (13:44) z funkcjami `/walidator/report/pdf` i `/walidator/report/email` (745 linii vs 604 w pre-PDF)
- Domergowane HTML elementy: `<div id="report-actions">` (Pobierz PDF + Wyślij na mail) i `<div id="report-email-modal">` (email + opt-in checkbox) — wstawione po `<div id="verdict-box">`
- Domergowane CSS: `.report-actions*` + `.report-modal*` (65 linii) doklejone na końcu TIS styles.css
- Wynik: TIS branding kompletny, funkcje PDF+email działają, layout walidatora poprawny

### Konsolidacja (opcja B)
- Frontend walidatora przeniesiony do `theinnerspace-code/src/walidator/` jako jedyne source of truth
- `scripts/deploy.sh` w tym repo: wycofano build+sync frontu (`.build/`, `aws s3 cp` HTML/CSS/JS/SVG), zostawiono tylko `sls deploy` backendu + odczyt API endpoint
- `src/web/DEPRECATED.md` opisuje nowy flow
- Backend (Lambda walidator + report) nieruszony — żyje na `e72lqj2skg...execute-api`

### Test E2E
- `https://theinnerspace.pl/walidator/` HTTP 200, title "Walidator pomysłu - The Inner Space"
- Brak "Artur Racicki" w nav, brak racicki.com w footer
- `/walidator/styles.css` i `/walidator/app.js` ładują się 200 z prawidłowym Content-Type
- CloudFront invalidation `I4NFHPL850CTYNK7YEG6DWWLF2` (EXCHPAVJLQ2AA) completed
