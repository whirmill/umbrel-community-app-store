#!/bin/sh
# Run only after reviewing a 0.1.69 rollback. This is a compatibility rollback:
# it will retain schema 235, existing protected evidence, and the isolated
# account-reconciliation snapshot contract without downgrading the database or
# changing persisted authority settings. It requires the fenced 0.1.69 package
# graph to have completed first; the pinned schema-235 image must match the
# qualified immutable source revision.
# it never initializes credentials
# or starts bootstrap dependencies.
set -eu

package_version=0.1.69
legacy_image='ghcr.io/whirmill/zapbot:umbrel-h4-policy-admission-m1c-b78caf4f292b1de6e7bccf0582616e37a5b928e1@sha256:35afe57a35f8ded8e8618ff6e6b7cabc7e17ca6c1867efd5125fdf78a222a68e'
current_image='ghcr.io/whirmill/zapbot:umbrel-h4-account-b3b332923c95e260ea7931ab9797f181ccd24f8f@sha256:afb38843ab48c24e406670bb12ac78fb22542cab87afa58e2731f8915cdb091b'
# current_image is the reviewed schema-235 multi-architecture identity.
# The schema verifier below remains bound to that same source-contract revision.

: "${APP_DATA_DIR:?APP_DATA_DIR is required}"
: "${ZAPBOT_PACKAGE_COMPOSE:?ZAPBOT_PACKAGE_COMPOSE must name the installed docker-compose.yml}"

