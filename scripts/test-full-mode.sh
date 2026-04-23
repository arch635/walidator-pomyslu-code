#!/usr/bin/env bash
# test-full-mode.sh - E2E test pelnego walidatora (25 tematow).
# Scenariusz: SaaS dla kancelarii prawnych, odpowiedzi konkretne zeby
# Claude nie petlal follow-upow. MAX_LOOP=32 = 25 tematow + bufor follow-up.
set -eo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT_DIR"
source infra/config.sh

TURN_URL="${API_ENDPOINT}/walidator/turn"
START_EPOCH_MS=$(( $(date +%s) * 1000 ))
OUT_DIR="$ROOT_DIR/.build/full-mode-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

ANSWERS=(
  # idea_description, idea_uniqueness
  "SaaS dla kancelarii prawnych 5-30 osób w Polsce. Indeksacja i wyszukiwanie precedensów z własnej bazy dokumentów + orzecznictwa KRS/KRRiT. AI przeszukuje w sekundach to co prawnik szukał godzinami."
  "Unikalność: integracja z polskim systemem prawnym (KRS, KRRiT, DzU, Lex) + offline search dla dokumentów chronionych tajemnicą adwokacką. Konkurenci robią tylko cloud z US-hostingiem."
  # problem_description, problem_cost, problem_conversations, problem_quote, problem_alternatives
  "Problem realny: partner DLA Piper Marcin Kowalski, 12.03.2026 - spędził 4h szukając klauzuli o force majeure w 300 umowach z archiwum SharePoint. Klient (Allegro) czekał."
  "Koszt problemu: prawnik partner 800-1500 PLN/h. 4h = 3200-6000 PLN jednej szukanki. Kancelaria 20 osób ma 15-20 takich tygodniowo = 60-120k PLN/msc straconego czasu."
  "Rozmawiałem z 18 prawnikami z 12 kancelarii w ostatnich 3 miesiącach. Wszyscy potwierdzili problem. 14 z nich pokazało swoje obecne workarounds."
  "Cytat Marcin Kowalski (DLA Piper, 12.03.2026): 'Nasz SharePoint ma 40TB dokumentów. Google search w nim jest bezużyteczny bo nie rozumie kontekstu prawnego. Szukanie to 25% czasu juniorów.'"
  "Alternatywy: 1) ręczny Ctrl+F po folderach, 2) Lexis-Nexis Legal subskrypcja 2000 USD/msc/user, 3) asystent-junior do szukania, 4) Notion z tagowaniem manualnym."
  # customer_icp, customer_location, customer_attempts, customer_paying, customer_pipeline
  "ICP: Kinga Nowak, managing partner kancelarii 'Nowak&Partnerzy' w Warszawie, 22 prawników, specjalizacja M&A. Wiek 41, Warszawa, 3 córki. Orientację biznesową > technologia."
  "Gdzie znajdę: 1) Polish Legal Tech Summit (październik 2026, 400 managing partnerów), 2) grupa LinkedIn 'Polscy Prawnicy Korporacyjni' (2800 członków), 3) Izba Adwokacka w W-wa - lista top 100 kancelarii."
  "Jedna kancelaria spróbowała zbudować własne AI wewnątrz (Kancelaria Dentons PL), ale budżet 500k zł zjadł 6 miesięcy i nie zadziałało. Poddali się w marcu 2026."
  "Płacacy early adopter: Tomasz Różniak, partner 'Różniak & Wspólnicy', obiecał 500 PLN/user/msc za pilot 3 miesięczny dla 8 użytkowników. List intentowy z 18.04.2026."
  "Pipeline: 7 kancelarii gotowych na demo (rozmawiały ze mną, zadeklarowali budżet). 3 z nich (DLA Piper, Sołtysiński, Różniak) obiecali zacząć pilot w Q3 2026 jeśli produkt gotowy."
  # competition_list, competition_advantage, market_size, market_timing
  "Konkurenci: 1) Lexis-Nexis Legal AI (US, 2000 USD/user, brak PL orzecznictwa), 2) Harvey.ai (US, enterprise only), 3) LegalTech Hub PL (tagging manualny), 4) Wolters Kluwer LEX (cloud-only, tylko przepisy), 5) ROSS Intelligence (zamknięty 2020)."
  "Przewaga: a) PL orzecznictwo integrowane natywnie (brak u konkurencji), b) offline/on-prem dla compliance adwokackiej, c) 3-5x taniej od Lexis (500 vs 2000 USD), d) polski support."
  "TAM Polska: 42000 prawników × 1200 PLN/msc potencjał = 600 mln PLN rocznie. SAM: 8000 prawników korporacyjnych w kancelariach 5+ osób = 115 mln PLN. SOM 3 lata: 300 userów (3,6 mln PLN rocznie)."
  "Dlaczego teraz: 1) AI Act 2024 wymaga audytu - push do AI rozwiązań, 2) Wzrost wartości kancelarii 40% 2020-2024 (KIR raport), 3) Post-COVID remote work wymaga digital-first, 4) Haiku/Sonnet 4.5/4.6 taniej (ChatGPT API <$0.001)."
  # revenue_model, cac_ltv, current_spending, runway
  "Model: subskrypcja 500 PLN/user/msc (tier standard) + 1000 PLN/user/msc (premium z offline). Bilingowanie roczne. Setup fee 5k PLN per kancelaria."
  "CAC liczony: 1 managing partner meeting 500 PLN (2h × 250) × 8 meetingów żeby zamknąć = 4000 PLN/customer kancelaria. LTV: 15 userów × 500 × 36 msc = 270k PLN. LTV/CAC = 67:1."
  "Kancelarie wydają obecnie: Lexis-Nexis 2000 USD/user = 8000 PLN (dla 12 userów) = 96k PLN/rocznie. Plus junior 3000 PLN/user dodatkowe szukanie. Nasze 500 PLN/user to 0.5 co obecnie."
  "Runway: 420k PLN oszczędności + 300k dotacja Horyzont Europa 2025 wniosek pending. Start Q3 2026, 18 miesięcy do $1M ARR według modelu."
  # team_composition, team_experience, sales_owner
  "Team: Ja (CEO, 8 lat legal-tech w EU), Piotr Krzemieński (CTO, 15 lat ML/NLP, ex-SAP Warszawa), Kinga Nowak (Chief Legal, były partner Dentons PL, weryfikuje product-market fit). Wszyscy full-time od 1.09.2026."
  "Doświadczenie: sprzedaliśmy LegalGPT startup w 2023 (exit za 2M EUR do Clifford Chance). Przeszedłem 3 lata sprzedaży B2B do top-15 kancelarii UK. Piotr zbudował 2 AI produkty wcześniej."
  "Sprzedaż od dnia 1: ja osobiście prowadzę 5 outreach calli tygodniowo + mam umówione demo z 7 kancelariami. Marcin Kowalski (DLA Piper) rekomenduje mnie 2 innym partnerom co tydzień."
  # biggest_risk, first_10_customers
  "Największe ryzyko: compliance/security. Kancelarie nie dadzą dokumentów jeśli nie ma on-prem lub PL datacenter. Mitygacja: architektura od dnia 1 na AWS eu-central-1 + ISO 27001 cert w miesiąc 6."
  "Pierwszych 10: już mam LOI od 3 (Różniak, DLA Piper, Sołtysiński). Pozostałych 7 z pipeline - wymagają demo + pilot 30-dniowy. Plan: 5 pilotów Q4 2026, 3 konwersje, plus 5 z networku Kingi w Q1 2027."
  "Raport proszę."
)

