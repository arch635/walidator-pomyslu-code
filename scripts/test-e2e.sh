#!/usr/bin/env bash
# test-e2e.sh - smoke test walidatora po deployu
# 1. Test mini: pełny scenariusz Artura (maszyna vendingowa)
# 2. Test unikania: celowe ogólniki → sprawdź sygnalizację vague
# 3. Test pełny: pierwszych ~5 tur + sprawdzenie licznika
# 4. Test feedback endpoint
#
# Wywołanie:  ./scripts/test-e2e.sh
# Zakłada: deploy.sh został wykonany (API_ENDPOINT w infra/config.sh)

# Bez -u: bash 3.2 (macOS) ma bug z "${ARRAY[$i]}" pod set -u.
set -eo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT_DIR"
# shellcheck disable=SC1091
source infra/config.sh

if [ -z "${API_ENDPOINT:-}" ]; then
  echo "✖ Brak API_ENDPOINT w infra/config.sh"; exit 1
fi

TURN_URL="${API_ENDPOINT}/walidator/turn"
FEEDBACK_URL="${API_ENDPOINT}/walidator/feedback"
SESSION_URL="${API_ENDPOINT}/walidator/session"

OUT_DIR="$ROOT_DIR/.build/e2e-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"
echo "Output dir: $OUT_DIR"

# ============================================================
# TEST 1: MINI - scenariusz Artura (konkretne odpowiedzi)
# ============================================================
echo ""
echo "=========================================="
echo "TEST 1: MINI - scenariusz vendingowy (5 tematów, konkretne odpowiedzi)"
echo "=========================================="

MINI_ANSWERS=(
  "Maszyna vendingowa z żywnością funkcjonalną dla biur w Warszawie i Krakowie. Przekąski z witaminami, proteinami, ziołami adaptogennymi. Klient to firma 50-500 osób z biurem w centrum."
  "Rozmawiałem z 12 osobami w ostatnich 3 miesiącach. Anna Kowalska (HR Manager w Getin Banku) powiedziała: 'Pracownicy narzekają że nie ma zdrowych opcji poza słodyczami i chipsami'. Jeszcze 5 HR managerów potwierdziło podobny feedback."
  "Konkurenci: Healthy Box (gotowe boxy, $15/miesiąc), Pure Food Vending (maszyny ale tylko napoje), Fresh & Co (catering biurowy). My wygramy: 1) maszyna = niższy koszt operacyjny niż catering; 2) kuratorzy dietetyka; 3) unikalne SKU (adaptogeny)."
  "Zmiany ostatnich 12-24 miesięcy: 1) post-COVID wzrost świadomości zdrowia (46% więcej wyszukiwań 'supergreens' w Google Trends Poland 2024); 2) regulacja UE 2023/915 o składnikach funkcjonalnych znosi bariery; 3) Gen Z w biurach (2024) oczekuje zdrowej oferty."
  "Największe ryzyko: logistyka refilli i psucie się produktów z krótkim terminem przydatności. Bez sprawnej flotowej logistyki z 2-dniową rotacją - straty marży. Plan mitygacji: partner z firmą Fresh Logistics (kontakt potwierdzony z Tomkiem Wójcikiem)."
)

SESSION_ID=""
for i in "${!MINI_ANSWERS[@]}"; do
  TURN_NUM=$((i + 1))
  ANSWER="${MINI_ANSWERS[$i]}"
  echo ""
  echo "--- Tura $TURN_NUM ---"
  echo "User: ${ANSWER:0:80}..."

  if [ -z "$SESSION_ID" ]; then
    BODY=$(jq -n --arg m "$ANSWER" '{message: $m, mode: "mini"}')
  else
    BODY=$(jq -n --arg m "$ANSWER" --arg s "$SESSION_ID" '{message: $m, session_id: $s}')
  fi

  RESP=$(curl -s -X POST "$TURN_URL" \
    -H "Content-Type: application/json" \
    -H "Origin: https://walidator.racicki.com" \
    -d "$BODY")
  echo "$RESP" > "$OUT_DIR/mini-turn-$TURN_NUM.json"

  SESSION_ID=$(echo "$RESP" | jq -r '.session_id')
  TOPICS=$(echo "$RESP" | jq -r '.topics_covered | join(",") // empty')
  CURRENT=$(echo "$RESP" | jq -r '.current_topic // "(brak)"')
  IS_FINAL=$(echo "$RESP" | jq -r '.is_final')
  VAGUE=$(echo "$RESP" | jq -r '.vague_count // 0')
  echo "  Response (clean): $(echo "$RESP" | jq -r '.response' | head -3)"
  echo "  topics_covered: [$TOPICS]"
  echo "  current_topic: $CURRENT"
  echo "  is_final: $IS_FINAL, vague: $VAGUE"

  if [ "$IS_FINAL" = "true" ]; then
    echo "  → RAPORT WYGENEROWANY po turze $TURN_NUM"
    echo "$RESP" | jq -r '.response' > "$OUT_DIR/mini-FINAL.md"
    break
  fi
done

