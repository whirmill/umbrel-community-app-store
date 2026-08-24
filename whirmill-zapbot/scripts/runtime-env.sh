#!/bin/sh
# Load one service's private settings without allowing transferred configuration
# to replace the immutable image revision or Compose-assigned database identity.
set -eu

requested_role="${ZAPBOT_DATABASE_ROLE:-runtime}"
baked_revision="${ZAPBOT_BUILD_GIT_COMMIT_SHA:-}"

if [ -f /service-env/config.env ]; then
  set -a
  # shellcheck source=/dev/null
  . /service-env/config.env
  set +a
fi

test "${#baked_revision}" -eq 40 || {
  echo "image is missing an immutable 40-character Git revision" >&2
  exit 65
}
case "$baked_revision" in
  *[!0-9a-f]*) echo "image Git revision is not lowercase hexadecimal" >&2; exit 65 ;;
esac

export ZAPBOT_DATABASE_ROLE="$requested_role"
unset RAILWAY_GIT_COMMIT_SHA SOURCE_VERSION RELEASE_SYS_CONFIG
export ZAPBOT_BUILD_GIT_COMMIT_SHA="$baked_revision"
export GIT_COMMIT_SHA="$baked_revision"
export ZAPBOT_START_DELIBERATION_RUNTIME=false
export ZAPBOT_START_INTERNAL_CONSUMERS=false
export ZAPBOT_START_MARKET_STREAM=false

# No long-lived service may inherit release-administrator or cross-role database
# credentials from a transferred config file.
for name in $(env | cut -d= -f1); do
  case "$name" in
    PGPASSWORD|POSTGRES_PASSWORD|PROD_DATABASE_URL|PROD_DB_URL|DATABASE_PUBLIC_URL|DATABASE_PRIVATE_URL|MIGRATION_*|ADMIN_*|EVALUATOR_*|ZAPBOT_PRODUCER_*|RAILWAY_*) unset "$name" ;;
  esac
done

case "$requested_role" in
  runtime) db_login=zapbot_runtime ;;
  producer_lnmarkets_candles) db_login=zapbot_producer_lnmarkets_candles ;;
  producer_coinbase_candles) db_login=zapbot_producer_coinbase_candles ;;
  producer_lnmarkets_funding) db_login=zapbot_producer_lnmarkets_funding ;;
  producer_lnmarkets_execution_economics) db_login=zapbot_producer_lnmarkets_execution_economics ;;
  producer_risk_authority_snapshot) db_login=zapbot_producer_risk_authority_snapshot ;;
  evaluator_attestor) db_login=zapbot_evaluator_attestor ;;
  holdout_report_writer) db_login=zapbot_holdout_report_writer ;;
  holdout_v2_sealer) db_login=zapbot_holdout_v2_sealer ;;
  *) echo "unsupported ZapBot database role" >&2; exit 64 ;;
esac

test -s /run/zapbot-db-secret/password || {
  echo "missing service database credential" >&2
  exit 66
}
db_password=$(cat /run/zapbot-db-secret/password)
export DATABASE_URL="postgresql://${db_login}:${db_password}@whirmill-zapbot-postgres:5432/zapbot"
export DATABASE_SSL=true
export DATABASE_SSL_VERIFY=verify_peer
export DATABASE_SSL_CACERTFILE=/run/zapbot-db-tls/ca.crt

if [ "$requested_role" = runtime ]; then
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
else
  # Producer admission is intentionally narrower than the web runtime. Remove
  # every credential family not needed for its dedicated TLS database login.
  for name in $(env | cut -d= -f1); do
    case "$name" in
      DATABASE_URL|DATABASE_SSL|DATABASE_SSL_VERIFY|DATABASE_SSL_CACERTFILE) ;;
      APP_URL|PUBLIC_APP_URL|DASHBOARD_ORIGIN|PHX_HOST|PASSKEY_RP_ID|RELEASE_COOKIE|LNM_*|AGENT_*|SCHEDULER_*|*TOKEN*|*SECRET*|*PASSWORD*|*PASSPHRASE*|*API_KEY*|*WEBHOOK*|*CREDENTIAL*|*PRIVATE_KEY*|*DSN*|*ACCESS*|*SIGNING*|*HMAC*|*COOKIE*|*_URL) unset "$name" ;;
    esac
  done
fi