SESSION_ID=""
MAX_LOOP=35
for ((i=0; i<MAX_LOOP; i++)); do
  TURN_NUM=$((i + 1))
  if [ $i -lt ${#ANSWERS[@]} ]; then
    ANSWER="${ANSWERS[i]}"
  else
    ANSWER="Konkretów juz nie mam. Raport."
  fi
  echo ""
  echo "--- T$TURN_NUM ---"
  echo "U: ${ANSWER:0:60}..."

  if [ -z "$SESSION_ID" ]; then
    BODY=$(jq -n --arg m "$ANSWER" '{message: $m, mode: "full"}')
  else
    BODY=$(jq -n --arg m "$ANSWER" --arg s "$SESSION_ID" '{message: $m, session_id: $s}')
  fi

  RESP=$(curl -s -X POST "$TURN_URL" \
    -H "Content-Type: application/json" \
    -H "Origin: https://walidator.racicki.com" \
    -d "$BODY")
  echo "$RESP" > "$OUT_DIR/turn-$TURN_NUM.json"

  SESSION_ID=$(echo "$RESP" | jq -r '.session_id')
  TOPICS=$(echo "$RESP" | jq -r '.topics_covered | length // 0')
  CURRENT=$(echo "$RESP" | jq -r '.current_topic // "(brak)"')
  IS_FINAL=$(echo "$RESP" | jq -r '.is_final')
  WERDYKT=$(echo "$RESP" | jq -r '.werdykt // "(null)"')
  echo "  topics=$TOPICS/25 current=$CURRENT is_final=$IS_FINAL werdykt=$WERDYKT"

  if [ "$IS_FINAL" = "true" ]; then
    echo "$RESP" | jq -r '.response' > "$OUT_DIR/FINAL.md"
    break
  fi
done

echo ""
echo "=========================================="
echo "Session: $SESSION_ID | Output: $OUT_DIR"
echo "=========================================="

echo ""
echo "▶ DDB dump sesji..."
aws dynamodb get-item --table-name walidator-sessions-prod \
  --key "{\"session_id\":{\"S\":\"$SESSION_ID\"}}" \
  --output json | jq '.Item | {is_final: .is_final.BOOL, werdykt: .werdykt_koncowy.S, topics_count: (.topics_covered.L | length), topics: (.topics_covered.L | map(.S))}' | tee "$OUT_DIR/ddb-dump.json"

echo ""
echo "▶ Sprawdzenie raportu..."
if [ -f "$OUT_DIR/FINAL.md" ]; then
  if grep -qE "(🟢|🟡|🟠|🔴)\s*(ZIELONE|ŻÓŁTE|POMARAŃCZOWE|CZERWONE)" "$OUT_DIR/FINAL.md"; then
    echo "  ✓ Werdykt parsowalny w raporcie"
  else
    echo "  ✖ Werdykt NIEparsowalny"
  fi
  WERDYKT_LINE=$(grep -E "(🟢|🟡|🟠|🔴)" "$OUT_DIR/FINAL.md" | head -1)
  echo "  Werdykt: $WERDYKT_LINE"
  REPORT_LINES=$(wc -l < "$OUT_DIR/FINAL.md")
  echo "  Raport: $REPORT_LINES linii"
fi

echo ""
echo "▶ Czekam 25s na propagację logów..."
sleep 25

echo ""
echo "▶ CloudWatch: safety net metrics per tura"
aws logs filter-log-events \
  --log-group-name "/aws/lambda/walidator-pomyslu-prod-walidator" \
  --start-time "$START_EPOCH_MS" \
  --filter-pattern "{\$.event = \"turn_ok\" && \$.session_id = \"$SESSION_ID\"}" \
  --output json 2>/dev/null | \
  jq -r '.events[] | .message | split("\t") | .[-1] | fromjson | "T\(.assistant_turn) topics=\(.topics_covered_count)/\(.topics_total) is_final=\(.is_final) backend_forced=\(.backend_forced_final // false) topics_fb=\(.topics_fallback_used // false) verdict_missing=\(.verdict_missing // false) max_turns=\(.max_turns_reached // false)"' | \
  tee "$OUT_DIR/metrics.txt"

echo ""
echo "=== SUMMARY ==="
TOTAL_TOPICS_FB=$(cat "$OUT_DIR/metrics.txt" | grep -cE "topics_fb=true" || true)
TOTAL_VERDICT_MISSING=$(cat "$OUT_DIR/metrics.txt" | grep -cE "verdict_missing=true" || true)
TOTAL_MAX_TURNS=$(cat "$OUT_DIR/metrics.txt" | grep -cE "max_turns=true" || true)
TOTAL_BACKEND_FORCED=$(cat "$OUT_DIR/metrics.txt" | grep -cE "backend_forced=true" || true)
echo "topics_fallback_used: $TOTAL_TOPICS_FB"
echo "verdict_missing: $TOTAL_VERDICT_MISSING"
echo "max_turns_reached: $TOTAL_MAX_TURNS"
echo "backend_forced_final: $TOTAL_BACKEND_FORCED"
