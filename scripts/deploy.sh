#!/usr/bin/env bash
# deploy.sh - pełny deploy walidator.racicki.com
# 1. Serverless deploy (Lambda + API Gateway v2 HTTP API) w eu-central-1
# 2. Build frontu z wstrzykniętym API_ENDPOINT
# 3. Sync do S3
# 4. Invalidation CloudFront (jeśli skonfigurowany)
#
# Wywołanie:  ./scripts/deploy.sh
# Wymagane:   AWS CLI v2, Node 20+, npx serverless v4

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ROOT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
cd "$ROOT_DIR"
# shellcheck disable=SC1091
source infra/config.sh

echo "▶ Pre-flight..."
CALLER=$(aws sts get-caller-identity --query Arn --output text)
echo "   Identity: $CALLER"
if echo "$CALLER" | grep -q ":root"; then
  echo "   ✖ STOP: root"; exit 1
fi
echo "   ✓ OK"

STAGE="${STAGE:-prod}"
STACK_NAME="walidator-pomyslu-${STAGE}"

# Prompty źródłowe żyją w docs (../walidator-pomyslu/), kopiujemy do src/prompts/
# żeby Lambda miała je w swoim bundle. Single source of truth = docs.
PROMPT_FULL_SRC="${ROOT_DIR}/../walidator-pomyslu/walidator-v2-prompt.md"
PROMPT_FULL_DST="${ROOT_DIR}/src/prompts/walidator-v2.md"
PROMPT_MINI_SRC="${ROOT_DIR}/../walidator-pomyslu/walidator-mini-prompt.md"
PROMPT_MINI_DST="${ROOT_DIR}/src/prompts/walidator-mini.md"

echo "▶ Synchronizuję prompty (full v2 + mini) z docs -> src/prompts/..."
mkdir -p "${ROOT_DIR}/src/prompts"
for pair in "$PROMPT_FULL_SRC|$PROMPT_FULL_DST" "$PROMPT_MINI_SRC|$PROMPT_MINI_DST"; do
  src="${pair%%|*}"
  dst="${pair##*|}"
  if [ ! -f "$src" ]; then
    echo "   ✖ STOP: nie znajduję $src"; exit 1
  fi
  cp "$src" "$dst"
  echo "   ✓ $(basename "$dst"): $(wc -l < "$dst") linii"
done

echo "▶ Serverless deploy (stage=${STAGE}, region=${AWS_REGION})..."
npx serverless deploy --stage "$STAGE" --region "$AWS_REGION"

echo "▶ Odczyt API endpoint z CloudFormation stack..."
API_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='HttpApiEndpoint'].OutputValue" \
  --output text)
echo "   API: $API_ENDPOINT"

if [ -z "$API_ENDPOINT" ] || [ "$API_ENDPOINT" = "None" ]; then
  echo "   ✖ STOP: brak API_ENDPOINT w outputach stacka"; exit 1
fi

# --- 2026-05-16: Frontend NIE jest już deployowany z tego repo. ---
# Single source of truth dla frontu walidatora:
#   /Users/aracicki/AI-Biznes/projekty/autofirma/theinnerspace-code/src/walidator/
# Deploy frontu:
#   cd ../../theinnerspace-code && ./deploy.sh
# Powód: kursowi @cmo edytowali bezpośrednio S3, kod żył w 2 miejscach (drift).
# Po incydencie 2026-05-16 (regresja brandu) skonsolidowane do theinnerspace-code.
# src/web/ w tym repo jest DEPRECATED (do usunięcia po stabilizacji).

echo ""
echo "✓ Deploy backend OK"
echo "   API:        ${API_ENDPOINT}"
echo ""
echo "ℹ Frontend deployujesz osobno z theinnerspace-code:"
echo "   cd ../../theinnerspace-code && ./deploy.sh"
