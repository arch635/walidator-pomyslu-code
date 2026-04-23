#!/usr/bin/env bash
# test-suggestions.sh - test 3-warstwowego zakazu sugerowania
# 10 tur mini z pomyslem "platforma dla prawnikow"
# Po testach - odpytuje CloudWatch Logs i liczy suggestions_cleaned per turę
set -eo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT_DIR"
source infra/config.sh

TURN_URL="${API_ENDPOINT}/walidator/turn"
START_EPOCH_MS=$(( $(date +%s) * 1000 ))
OUT_DIR="$ROOT_DIR/.build/suggestions-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

ANSWERS=(
  "platforma dla prawników"
  "Prawnicy z kancelarii 5-20 osób w Polsce. Dokumenty trzymają w SharePoint, szukanie precedensów zajmuje godziny."
  "Rozmawiałem z 7 prawnikami. Marcin Kowalski (partner w DLA Piper) powiedział: 'Godzinę dziennie tracę na szukanie klauzul w starych umowach'."
  "Konkurenci: Lexlegis, Wolters Kluwer LEX, LegalTech Hub. Wygramy szybkością indeksacji i integracją z polskim KRS/KRRiT."
  "Zmiany: 1) regulacja AI Act 2024 wymaga audytu, 2) wzrost liczby startupów o 40%, 3) Gen Z prawnicy oczekują narzędzi jak Notion."
  "Ryzyko: prawnicy konserwatywni, zmiana workflow wymaga 6-12 mies. Mitygacja: pilot bez zmiany obecnego setupu, tylko warstwa AI na top."
  "Drugie ryzyko: compliance z tajemnicą adwokacką - dane nie mogą iść do US. Mitygacja: AWS eu-central-1 + audyt ABI."
  "Trzecie: sprzedaż B2B do konserwatywnego rynku - długi cykl 3-6 msc. Mitygacja: pilot 30-dniowy za 1 PLN i referencje od Marcina (DLA Piper)."
  "To już wszystko co mam. Proszę o raport."
  "Raport proszę."
)

SESSION_ID=""
MAX_LOOP=12
for ((i=0; i<MAX_LOOP; i++)); do
  TURN_NUM=$((i + 1))
  if [ $i -lt ${#ANSWERS[@]} ]; then
    ANSWER="${ANSWERS[i]}"
  else
    ANSWER="Raport."
  fi
  echo ""
  echo "--- Tura $TURN_NUM ---"
  echo "User: ${ANSWER:0:70}..."

  if [ -z "$SESSION_ID" ]; then
    BODY=$(jq -n --arg m "$ANSWER" '{message: $m, mode: "mini"}')
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
  IS_FINAL=$(echo "$RESP" | jq -r '.is_final')
  RESPONSE=$(echo "$RESP" | jq -r '.response' | head -c 200)
  echo "  [$TOPICS/5 tematów] is_final=$IS_FINAL"
  echo "  Response (po clean): $RESPONSE"

  if [ "$IS_FINAL" = "true" ]; then
    echo "  → Raport po turze $TURN_NUM"
    echo "$RESP" | jq -r '.response' > "$OUT_DIR/FINAL.md"
    break
  fi
done

echo ""
echo "=========================================="
echo "Session: $SESSION_ID"
echo "Output: $OUT_DIR"
echo "=========================================="
echo ""
echo "▶ Czekam 30s na propagację logów do CloudWatch..."
sleep 30

echo "▶ CloudWatch Logs: suggestions_cleaned per tura (session=$SESSION_ID)..."
aws logs filter-log-events \
  --log-group-name "/aws/lambda/walidator-pomyslu-prod-walidator" \
  --start-time "$START_EPOCH_MS" \
  --filter-pattern "{\$.event = \"turn_ok\" && \$.session_id = \"$SESSION_ID\"}" \
  --output json 2>/dev/null | \
  jq -r '.events[] | .message | split("\t") | .[-1] | fromjson | "tura=\(.assistant_turn) topics=\(.topics_covered_count)/\(.topics_total) suggestions_cleaned=\(.suggestions_cleaned)"' | \
  tee "$OUT_DIR/cleaned-per-turn.txt"

echo ""
echo "=== SUMMARY ==="
TOTAL_CLEANED=$(cat "$OUT_DIR/cleaned-per-turn.txt" | grep -oE "suggestions_cleaned=[0-9]+" | cut -d= -f2 | awk '{s+=$1} END {print s}')
TOTAL_TURNS=$(cat "$OUT_DIR/cleaned-per-turn.txt" | wc -l | tr -d ' ')
VIOLATIONS=$(cat "$OUT_DIR/cleaned-per-turn.txt" | grep -cE "suggestions_cleaned=[1-9]" || true)
echo "Tury analizowane: $TOTAL_TURNS"
echo "Tury ze złamaniem (suggestions_cleaned > 0): $VIOLATIONS"
echo "Łączna liczba usuniętych sugestii: $TOTAL_CLEANED"
if [ $TOTAL_TURNS -gt 0 ]; then
  PCT=$(awk -v v=$VIOLATIONS -v t=$TOTAL_TURNS 'BEGIN { printf "%.0f", v*100/t }')
  echo "Procent tur ze złamaniem: ${PCT}% (cel: <5%)"
fi
