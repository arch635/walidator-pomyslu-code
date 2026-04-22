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

# Prompt źródłowy żyje w docs (../walidator-pomyslu/), kopiujemy do src/prompts/
# żeby Lambda miała go w swoim bundle. Tylko tu jest single source of truth.
PROMPT_SRC="${ROOT_DIR}/../walidator-pomyslu/walidator-v2-prompt.md"
PROMPT_DST="${ROOT_DIR}/src/prompts/walidator-v2.md"
echo "▶ Synchronizuję prompt v2.0 z docs -> src/prompts/..."
if [ ! -f "$PROMPT_SRC" ]; then
  echo "   ✖ STOP: nie znajduję $PROMPT_SRC"; exit 1
fi
mkdir -p "${ROOT_DIR}/src/prompts"
cp "$PROMPT_SRC" "$PROMPT_DST"
echo "   ✓ $(wc -l < "$PROMPT_DST") linii"

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

echo "▶ Build frontu (.build/)..."
rm -rf .build
mkdir -p .build
cp src/web/index.html .build/index.html
cp src/web/styles.css .build/styles.css
sed "s|__API_ENDPOINT__|${API_ENDPOINT}|g" src/web/app.js > .build/app.js

if [ -z "${BUCKET_PROD:-}" ]; then
  echo "   ⚠ BUCKET_PROD nie ustawiony - pomijam sync S3."
  exit 0
fi

echo "▶ Sync do s3://${BUCKET_PROD}..."
aws s3 sync .build/ "s3://${BUCKET_PROD}" --delete \
  --exclude "*.DS_Store"

aws s3 cp .build/index.html "s3://${BUCKET_PROD}/index.html" \
  --content-type "text/html; charset=utf-8" \
  --metadata-directive REPLACE --no-progress > /dev/null
aws s3 cp .build/styles.css "s3://${BUCKET_PROD}/styles.css" \
  --content-type "text/css; charset=utf-8" \
  --metadata-directive REPLACE --no-progress > /dev/null
aws s3 cp .build/app.js "s3://${BUCKET_PROD}/app.js" \
  --content-type "application/javascript; charset=utf-8" \
  --metadata-directive REPLACE --no-progress > /dev/null
echo "   ✓ Sync OK"

if [ -n "${CLOUDFRONT_DISTRIBUTION_ID:-}" ]; then
  echo "▶ Inwalidacja CloudFront ${CLOUDFRONT_DISTRIBUTION_ID}..."
  INVAL_ID=$(aws cloudfront create-invalidation \
    --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
    --paths "/*" \
    --query "Invalidation.Id" --output text)
  echo "   ✓ Invalidation: $INVAL_ID"
fi

if [ -n "${CLOUDFRONT_DOMAIN:-}" ]; then
  echo "▶ Test /  (${CLOUDFRONT_DOMAIN})..."
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${CLOUDFRONT_DOMAIN}/")
  echo "   / → ${CODE}"
fi

echo ""
echo "✓ Deploy OK"
echo "   API:        ${API_ENDPOINT}"
[ -n "${CLOUDFRONT_DOMAIN:-}" ] && echo "   Frontend:   https://${CLOUDFRONT_DOMAIN}/"
[ -n "${SUBDOMAIN:-}" ]         && echo "   Docelowo:   https://${SUBDOMAIN}/ (po wpięciu DNS)"
