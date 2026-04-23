#!/usr/bin/env bash
# test-banned-terms.sh - test eliminacji halucynacji biograficznej Artura
# Scenariusz: SaaS z wspolnikiem (topic wspolnikow - powinien wyzwolic
# biograficzne skojarzenia u Claude), 5 mini turs.
set -eo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT_DIR"
source infra/config.sh

TURN_URL="${API_ENDPOINT}/walidator/turn"
START_EPOCH_MS=$(( $(date +%s) * 1000 ))
OUT_DIR="$ROOT_DIR/.build/banned-terms-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

# Scenariusz z wspolnikami - powinien naprowadzic Claude'a na LESSON_001/002
# czyli potencjalne fact-check terytorium (firmy Artura).
ANSWERS=(
  "SaaS do zarzadzania zleceniami dla firm budowlanych. Ja i wspolnik - on technical founder part-time, ja sprzedaz full-time. Chce sie zabezpieczyc przed konfliktem."
  "Rozmawialem z 9 wykonawcami. Piotr Malinowski (firma bud-instal): 'Tracimy 10h/tydz na manualne zlecenia'. 5 innych potwierdzilo."
  "Konkurenci: Fieldwire, CoConstruct, Polski 'BuildGo'. Wygramy: integracja z PLN fakturowaniem, polski support, offline mobile."
  "Zmiany: 1) cyfryzacja MSP (dotacja POIR 2023), 2) rosnaca penalty za blad (nowy kodeks pracy 2024), 3) Gen Z brygadziści oczekuja mobile."
  "Ryzyko: wspolnik moze zrezygnowac - jest part-time. Mitygacja: formalna umowa akcjonariuszy z vestingiem 4 lata, cliff 12 miesiecy."
  "Drugie: sprzedaz B2B ciezka - dlugi cykl 6-9 mies. Mitygacja: pilot 30-dniowy za 1 PLN, referral od Piotra (bud-instal)."
  "Trzecie: regulacja moze sie zmienic. Mitygacja: audit prawny co Q."
  "Wygeneruj raport."
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
  echo "  [$TOPICS/5] is_final=$IS_FINAL"
  echo "  OUT: $RESPONSE"

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
echo "▶ Sprawdzam RAPORT KONCOWY pod katem banned terms..."
if [ -f "$OUT_DIR/FINAL.md" ]; then
  for term in "Enzo" "Sport24" "Social WiFi" "FC.APP" "FCAPP"; do
    if grep -q "$term" "$OUT_DIR/FINAL.md"; then
      echo "  ✖ ZNALEZIONO '$term' w raporcie"
    else
      echo "  ✓ '$term' nie wystepuje"
    fi
  done
  echo ""
  if grep -q "racicki.com" "$OUT_DIR/FINAL.md"; then
    echo "  ✓ Link racicki.com obecny w raporcie"
  else
    echo "  ✖ BRAK linka racicki.com w raporcie"
  fi
  echo ""
  for cyt in "Zły dobór wspólników" "wyłączności wspólników" "trupów kosztuje"; do
    if grep -q "$cyt" "$OUT_DIR/FINAL.md"; then
      echo "  ✓ Cytat LESSON: '$cyt' obecny"
    fi
  done
fi

echo ""
echo "▶ Czekam 20s na propagacje logow..."
sleep 20

echo ""
echo "▶ CloudWatch: banned_terms_detected per tura (session=$SESSION_ID)"
aws logs filter-log-events \
  --log-group-name "/aws/lambda/walidator-pomyslu-prod-walidator" \
  --start-time "$START_EPOCH_MS" \
  --filter-pattern "{\$.event = \"turn_ok\" && \$.session_id = \"$SESSION_ID\"}" \
  --output json 2>/dev/null | \
  jq -r '.events[] | .message | split("\t") | .[-1] | fromjson | "tura=\(.assistant_turn) banned_detected=\(.banned_terms_detected) matched=\(.banned_terms_matched)"' | \
  tee "$OUT_DIR/banned-per-turn.txt"

TOTAL_BANNED=$(cat "$OUT_DIR/banned-per-turn.txt" | grep -oE "banned_detected=[0-9]+" | cut -d= -f2 | awk '{s+=$1} END {print s+0}')
echo ""
echo "=== SUMMARY ==="
echo "Banned terms laczne (cel: 0): $TOTAL_BANNED"
if [ "$TOTAL_BANNED" = "0" ]; then
  echo "  ✓ Zero halucynacji biograficznych"
else
  echo "  ⚠ Halucynacje wykryte - sprawdz banned-per-turn.txt dla szczegolow"
fi
