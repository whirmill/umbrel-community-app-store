#!/bin/sh
# Source optional private settings only in a service process, then force only
# the database identity and transport. Existing transferred feature settings
# keep their values; absent settings retain the conservative default.
set -eu

if [ -f /service-env/config.env ]; then
  set -a
  # shellcheck source=/dev/null
  . /service-env/config.env
  set +a
fi

case "${ZAPBOT_DATABASE_ROLE:-runtime}" in
  runtime) db_login=zapbot_runtime ;;
  producer_lnmarkets_candles) db_login=zapbot_producer_lnmarkets_candles ;;
  producer_coinbase_candles) db_login=zapbot_producer_coinbase_candles ;;
  producer_lnmarkets_funding) db_login=zapbot_producer_lnmarkets_funding ;;
  producer_lnmarkets_execution_economics) db_login=zapbot_producer_lnmarkets_execution_economics ;;
  *) echo "unsupported ZapBot database role" >&2; exit 64 ;;
esac

test -s /run/zapbot-db-secret/password || { echo "missing service database credential" >&2; exit 66; }
db_password=$(cat /run/zapbot-db-secret/password)
export DATABASE_URL="postgresql://${db_login}:${db_password}@whirmill-zapbot-postgres:5432/zapbot"
export DATABASE_SSL=true
export DATABASE_SSL_VERIFY=verify_peer
export DATABASE_SSL_CACERTFILE=/run/zapbot-db-tls/ca.crt
export SECRET_KEY_BASE="${SECRET_KEY_BASE:-$(cat /run/zapbot-db-secret/secret-key-base)}"
export SIGNING_SALT="${SIGNING_SALT:-$(cat /run/zapbot-db-secret/signing-salt)}"
export AUTH_TOKEN_SALT="${AUTH_TOKEN_SALT:-$(cat /run/zapbot-db-secret/auth-token-salt)}"
export APP_URL="${APP_URL:-http://whirmill-zapbot-web:4000}"
export PUBLIC_APP_URL="${PUBLIC_APP_URL:-$APP_URL}"
export DASHBOARD_ORIGIN="${DASHBOARD_ORIGIN:-$APP_URL}"
export PORT="${PORT:-4000}"
export PHX_SERVER="${PHX_SERVER:-true}"
export ZAPBOT_RUNTIME_MODE="${ZAPBOT_RUNTIME_MODE:-production}"
export CLEAN_SLATE_COMPARISON_ENABLED="${CLEAN_SLATE_COMPARISON_ENABLED:-false}"
export CLEAN_SLATE_LIVE_DRY_RUN_ENABLED="${CLEAN_SLATE_LIVE_DRY_RUN_ENABLED:-false}"
export DELIBERATION_BIAS_TREND_TIEBREAK_ENABLED="${DELIBERATION_BIAS_TREND_TIEBREAK_ENABLED:-false}"
export DELIBERATION_TIMEFRAME_ENTRY_BEHAVIOR_ENABLED="${DELIBERATION_TIMEFRAME_ENTRY_BEHAVIOR_ENABLED:-false}"
export RESEARCH_COINBASE_FORWARD_INGEST_ENABLED="${RESEARCH_COINBASE_FORWARD_INGEST_ENABLED:-false}"
export RESEARCH_FORWARD_HOLDOUT_CAPTURE_ENABLED="${RESEARCH_FORWARD_HOLDOUT_CAPTURE_ENABLED:-false}"