case "$APP_DATA_DIR" in /*) ;; *) echo 'APP_DATA_DIR must be absolute' >&2; exit 64 ;; esac
case "$ZAPBOT_PACKAGE_COMPOSE" in /*) ;; *) echo 'ZAPBOT_PACKAGE_COMPOSE must be absolute' >&2; exit 64 ;; esac

package_dir=$(CDPATH= cd -- "$(dirname -- "$ZAPBOT_PACKAGE_COMPOSE")" && pwd)
rollback_compose="$package_dir/docker-compose.rollback-0.1.46.yml"
version_file="$APP_DATA_DIR/scripts/.package-version"
compose_validation_override=$(mktemp "${TMPDIR:-/tmp}/zapbot-rollback-compose.XXXXXX")
trap 'rm -f "$compose_validation_override"' EXIT HUP INT TERM

# Umbrel injects app_proxy when it starts the package. The standalone rollback
# targets no proxy service, but Compose still validates every declared service.
# Supply only a transient image declaration so the installed base compose can be
# parsed without starting or changing app_proxy.
cat > "$compose_validation_override" <<'YAML'
services:
  app_proxy:
    image: alpine:3.22
YAML

test -f "$ZAPBOT_PACKAGE_COMPOSE"
test -f "$rollback_compose"
test "$(cat "$version_file" 2>/dev/null || true)" = "$package_version" || {
  echo "ZapBot rollback requires installed package scripts $package_version" >&2
  exit 65
}

# Inspect the exact bind as root: a host user unable to traverse a
# mode-0700 state directory must never mistake an enabled marker for absence.
# --mount refuses a missing source; the isolated check starts no application.
docker run --rm --network none --read-only --user 0:0 \
  --mount "type=bind,src=$APP_DATA_DIR/data/state,dst=/state,readonly" \
  --entrypoint /bin/sh "$current_image" -ec '
    test -d /state && test -r /state && test -x /state || {
      echo "rollback state directory is not accessible" >&2
      exit 66
    }
    for marker in app-enabled producer-lnmarkets-candles-enabled producer-coinbase-candles-enabled producer-lnmarkets-funding-enabled producer-risk-authority-snapshot-enabled; do
      test ! -e "/state/$marker" || {
        echo "refusing compatibility rollback while $marker is enabled" >&2
        exit 66
      }
    done
  '

compose() {
  # Define the unused interpolation as empty so Compose does not request a
  # seed. If a future change accidentally starts credential-init, its own
  # minimum-length guard fails rather than deriving replacement credentials.
  APP_SEED= APP_VERSION="$package_version" docker compose \
    -f "$ZAPBOT_PACKAGE_COMPOSE" \
    -f "$rollback_compose" \
    -f "$compose_validation_override" "$@"
}

verify_schema() {
  verifier_script=$(cat <<'SH'
export PGPASSWORD="$(cat /run/zapbot-secret/password)"
psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d zapbot <<'SQL'
BEGIN READ ONLY;
SELECT CASE WHEN
  (SELECT count(*) FROM public.schema_migrations) = 235
  AND (SELECT max(version) FROM public.schema_migrations) = 20260920100000
  AND (SELECT index_meta.indisvalid FROM pg_catalog.pg_index index_meta WHERE index_meta.indexrelid = $$public.causal_events_trusted_v2_series_latest_idx$$::regclass)
  AND pg_catalog.pg_get_indexdef($$public.causal_events_trusted_v2_series_latest_idx$$::regclass) = $idx$CREATE INDEX causal_events_trusted_v2_series_latest_idx ON public.causal_events USING btree (source, stream_id, account_scope, market_key, split_part((source_event_id)::text, ':revision:'::text, 1), ledger_seq DESC)$idx$
  AND (SELECT index_meta.indisvalid FROM pg_catalog.pg_index index_meta WHERE index_meta.indexrelid = $$public.causal_events_passive_execution_trade_lookup_idx$$::regclass)
  AND pg_catalog.pg_get_indexdef($$public.causal_events_passive_execution_trade_lookup_idx$$::regclass) = $idx$CREATE INDEX causal_events_passive_execution_trade_lookup_idx ON public.causal_events USING btree (source, kind, account_scope, market_key, ((payload ->> 'provider_trade_id'::text)), ledger_seq)$idx$
  AND pg_catalog.strpos(pg_catalog.regexp_replace(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure($$public.append_trusted_v2_causal_event(text,text,text,timestamp without time zone,timestamp without time zone,text,jsonb)$$)), $$[[:space:]]+$$, $$ $$, $$g$$), $predicate$AND pg_catalog.split_part( event.source_event_id, ':revision:', 1 ) = p_source_event_id$predicate$) > 0
  AND pg_catalog.strpos(pg_catalog.regexp_replace(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure($$public.append_trusted_v2_causal_event(text,text,text,timestamp without time zone,timestamp without time zone,text,jsonb)$$)), $$[[:space:]]+$$, $$ $$, $$g$$), $legacy$AND ( event.source_event_id = p_source_event_id OR pg_catalog.left( event.source_event_id, pg_catalog.length(p_source_event_id || ':revision:') ) = p_source_event_id || ':revision:' )$legacy$) = 0
  AND (SELECT proc.prosecdef FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.append_trusted_v2_causal_event(text,text,text,timestamp without time zone,timestamp without time zone,text,jsonb)$$))
  AND (SELECT proc.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$, $$lock_timeout=1s$$] FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.append_trusted_v2_causal_event(text,text,text,timestamp without time zone,timestamp without time zone,text,jsonb)$$))
  AND (SELECT pg_catalog.pg_get_userbyid(proc.proowner) = $$zapbot_owner$$ FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.append_trusted_v2_causal_event(text,text,text,timestamp without time zone,timestamp without time zone,text,jsonb)$$))
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc proc
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(proc.proacl, pg_catalog.acldefault($$f$$, proc.proowner))
    ) acl
    WHERE proc.oid = pg_catalog.to_regprocedure($$public.append_trusted_v2_causal_event(text,text,text,timestamp without time zone,timestamp without time zone,text,jsonb)$$)
      AND acl.grantee = 0
      AND acl.privilege_type = $$EXECUTE$$
  )
  AND to_regclass($$public.lnmarkets_account_scope_bindings$$) IS NOT NULL
  AND to_regclass($$public.lnmarkets_account_identity_observations$$) IS NOT NULL
  AND to_regprocedure($$public.record_lnmarkets_account_identity_observation(text,text,text,text,timestamp with time zone)$$) IS NOT NULL
  AND to_regprocedure($$public.lnmarkets_account_identity_status(text)$$) IS NOT NULL
  AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ($$lnmarkets_account_scope_bindings_immutable$$, $$lnmarkets_account_scope_bindings_truncate_guard$$, $$lnmarkets_account_identity_observations_immutable$$, $$lnmarkets_account_identity_observations_truncate_guard$$) AND tgenabled = $$A$$) = 4
  AND to_regclass($$public.h4_canary_economics_evidence_receipts$$) IS NOT NULL
  AND (SELECT count(*) FROM pg_trigger WHERE tgname IN ($$h4_canary_economics_evidence_receipts_append_only$$, $$h4_canary_economics_evidence_receipts_truncate_guard$$) AND tgenabled = $$A$$) = 2
  AND to_regprocedure($$public.materialize_h4_canary_economics_evidence(uuid)$$) IS NOT NULL
  AND (SELECT proc.prosecdef FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.materialize_h4_canary_economics_evidence(uuid)$$))
  AND (SELECT proc.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$] FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.materialize_h4_canary_economics_evidence(uuid)$$))
  AND (SELECT pg_catalog.pg_get_userbyid(proc.proowner) = $$zapbot_owner$$ FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.materialize_h4_canary_economics_evidence(uuid)$$))
  AND (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(proc.prosrc, $$UTF8$$)), $$hex$$) = $$0608e68275edf2b1faf82641f104a887ef0127b400f9bd15724a7f6434d7995e$$ FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.materialize_h4_canary_economics_evidence(uuid)$$))
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault($$r$$, relation.relowner))
    ) acl
    WHERE relation.oid = pg_catalog.to_regclass($$public.h4_canary_economics_evidence_receipts$$)
      AND acl.grantee = pg_catalog.to_regrole($$zapbot_runtime$$)
      AND acl.privilege_type = $$SELECT$$
      AND NOT acl.is_grantable
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault($$r$$, relation.relowner))
    ) acl
    WHERE relation.oid = pg_catalog.to_regclass($$public.h4_canary_economics_evidence_receipts$$)
      AND (
        acl.grantee = 0
        OR acl.grantee NOT IN (pg_catalog.to_regrole($$zapbot_owner$$), pg_catalog.to_regrole($$zapbot_runtime$$))
        OR (acl.grantee = pg_catalog.to_regrole($$zapbot_runtime$$) AND (acl.privilege_type <> $$SELECT$$ OR acl.is_grantable))
      )
  )
  AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc function
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(function.proacl, pg_catalog.acldefault($$f$$, function.proowner))
    ) acl
    WHERE function.oid = pg_catalog.to_regprocedure($$public.materialize_h4_canary_economics_evidence(uuid)$$)
      AND acl.grantee = pg_catalog.to_regrole($$zapbot_runtime$$)
      AND acl.privilege_type = $$EXECUTE$$
      AND NOT acl.is_grantable
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc function
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(function.proacl, pg_catalog.acldefault($$f$$, function.proowner))
    ) acl
    WHERE function.oid = pg_catalog.to_regprocedure($$public.materialize_h4_canary_economics_evidence(uuid)$$)
      AND (
        acl.grantee = 0
        OR acl.grantee NOT IN (pg_catalog.to_regrole($$zapbot_owner$$), pg_catalog.to_regrole($$zapbot_runtime$$))
        OR (acl.grantee = pg_catalog.to_regrole($$zapbot_runtime$$) AND (acl.privilege_type <> $$EXECUTE$$ OR acl.is_grantable))
      )
  )
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.h4_canary_economics_evidence_receipts$$, $$INSERT$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.h4_canary_economics_evidence_receipts$$, $$UPDATE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.h4_canary_economics_evidence_receipts$$, $$DELETE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.h4_canary_economics_evidence_receipts$$, $$TRUNCATE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.h4_canary_economics_evidence_receipts$$, $$REFERENCES$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.h4_canary_economics_evidence_receipts$$, $$TRIGGER$$)
  AND pg_catalog.to_regclass($$public.lnmarkets_account_active_snapshot_keys$$) IS NOT NULL
  AND pg_catalog.to_regclass($$public.lnmarkets_account_active_snapshot_acquisitions$$) IS NOT NULL
  AND pg_catalog.to_regprocedure($$public.reject_lnm_account_active_snapshot_mutation()$$) IS NOT NULL
  AND pg_catalog.to_regprocedure($$public.validate_lnm_account_active_snapshot_insert()$$) IS NOT NULL
  AND (SELECT proc.prosecdef FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.reject_lnm_account_active_snapshot_mutation()$$))
  AND (SELECT proc.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$] FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.reject_lnm_account_active_snapshot_mutation()$$))
  AND (SELECT pg_catalog.pg_get_userbyid(proc.proowner) = $$zapbot_owner$$ FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.reject_lnm_account_active_snapshot_mutation()$$))
  AND (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(proc.prosrc, $$UTF8$$)), $$hex$$) = $$891728553c3ea97c1fd070b5f0e28ece29036f3ba131d1aadda50b4a34142331$$ FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.reject_lnm_account_active_snapshot_mutation()$$))
  AND (SELECT proc.prosecdef FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.validate_lnm_account_active_snapshot_insert()$$))
  AND (SELECT proc.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$] FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.validate_lnm_account_active_snapshot_insert()$$))
  AND (SELECT pg_catalog.pg_get_userbyid(proc.proowner) = $$zapbot_owner$$ FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.validate_lnm_account_active_snapshot_insert()$$))
  AND (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(proc.prosrc, $$UTF8$$)), $$hex$$) = $$8fbbe79f6eb6b486314317286cdd49afa8daa5274b3c1010207cdbbe1e13dd63$$ FROM pg_catalog.pg_proc proc WHERE proc.oid = pg_catalog.to_regprocedure($$public.validate_lnm_account_active_snapshot_insert()$$))
  AND (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname IN ($$lnmarkets_account_active_snapshot_keys_immutable$$, $$lnmarkets_account_active_snapshot_keys_truncate_guard$$, $$lnmarkets_account_active_snapshot_acquisitions_immutable$$, $$lnmarkets_account_active_snapshot_acquisitions_truncate_guard$$, $$lnm_account_active_snapshot_validate_insert$$) AND tgenabled = $$A$$) = 5
  AND (SELECT NOT role.rolcanlogin AND NOT role.rolinherit AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole AND NOT role.rolreplication AND NOT role.rolbypassrls FROM pg_catalog.pg_roles role WHERE role.rolname = $$zapbot_producer_lnmarkets_account_reconcile$$)
  AND pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_acquisitions$$, $$INSERT$$)
  AND pg_catalog.has_column_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_acquisitions$$, $$id$$, $$SELECT$$)
  AND pg_catalog.has_column_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_keys$$, $$key_id$$, $$SELECT$$)
  AND pg_catalog.has_column_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_keys$$, $$public_key$$, $$SELECT$$)
  AND NOT pg_catalog.has_column_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_keys$$, $$attestation_secret$$, $$SELECT$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.lnmarkets_account_active_snapshot_acquisitions$$, $$SELECT$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.lnmarkets_account_active_snapshot_keys$$, $$SELECT$$)
THEN $$rollback_schema_contract=pass$$ ELSE $$rollback_schema_contract=fail$$ END;
COMMIT;
SQL
SH
)
  compose exec -T whirmill-zapbot-postgres /bin/sh -ec "$verifier_script" | grep -Fx rollback_schema_contract=pass

  # The Postgres service does not mount release-sql. Validate the exact export
  # offline before streaming the immutable current verifier into the database
  # administrator session; never substitute package-local SQL here.
  docker run --rm --network none --read-only --user 1000:1000 \
    --mount "type=bind,src=$APP_DATA_DIR/data/release-sql,dst=/release-sql,readonly" \
    --entrypoint /bin/sh "$current_image" -ec '
      test -s /release-sql/.complete
      sha256sum -c /release-sql/SHA256SUMS
      test -s /release-sql/verify_database_roles.sql
    '
  docker run --rm --network none --read-only --user 1000:1000 \
    --mount "type=bind,src=$APP_DATA_DIR/data/release-sql,dst=/release-sql,readonly" \
    --entrypoint /bin/sh "$current_image" -ec 'cat /release-sql/verify_database_roles.sql' | \
    compose exec -T whirmill-zapbot-postgres /bin/sh -ec '
      export PGPASSWORD="$(cat /run/zapbot-secret/password)"
      exec psql -X -v ON_ERROR_STOP=1 -U postgres -d zapbot
    ' | grep -F 'verification_safe= t' >/dev/null
}

case "${ZAPBOT_ROLLBACK_VERIFY_SCHEMA_ONLY:-0}" in
  0) ;;
  1)
    verify_schema
    exit 0
    ;;
  *) echo 'ZAPBOT_ROLLBACK_VERIFY_SCHEMA_ONLY must be 0 or 1' >&2; exit 64 ;;
esac

verify_images() {
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    image=$(compose ps -q "$service" | xargs docker inspect -f '{{.Config.Image}}')
    test "$image" = "$legacy_image" || { echo "unexpected rollback image for $service" >&2; exit 67; }
  done

  for service in release-sql-export migrate; do
    image=$(compose ps -aq "$service" | tail -n 1 | xargs docker inspect -f '{{.Config.Image}}')
    test "$image" = "$current_image" || { echo "unexpected 0.1.69 release image for $service" >&2; exit 67; }
  done
}

replacement_services=''

legacy_service_is_fenced() {
  service=$1
  expected_process=$2
  compose exec -T "$service" /bin/sh -ec "
    ps -o comm | grep -Fx $expected_process >/dev/null
    ! ps -o comm | grep -Eq '^(beam|beam.smp|elixir)$'
  "
}

classify_runtime() {
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    # Inspect exited containers too: a partial failure may leave the correct
    # immutable image present but stopped, and a retry must re-fence it.
    service_id=$(compose ps -aq "$service" | tail -n 1)
    test -n "$service_id" || { echo "missing rollback target service: $service" >&2; exit 67; }
    image=$(docker inspect -f '{{.Config.Image}}' "$service_id")
    state=$(docker inspect -f '{{.State.Status}}' "$service_id")
    case "$service" in
      whirmill-zapbot-web) expected_process=tail ;;
      *) expected_process=sleep ;;
    esac
    case "$image" in
      "$current_image") replacement_services="$replacement_services $service" ;;
      "$legacy_image")
        # Preserve a prior successful rollback only when it is still running
        # the package's idle process. Any exited or unsafe legacy container is
        # an interrupted rollback and is recreated from the fenced overlay.
        if [ "$state" != running ] || ! legacy_service_is_fenced "$service" "$expected_process"; then
          replacement_services="$replacement_services $service"
        fi
        ;;
      *)
        echo "rollback rejects unrecognized target image for $service: $image" >&2
        exit 67
        ;;
    esac
  done

  for service in release-sql-export migrate normalize-and-verify; do
    service_id=$(compose ps -aq "$service" | tail -n 1)
    test -n "$service_id" || { echo "missing completed 0.1.69 bootstrap service: $service" >&2; exit 67; }
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$service_id")" = 'exited:0' || {
      echo "rollback requires completed 0.1.69 bootstrap service: $service" >&2
      exit 67
    }
  done

  for service in release-sql-export migrate; do
    service_id=$(compose ps -aq "$service" | tail -n 1)
    test "$(docker inspect -f '{{.Config.Image}}' "$service_id")" = "$current_image" || {
      echo "rollback requires current 0.1.69 release image for $service" >&2
      exit 67
    }
  done
}

await_fenced_health() {
  service=$1
  service_id=$(compose ps -q "$service")
  test -n "$service_id"
  health_deadline=$(( $(date +%s) + 120 ))
  while :; do
    service_state=$(docker inspect -f '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$service_id")
    case "$service_state" in
      running:healthy) break ;;
      exited:*|dead:*|*:unhealthy)
        echo "rollback service failed before health check: $service=$service_state" >&2
        exit 68
        ;;
    esac
    if [ "$(date +%s)" -ge "$health_deadline" ]; then
      echo "rollback service did not become healthy: $service=$service_state" >&2
      exit 68
    fi
    sleep 2
  done
}

verify_fenced_services() {
  await_fenced_health whirmill-zapbot-web
  compose exec -T whirmill-zapbot-web /bin/sh -ec '
    ps -o comm | grep -Fx tail >/dev/null
    ! ps -o comm | grep -Eq "^(beam|beam.smp|elixir)$"
  '

  for service in producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    await_fenced_health "$service"
    compose exec -T "$service" /bin/sh -ec '
      ps -o comm | grep -Fx sleep >/dev/null
      ! ps -o comm | grep -Eq "^(beam|beam.smp|elixir)$"
    '
  done
}

case "${1:-}" in
  --dry-run)
    compose config --quiet
    printf '%s\n' 'rollback_0_1_46_dry_run=pass'
    ;;
  '')
    compose config --quiet
    classify_runtime
    # The current package's bootstrap chain owns credentials and schema setup.
    # Recreate only targets that remain current or unsafe legacy containers.
    # --no-deps prevents a rollback from invoking credential-init or requiring
    # APP_SEED; an already-fenced all-legacy state is verification-only.
    if [ -n "$replacement_services" ]; then
      compose up -d --no-deps --force-recreate $replacement_services
    else
      printf '%s\n' 'rollback_0_1_46_verification_only=pass'
    fi
    verify_schema
    verify_images
    verify_fenced_services
    compose logs --no-color normalize-and-verify | grep -F 'verification_safe= t' >/dev/null
    printf '%s\n' 'rollback_0_1_46_compatibility=pass'
    ;;
  *)
    echo 'usage: rollback-0.1.46.sh [--dry-run]' >&2
    exit 64
    ;;
esac
