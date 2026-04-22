# walidator-pomyslu-code - konfiguracja zasobów AWS
# Wartości wypełnione po utworzeniu infrastruktury w kroku 5 kursu Mirka.
# Ten plik jest COMMITTED (same IDki zasobów, nie sekrety).

export AWS_REGION="eu-central-1"
export ACM_REGION="us-east-1"
export BUCKET_PROD="walidator-racicki-prod"
export SUBDOMAIN="walidator.racicki.com"

# Uzupełnione 2026-04-22 (krok 5 MVP):
export API_ENDPOINT="https://e72lqj2skg.execute-api.eu-central-1.amazonaws.com"
export CLOUDFRONT_DISTRIBUTION_ID="E33P4BMTNKPC9S"
export CLOUDFRONT_DOMAIN="d244o2qwmgzzsh.cloudfront.net"
export CLOUDFRONT_OAC_ID="E3PNBGNXNK36I8"
export ACM_CERT_ARN="arn:aws:acm:us-east-1:502761806947:certificate/c9e2324d-675b-4a83-920f-fbe5c8341683"

# ACM DNS validation record (user dodaje w OVH):
#   Nazwa (CNAME):  _7307d3ec689c3782aaac61fe10498e93.walidator
#   Wartość:        _46738bfd9d8dc389fa76fdbf322e14a7.jkddzztszm.acm-validations.aws.
#
# Po ISSUED cert -> scripts/attach-domain.sh podłącza alias walidator.racicki.com
# do CloudFront distribution ID powyżej.