MINI_SESSION="$SESSION_ID"
echo ""
echo "Test 1 koniec. Session: $MINI_SESSION"

# ============================================================
# TEST 2: MINI - celowe unikanie (sygnalizacja "Dlaczego wynik mógł być lepszy")
# ============================================================
echo ""
echo "=========================================="
echo "TEST 2: MINI unikanie - celowe ogólniki (≥2 vague → sekcja 'Dlaczego wynik mógł być lepszy')"
echo "=========================================="

VAGUE_ANSWERS=(
  "Aplikacja dla firm która ułatwia codzienną pracę."
  "Rozmawiałem z paroma osobami. Mówili że to fajne."
  "Jest trochę konkurencji, ale my będziemy lepsi."
  "Wiele rzeczy się zmieniło w ostatnich latach."
  "Nie wiem jakie ryzyko. Chyba egzekucja."
)

SESSION_ID=""
for i in "${!VAGUE_ANSWERS[@]}"; do
  TURN_NUM=$((i + 1))
  ANSWER="${VAGUE_ANSWERS[$i]}"
  echo ""
  echo "--- Tura $TURN_NUM (vague) ---"
  echo "User: $ANSWER"

  if [ -z "$SESSION_ID" ]; then
    BODY=$(jq -n --arg m "$ANSWER" '{message: $m, mode: "mini"}')
  else
    BODY=$(jq -n --arg m "$ANSWER" --arg s "$SESSION_ID" '{message: $m, session_id: $s}')
  fi

  RESP=$(curl -s -X POST "$TURN_URL" \
    -H "Content-Type: application/json" \
    -H "Origin: https://walidator.racicki.com" \
    -d "$BODY")
  echo "$RESP" > "$OUT_DIR/vague-turn-$TURN_NUM.json"

  SESSION_ID=$(echo "$RESP" | jq -r '.session_id')
  TOPICS=$(echo "$RESP" | jq -r '.topics_covered | join(",") // empty')
  CURRENT=$(echo "$RESP" | jq -r '.current_topic // "(brak)"')
  IS_FINAL=$(echo "$RESP" | jq -r '.is_final')
  VAGUE=$(echo "$RESP" | jq -r '.vague_count // 0')
  echo "  Response (clean): $(echo "$RESP" | jq -r '.response' | head -3)"
  echo "  topics_covered: [$TOPICS]"
  echo "  current_topic: $CURRENT"
  echo "  is_final: $IS_FINAL, vague: $VAGUE"

  if [ "$IS_FINAL" = "true" ]; then
    echo "  → RAPORT WYGENEROWANY po turze $TURN_NUM"
    echo "$RESP" | jq -r '.response' > "$OUT_DIR/vague-FINAL.md"
    if grep -q "Dlaczego wynik mógł być lepszy" "$OUT_DIR/vague-FINAL.md"; then
      echo "  ✓ Sekcja 'Dlaczego wynik mógł być lepszy' ZNALEZIONA"
    else
      echo "  ✖ BRAK sekcji 'Dlaczego wynik mógł być lepszy'"
    fi
    break
  fi
done

VAGUE_SESSION="$SESSION_ID"
echo "Test 2 koniec. Session: $VAGUE_SESSION"

# ============================================================
# TEST 3: FEEDBACK endpoint
# ============================================================
echo ""
echo "=========================================="
echo "TEST 3: POST /walidator/feedback"
echo "=========================================="

FB_BODY=$(jq -n \
  --arg s "$MINI_SESSION" \
  '{session_id: $s, rating: 5, valuable: "Konkretne wymagania co do konkurencji.", missing: "Więcej o runway.", action: "Zrobię 20 rozmów z HR w maju."}')

FB_RESP=$(curl -s -X POST "$FEEDBACK_URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://walidator.racicki.com" \
  -d "$FB_BODY")
echo "$FB_RESP" > "$OUT_DIR/feedback-resp.json"
echo "Feedback response:"
echo "$FB_RESP" | jq .
FB_STATUS=$(echo "$FB_RESP" | jq -r '.status')
if [ "$FB_STATUS" = "ok" ]; then
  echo "  ✓ Feedback zapisany"
else
  echo "  ✖ Feedback failed"
fi

# Próba ponowna - powinna zwrócić 409
echo ""
echo "Test 3b: re-submit feedback (oczekuje 409)"
FB_RESP2=$(curl -s -X POST "$FEEDBACK_URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://walidator.racicki.com" \
  -d "$FB_BODY")
echo "$FB_RESP2" | jq .

echo ""
echo "=========================================="
echo "WSZYSTKIE TESTY ZAKOŃCZONE"
echo "=========================================="
echo "Artefakty: $OUT_DIR"
echo "  - mini-turn-*.json - per-tura response (mini scenariusz)"
echo "  - mini-FINAL.md - raport mini (z konkretami)"
echo "  - vague-turn-*.json - per-tura response (unikanie)"
echo "  - vague-FINAL.md - raport mini (z sygnalizacją)"
echo "  - feedback-resp.json - odpowiedź na feedback submit"
