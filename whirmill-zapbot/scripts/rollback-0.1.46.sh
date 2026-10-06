#!/bin/sh
# Run only after reviewing a 0.1.82 rollback. This is a compatibility rollback:
# it retains schema 243 and protected evidence without downgrading the database
# or changing persisted authority settings. It requires the fenced 0.1.82 package
# graph to have completed first; the current image must match the
# qualified immutable source revision.
# it never initializes credentials
# or starts bootstrap dependencies.
set -eu

# Current image is verified source fc3f22d0/schema243 on both native platforms.
# Exact-image Linux populated restore/repeat/rollback and restore-224 lifecycle
# qualification and final package review remain mandatory before publication.
package_version=0.1.82
legacy_image='ghcr.io/whirmill/zapbot:umbrel-h4-policy-admission-m1c-b78caf4f292b1de6e7bccf0582616e37a5b928e1@sha256:35afe57a35f8ded8e8618ff6e6b7cabc7e17ca6c1867efd5125fdf78a222a68e'
current_image='ghcr.io/whirmill/zapbot:umbrel-venue-consumption-fc3f22d0acc0e18a0ce2816c51dbc79c0d3ed297@sha256:fc167509facacd7423ad17c57181873c9b1aa0fd98108e4ace0dcd1ee7dfa4ab'
# Run only after full package lifecycle qualification and a reviewed update.

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
  (SELECT count(*) FROM public.schema_migrations) = 243
  AND (SELECT max(version) FROM public.schema_migrations) = 20261006020000
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
  AND pg_catalog.to_regclass($$public.lnmarkets_account_active_snapshot_raw_evidence$$) IS NOT NULL
  AND (SELECT relation.relkind = $$r$$::char AND pg_catalog.pg_get_userbyid(relation.relowner) = $$zapbot_owner$$ FROM pg_catalog.pg_class relation WHERE relation.oid = $$public.lnmarkets_account_active_snapshot_raw_evidence$$::regclass)
  AND (SELECT NOT function.prosecdef AND function.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$] AND pg_catalog.pg_get_userbyid(function.proowner) = $$zapbot_owner$$ AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, $$UTF8$$)), $$hex$$) = $$9deb39db22dbab0b42fac685cbde0cd9a0c156cfaeebcdf4069310997e78dcf9$$ FROM pg_catalog.pg_proc function WHERE function.oid = $$public.lnm_account_snapshot_raw_rows_valid(jsonb,text)$$::regprocedure)
  AND (SELECT function.prosecdef AND function.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$] AND pg_catalog.pg_get_userbyid(function.proowner) = $$zapbot_owner$$ AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, $$UTF8$$)), $$hex$$) = $$aa21e2fdce4fe3725b0b8b25ad88db2a647887d5e3f6904ec8d2ae4778a02a53$$ FROM pg_catalog.pg_proc function WHERE function.oid = $$public.reject_lnm_account_snapshot_raw_evidence_mutation()$$::regprocedure)
  AND (SELECT function.prosecdef AND function.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$] AND pg_catalog.pg_get_userbyid(function.proowner) = $$zapbot_owner$$ AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, $$UTF8$$)), $$hex$$) = $$3a09d84b1625edd066c3b7fcb14ff9290bb9a2c3d6aecb88c9800b0dab812192$$ FROM pg_catalog.pg_proc function WHERE function.oid = $$public.validate_lnm_account_snapshot_raw_evidence_insert()$$::regprocedure)
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc function
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(function.proacl, pg_catalog.acldefault($$f$$, function.proowner))
    ) acl
    WHERE function.oid IN (
      $$public.lnm_account_snapshot_raw_rows_valid(jsonb,text)$$::regprocedure,
      $$public.reject_lnm_account_snapshot_raw_evidence_mutation()$$::regprocedure,
      $$public.validate_lnm_account_snapshot_raw_evidence_insert()$$::regprocedure
    )
      AND acl.grantee <> function.proowner
  )
  AND (SELECT count(*) = 3 FROM pg_catalog.pg_trigger trigger WHERE trigger.tgrelid = $$public.lnmarkets_account_active_snapshot_raw_evidence$$::regclass AND NOT trigger.tgisinternal)
  AND (SELECT count(*) = 3 FROM (VALUES
    ($$lnm_account_snapshot_raw_evidence_immutable$$::text, 27::smallint, $$public.reject_lnm_account_snapshot_raw_evidence_mutation()$$::regprocedure),
    ($$lnm_account_snapshot_raw_evidence_truncate_guard$$::text, 34::smallint, $$public.reject_lnm_account_snapshot_raw_evidence_mutation()$$::regprocedure),
    ($$lnm_account_snapshot_raw_evidence_validate_insert$$::text, 7::smallint, $$public.validate_lnm_account_snapshot_raw_evidence_insert()$$::regprocedure)
  ) expected(trigger_name, trigger_type, function_oid)
  JOIN pg_catalog.pg_trigger trigger ON trigger.tgrelid = $$public.lnmarkets_account_active_snapshot_raw_evidence$$::regclass AND trigger.tgname = expected.trigger_name AND trigger.tgtype = expected.trigger_type AND trigger.tgfoid = expected.function_oid AND trigger.tgenabled = $$A$$ AND trigger.tgqual IS NULL AND trigger.tgnargs = 0 AND trigger.tgargs = $$$$::bytea AND trigger.tgattr = $$$$::int2vector AND trigger.tgconstraint = 0 AND NOT trigger.tgdeferrable AND NOT trigger.tginitdeferred AND NOT trigger.tgisinternal)
  AND pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_raw_evidence$$, $$SELECT$$)
  AND pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_raw_evidence$$, $$INSERT$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_raw_evidence$$, $$UPDATE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_raw_evidence$$, $$DELETE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_account_active_snapshot_raw_evidence$$, $$TRUNCATE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.lnmarkets_account_active_snapshot_raw_evidence$$, $$SELECT$$)
  AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(relation.relacl, pg_catalog.acldefault($$r$$, relation.relowner))
    ) acl
    WHERE relation.oid = $$public.lnmarkets_account_active_snapshot_raw_evidence$$::regclass
      AND (
        acl.grantee = 0
        OR acl.grantee NOT IN (pg_catalog.to_regrole($$zapbot_owner$$), pg_catalog.to_regrole($$zapbot_producer_lnmarkets_account_reconcile$$))
        OR (acl.grantee = pg_catalog.to_regrole($$zapbot_producer_lnmarkets_account_reconcile$$) AND (acl.privilege_type NOT IN ($$SELECT$$, $$INSERT$$) OR acl.is_grantable))
      )
  )
  AND pg_catalog.to_regclass($$public.lnmarkets_global_current_reconciliation_receipts$$) IS NOT NULL
  AND (SELECT relation.relkind = $$r$$::char AND pg_catalog.pg_get_userbyid(relation.relowner) = $$zapbot_owner$$
       FROM pg_catalog.pg_class relation
       WHERE relation.oid = $$public.lnmarkets_global_current_reconciliation_receipts$$::regclass)
  AND (SELECT function.prosecdef AND function.provolatile = $$v$$::char
       AND function.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$]
       AND pg_catalog.pg_get_userbyid(function.proowner) = $$zapbot_owner$$
       AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, $$UTF8$$)), $$hex$$) = $$65658dc42dbdd35670a559ab8f88462e988a779a7d35f097f735e6fede4953d2$$
       FROM pg_catalog.pg_proc function
       WHERE function.oid = $$public.materialize_lnmarkets_global_current_reconciliation(text)$$::regprocedure)
  AND (SELECT function.prosecdef AND function.provolatile = $$v$$::char
       AND function.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$]
       AND pg_catalog.pg_get_userbyid(function.proowner) = $$zapbot_owner$$
       AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, $$UTF8$$)), $$hex$$) = $$7b72f62c78e7cbe96e2c23d427a73efcddb57660c145256f0110d0667a36a2dc$$
       FROM pg_catalog.pg_proc function
       WHERE function.oid = $$public.reject_lnmarkets_global_current_reconciliation_mutation()$$::regprocedure)
  AND (SELECT count(*) = 2 FROM (VALUES
       ($$lnm_global_reconciliation_immutable$$::text, 27::smallint),
       ($$lnm_global_reconciliation_truncate_guard$$::text, 34::smallint)
       ) expected(trigger_name, trigger_type)
       JOIN pg_catalog.pg_trigger trigger ON
         trigger.tgrelid = $$public.lnmarkets_global_current_reconciliation_receipts$$::regclass
         AND trigger.tgname = expected.trigger_name AND trigger.tgtype = expected.trigger_type
         AND trigger.tgfoid = $$public.reject_lnmarkets_global_current_reconciliation_mutation()$$::regprocedure
         AND trigger.tgenabled = $$A$$ AND NOT trigger.tgisinternal)
  AND pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.lnmarkets_global_current_reconciliation_receipts$$, $$SELECT$$)
  AND pg_catalog.has_function_privilege($$zapbot_runtime$$, $$public.materialize_lnmarkets_global_current_reconciliation(text)$$, $$EXECUTE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.lnmarkets_global_current_reconciliation_receipts$$, $$INSERT$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_global_current_reconciliation_receipts$$, $$SELECT$$)
  AND NOT pg_catalog.has_function_privilege($$zapbot_runtime$$, $$public.reject_lnmarkets_global_current_reconciliation_mutation()$$, $$EXECUTE$$)
  AND pg_catalog.to_regclass($$public.lnmarkets_active_funding_acquisitions$$) IS NOT NULL
  AND (SELECT relation.relkind = $$r$$::char AND pg_catalog.pg_get_userbyid(relation.relowner) = $$zapbot_owner$$
       FROM pg_catalog.pg_class relation
       WHERE relation.oid = $$public.lnmarkets_active_funding_acquisitions$$::regclass)
  AND (SELECT function.prosecdef AND function.provolatile = $$v$$::char
       AND function.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$]
       AND pg_catalog.pg_get_userbyid(function.proowner) = $$zapbot_owner$$
       AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, $$UTF8$$)), $$hex$$) = $$c20dbdc6f6dc1282e8e57656f98fdcde9e08bd4393b61709b8d588060146f464$$
       FROM pg_catalog.pg_proc function
       WHERE function.oid = $$public.reject_lnm_active_funding_mutation()$$::regprocedure)
  AND (SELECT function.prosecdef AND function.provolatile = $$v$$::char
       AND function.proconfig IS NOT DISTINCT FROM ARRAY[$$search_path=pg_catalog, public$$]
       AND pg_catalog.pg_get_userbyid(function.proowner) = $$zapbot_owner$$
       AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, $$UTF8$$)), $$hex$$) = $$24b8b4d2833348a332be313e9148ee8e94f1efe5c375e80d01f33f2c22937d56$$
       FROM pg_catalog.pg_proc function
       WHERE function.oid = $$public.validate_lnm_active_funding_insert()$$::regprocedure)
  AND (SELECT count(*) = 3 FROM (VALUES
       ($$lnm_active_funding_immutable$$::text, 27::smallint, $$public.reject_lnm_active_funding_mutation()$$::regprocedure),
       ($$lnm_active_funding_truncate_guard$$::text, 34::smallint, $$public.reject_lnm_active_funding_mutation()$$::regprocedure),
       ($$lnm_active_funding_validate_insert$$::text, 7::smallint, $$public.validate_lnm_active_funding_insert()$$::regprocedure)
       ) expected(trigger_name, trigger_type, function_oid)
       JOIN pg_catalog.pg_trigger trigger ON
         trigger.tgrelid = $$public.lnmarkets_active_funding_acquisitions$$::regclass
         AND trigger.tgname = expected.trigger_name AND trigger.tgtype = expected.trigger_type
         AND trigger.tgfoid = expected.function_oid AND trigger.tgenabled = $$A$$
         AND NOT trigger.tgisinternal)
  AND (SELECT count(*) = 4 AND pg_catalog.bool_and(constraint_row.convalidated
       AND NOT constraint_row.condeferrable AND NOT constraint_row.condeferred)
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = $$public.lnmarkets_active_funding_acquisitions$$::regclass
       AND (constraint_row.conname, constraint_row.contype) IN (
         ($$lnm_active_funding_hashes_check$$, $$c$$::char),
         ($$lnm_active_funding_nonadmission_check$$, $$c$$::char),
         ($$lnmarkets_active_funding_acquisitions_acquisition_id_fkey$$, $$f$$::char),
         ($$lnmarkets_active_funding_acquisitions_raw_evidence_id_fkey$$, $$f$$::char)))
  AND (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
       pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
         $$name$$, constraint_row.conname, $$type$$, constraint_row.contype,
         $$definition$$, pg_catalog.pg_get_constraintdef(constraint_row.oid),
         $$validated$$, constraint_row.convalidated) ORDER BY constraint_row.conname)::text,
       $$UTF8$$)), $$hex$$) = $$792582d775ab421ba6ed814dcd66c39bb1ad9cdcaf6baf90bcf4256a7e23112e$$
       FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid = $$public.lnmarkets_active_funding_acquisitions$$::regclass
       AND constraint_row.conname IN (
         $$lnm_active_funding_hashes_check$$, $$lnm_active_funding_nonadmission_check$$,
         $$lnmarkets_active_funding_acquisitions_acquisition_id_fkey$$,
         $$lnmarkets_active_funding_acquisitions_raw_evidence_id_fkey$$))
  AND pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_active_funding_acquisitions$$, $$SELECT$$)
  AND pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_active_funding_acquisitions$$, $$INSERT$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_producer_lnmarkets_account_reconcile$$, $$public.lnmarkets_active_funding_acquisitions$$, $$UPDATE$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.lnmarkets_active_funding_acquisitions$$, $$SELECT$$)
  AND NOT pg_catalog.has_table_privilege($$zapbot_runtime$$, $$public.lnmarkets_active_funding_acquisitions$$, $$INSERT$$)
  AND NOT pg_catalog.has_function_privilege($$zapbot_runtime$$, $$public.validate_lnm_active_funding_insert()$$, $$EXECUTE$$)
  -- Exact source-reviewed fixture catalog contract; keep aligned with the
  -- exported source verifier. This also rejects grants hidden at column level.
  AND (
WITH owner AS (SELECT to_regrole('zapbot_owner') AS oid),
expected_functions(signature, hash, config, language, volatility, strict) AS (VALUES
('public.lnm_prepared_intent_canonical(json)','76140271cfe72f880f2c01506d40640a1da09610a914ec65de75068ec6a0bf19','search_path=pg_catalog, public','plpgsql','i',true),
('public.lnm_prepared_intent_hash(text,text)','f22af22b76e95a4a740cb2635763a5651774c615609fd8aa3835f38076cf1845','search_path=pg_catalog','sql','i',true),
('public.lnm_prepared_intent_identifier(text)','5902eea0eaf2509e52d2c45848402035c71de01f8dcc557be0403f0503127215','search_path=pg_catalog','sql','i',false),
('public.lnm_prepared_intent_reject_mutation()','4f079a4cef25f3b5fa9a48e850435bc294ce21aa3ba18d4e4087300c024498c7','search_path=pg_catalog','plpgsql','v',false),
('public.lnm_prepared_intent_validate_context()','bb3229fd7f3e4001274b3dd1c72111ba3bd74338299b2f4f3e15bff15dc3402b','search_path=pg_catalog, public','plpgsql','v',false),
('public.lnm_prepared_intent_validate_fixture()','8388bc2eebace1f661251cecca88296bd3b522db3a39ff05f1833348f7cd5c40','search_path=pg_catalog, public','plpgsql','v',false)),
functions AS (SELECT expected.*, p.* FROM expected_functions expected LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)),
expected_triggers(table_name, name, function_name, kind) AS (VALUES
('lnm_prepared_intent_contexts','lnm_prepared_intent_contexts_validate','public.lnm_prepared_intent_validate_context()',7::smallint),
('lnm_prepared_intent_contexts','lnm_prepared_intent_contexts_immutable','public.lnm_prepared_intent_reject_mutation()',27::smallint),
('lnm_prepared_intent_contexts','lnm_prepared_intent_contexts_truncate','public.lnm_prepared_intent_reject_mutation()',34::smallint),
('lnm_prepared_intent_fixtures','lnm_prepared_intent_fixtures_validate','public.lnm_prepared_intent_validate_fixture()',7::smallint),
('lnm_prepared_intent_fixtures','lnm_prepared_intent_fixtures_immutable','public.lnm_prepared_intent_reject_mutation()',27::smallint),
('lnm_prepared_intent_fixtures','lnm_prepared_intent_fixtures_truncate','public.lnm_prepared_intent_reject_mutation()',34::smallint)),
relations AS (SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('lnm_prepared_intent_contexts','lnm_prepared_intent_fixtures'))
SELECT coalesce(
 (SELECT count(*)=2 AND bool_and(c.relowner=owner.oid AND c.relkind='r') FROM relations c CROSS JOIN owner)
 AND NOT EXISTS (SELECT 1 FROM relations c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x WHERE x.grantee<>c.relowner)
 AND NOT EXISTS (SELECT 1 FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE x.grantee<>c.relowner)
 AND (SELECT count(*)=6 AND bool_and(p.oid IS NOT NULL AND p.proowner=owner.oid AND NOT p.prosecdef
   AND p.proconfig=ARRAY[p.config]::text[] AND p.provolatile::text=p.volatility AND p.proisstrict=p.strict
   AND (SELECT lanname FROM pg_language WHERE oid=p.prolang)=p.language
   AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=p.hash) FROM functions p CROSS JOIN owner)
 AND NOT EXISTS (SELECT 1 FROM functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>p.proowner)

  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations)
    AND (NOT c.convalidated OR NOT coalesce((to_jsonb(c)->>'conenforced')::boolean, true)))
  AND (current_setting('server_version_num')::integer < 180000 OR (
    NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid IN (SELECT oid FROM relations)
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
      AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=a.attrelid AND c.contype='n'
        AND c.conkey=ARRAY[a.attnum]::smallint[] AND c.convalidated
        AND coalesce((to_jsonb(c)->>'conenforced')::boolean,true)
        AND NOT c.condeferrable AND NOT c.condeferred) <> 1)
    AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations) AND c.contype='n'
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum>0
        AND NOT a.attisdropped AND a.attnotnull AND c.conkey=ARRAY[a.attnum]::smallint[]))))

 AND (SELECT count(*)=6 AND bool_and(t.oid IS NOT NULL AND t.tgenabled='A' AND t.tgtype=e.kind
    AND t.tgfoid=to_regprocedure(e.function_name) AND t.tgqual IS NULL AND t.tgnargs=0)
    FROM expected_triggers e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.table_name) AND t.tgname=e.name)
 AND (SELECT count(*)=6 FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM relations) AND NOT tgisinternal)
 AND (SELECT count(*)=4 AND bool_and(i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    AND pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX '||c.relname||' ON public.lnm_prepared_intent_fixtures USING btree (environment_id, account_id, market_key, '||replace(replace(c.relname,'lnm_prepared_intent_',''),'_owner','')||')')
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('lnm_prepared_intent_command_id_owner','lnm_prepared_intent_client_id_owner','lnm_prepared_intent_preparation_id_owner','lnm_prepared_intent_attempt_id_owner'))
 AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.lnm_prepared_intent_fixtures') AND contype='f'
    AND confrelid=to_regclass('public.lnm_prepared_intent_contexts') AND convalidated AND confdeltype='a'
    AND pg_get_constraintdef(oid)='FOREIGN KEY (registration_id) REFERENCES lnm_prepared_intent_contexts(id)')
 AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)::text,'[]'),'UTF8')),'hex') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass('public.lnm_prepared_intent_contexts') AND a.attnum>0 AND NOT a.attisdropped)='c3a4c051ea45528ae7ed1141143b62b947d9ee03dc8948ccc0968b9b0a0f3061'
 AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid,true),'validated',convalidated) ORDER BY conname)::text,'[]'),'UTF8')),'hex') FROM pg_constraint WHERE conrelid=to_regclass('public.lnm_prepared_intent_contexts') AND contype <> 'n')='9c47e2fe956f4d0cde6cb8bc31f199563488c3ffcdf5b54451e33b4ab952bd45'
 AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)::text,'[]'),'UTF8')),'hex') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=to_regclass('public.lnm_prepared_intent_fixtures') AND a.attnum>0 AND NOT a.attisdropped)='7ae254308ad85701939bccf98aeb6af6ea7dd05ca7b49b04ea8bdac1376bae8b'
 AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid,true),'validated',convalidated) ORDER BY conname)::text,'[]'),'UTF8')),'hex') FROM pg_constraint WHERE conrelid=to_regclass('public.lnm_prepared_intent_fixtures') AND contype <> 'n')='708f4a54baf9282c575d80bca3b1b6eb9ed20e05d9842164e4398b27d702578e', false)
  )
  AND (
-- BEGIN prepared intent precall exact verification
WITH owner AS (SELECT to_regrole('zapbot_owner') AS oid),
expected_relations(name,columns_hash,constraints_hash,indexes_hash) AS (VALUES
('lnm_prepared_intent_producer_pins','e4748d8aed15d6c28b639d15bf6978da2b932799b873a7ead9755273cc7f66fa','35dc19e21a2bf1c46231e823916e870c20d5063ed7bbfd2ced0f6e407901ee4b','3f0749946246b75b36d40d9e78bc4ae2f9e10dc0c4b2430ea963ff851d3de249'),
('lnm_prepared_intent_governance_profiles','c71747c2bc98e12c8a604c90ce39e31708e00aa7ca01f6c014e4d9d5c50b6338','7a610ceca52a562702229674776f41d7bc14396632151c954676c2ae42048ed5','a4b6e9202bcd1c8910f07eb570d173984cd2a2acf8f299886bf48da90c5b19d7'),
('lnm_prepared_intent_precall_receipts','1e400563887447045d7678c784d3acdc8b34ab9a904ae3435b3dc20836c04d4b','281ffa6b83659d6d1365e43bd62c961dcb9fe4a33cf3f06c8258fb901f975b66','6eeb9cab6cc08b49bd21ba50ec535e86ed16006f35674ad5035d7da24b81523e')),
relations AS (SELECT e.*,c.oid,c.relowner,c.relkind,c.relacl FROM expected_relations e LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||e.name)),
expected_functions(signature,hash,config,language,volatility,strict) AS (VALUES
('public.lnm_precall_hash(text,text)','097b1901ba9e858431fecaa6ce185162100d64d895478a91b0306187043a2541','search_path=pg_catalog','sql','i',true),
('public.lnm_precall_validate_pin()','b3e029f678b3c24c65e8924bf18d1faf6ad3d912096664dd361065fbc9014188','search_path=pg_catalog, public','plpgsql','v',false),
('public.lnm_precall_validate_profile()','f8cadede779b753ad90bf4b82afa7b93feb24eefb62dd13d960990bd80f94be4','search_path=pg_catalog, public','plpgsql','v',false),
('public.lnm_precall_validate_receipt()','00529ca63b352c292dd8256cf9e752bcdc99c0db324c410f6100dcf4ad012d6b','search_path=pg_catalog, public','plpgsql','v',false)),
functions AS (SELECT e.*,p.* FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
expected_triggers(table_name,name,function_name,kind) AS (VALUES
('lnm_prepared_intent_producer_pins','lnm_prepared_intent_producer_pins_validate','public.lnm_precall_validate_pin()',7::smallint),
('lnm_prepared_intent_producer_pins','lnm_prepared_intent_producer_pins_immutable','public.lnm_prepared_intent_reject_mutation()',27::smallint),
('lnm_prepared_intent_producer_pins','lnm_prepared_intent_producer_pins_truncate','public.lnm_prepared_intent_reject_mutation()',34::smallint),
('lnm_prepared_intent_governance_profiles','lnm_prepared_intent_governance_profiles_validate','public.lnm_precall_validate_profile()',7::smallint),
('lnm_prepared_intent_governance_profiles','lnm_prepared_intent_governance_profiles_immutable','public.lnm_prepared_intent_reject_mutation()',27::smallint),
('lnm_prepared_intent_governance_profiles','lnm_prepared_intent_governance_profiles_truncate','public.lnm_prepared_intent_reject_mutation()',34::smallint),
('lnm_prepared_intent_precall_receipts','lnm_prepared_intent_precall_receipts_validate','public.lnm_precall_validate_receipt()',7::smallint),
('lnm_prepared_intent_precall_receipts','lnm_prepared_intent_precall_receipts_immutable','public.lnm_prepared_intent_reject_mutation()',27::smallint),
('lnm_prepared_intent_precall_receipts','lnm_prepared_intent_precall_receipts_truncate','public.lnm_prepared_intent_reject_mutation()',34::smallint))
SELECT coalesce(
(SELECT count(*)=3 AND bool_and(r.oid IS NOT NULL AND r.relowner=owner.oid AND r.relkind='r') FROM relations r CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM relations r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) x WHERE x.grantee<>r.relowner)
AND NOT EXISTS (SELECT 1 FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE x.grantee<>r.relowner)
AND (SELECT count(*)=4 AND bool_and(p.oid IS NOT NULL AND p.proowner=owner.oid AND NOT p.prosecdef
  AND p.proconfig=ARRAY[p.config]::text[] AND p.provolatile::text=p.volatility AND p.proisstrict=p.strict
  AND (SELECT lanname FROM pg_language WHERE oid=p.prolang)=p.language
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=p.hash) FROM functions p CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>p.proowner)
AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations)
  AND (NOT c.convalidated OR NOT coalesce((to_jsonb(c)->>'conenforced')::boolean,true)))
AND (current_setting('server_version_num')::integer<180000 OR (
  NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid IN (SELECT oid FROM relations) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
    AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=a.attrelid AND c.contype='n' AND c.conkey=ARRAY[a.attnum]::smallint[] AND c.convalidated
      AND coalesce((to_jsonb(c)->>'conenforced')::boolean,true) AND NOT c.condeferrable AND NOT c.condeferred)<>1)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations) AND c.contype='n'
    AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND c.conkey=ARRAY[a.attnum]::smallint[]))))
AND (SELECT count(*)=9 AND bool_and(t.oid IS NOT NULL AND t.tgenabled='A' AND t.tgtype=e.kind AND t.tgfoid=to_regprocedure(e.function_name)
  AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND NOT t.tgisinternal)
  FROM expected_triggers e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.table_name) AND t.tgname=e.name)
AND (SELECT count(*)=9 FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM relations) AND NOT tgisinternal)
AND (SELECT bool_and(
  (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)::text,'[]'),'UTF8')),'hex') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped)=r.columns_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid,true),'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred) ORDER BY conname)::text,'[]'),'UTF8')),'hex') FROM pg_constraint WHERE conrelid=r.oid AND contype<>'n')=r.constraints_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_get_expr(i.indpred,i.indrelid),'expression',pg_get_expr(i.indexprs,i.indrelid)) ORDER BY c.relname)::text,'[]'),'UTF8')),'hex') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=r.oid)=r.indexes_hash
) FROM relations r),false)
-- END prepared intent precall exact verification
  )
  AND (
-- BEGIN prepared intent consumption exact verification
WITH owner AS (SELECT to_regrole('zapbot_owner') AS oid),
expected_relations(name,columns_hash,constraints_hash,indexes_hash) AS (VALUES
('lnm_prepared_intent_consumptions','42d26cb2699aa943c788238d5b0b486437018685cfd8bfbcd45364c093ba329e','d2541cbeb9c31446f9436be4c29c69c8a3857336c06154a8281b65a3ef8bf21b','1c1adec2f114fb7023c621cd44db52ac00c1d2720a772c43f31cafa1287f99a9')),
relations AS (SELECT e.*,c.oid,c.relowner,c.relkind,c.relacl FROM expected_relations e LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||e.name)),
expected_functions(signature,hash,config,language,volatility,strict) AS (VALUES
('public.lnm_consumption_validate()','afd8871b3f659415b60768e78f48ac380bde6bffae4d33e1a521d74b7cf11696','search_path=pg_catalog, public','plpgsql','v',false)),
functions AS (SELECT e.*,p.* FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
expected_triggers(table_name,name,function_name,kind) AS (VALUES
('lnm_prepared_intent_consumptions','lnm_consumption_validate','public.lnm_consumption_validate()',7::smallint),
('lnm_prepared_intent_consumptions','lnm_consumption_immutable','public.lnm_prepared_intent_reject_mutation()',27::smallint),
('lnm_prepared_intent_consumptions','lnm_consumption_truncate','public.lnm_prepared_intent_reject_mutation()',34::smallint))
SELECT coalesce(
(SELECT count(*)=1 AND bool_and(r.oid IS NOT NULL AND r.relowner=owner.oid AND r.relkind='r') FROM relations r CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM relations r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) x WHERE x.grantee<>r.relowner)
AND NOT EXISTS (SELECT 1 FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE x.grantee<>r.relowner)
AND (SELECT count(*)=1 AND bool_and(p.oid IS NOT NULL AND p.proowner=owner.oid AND NOT p.prosecdef
  AND p.proconfig=ARRAY[p.config]::text[] AND p.provolatile::text=p.volatility AND p.proisstrict=p.strict
  AND (SELECT lanname FROM pg_language WHERE oid=p.prolang)=p.language
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=p.hash) FROM functions p CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>p.proowner)
AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations)
  AND (NOT c.convalidated OR NOT coalesce((to_jsonb(c)->>'conenforced')::boolean,true)))
AND (current_setting('server_version_num')::integer<180000 OR (
  NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid IN (SELECT oid FROM relations) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
    AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=a.attrelid AND c.contype='n' AND c.conkey=ARRAY[a.attnum]::smallint[] AND c.convalidated
      AND coalesce((to_jsonb(c)->>'conenforced')::boolean,true) AND NOT c.condeferrable AND NOT c.condeferred)<>1)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations) AND c.contype='n'
    AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND c.conkey=ARRAY[a.attnum]::smallint[]))))
AND (SELECT count(*)=3 AND bool_and(t.oid IS NOT NULL AND t.tgenabled='A' AND t.tgtype=e.kind AND t.tgfoid=to_regprocedure(e.function_name)
  AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND NOT t.tgisinternal)
  FROM expected_triggers e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.table_name) AND t.tgname=e.name)
AND (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM relations) AND NOT tgisinternal)
AND (SELECT bool_and(
  (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)::text,'[]'),'UTF8')),'hex') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped)=r.columns_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid,true),'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred) ORDER BY conname)::text,'[]'),'UTF8')),'hex') FROM pg_constraint WHERE conrelid=r.oid AND contype<>'n')=r.constraints_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_get_expr(i.indpred,i.indrelid),'expression',pg_get_expr(i.indexprs,i.indrelid)) ORDER BY c.relname)::text,'[]'),'UTF8')),'hex') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=r.oid)=r.indexes_hash
) FROM relations r),false)
-- END prepared intent consumption exact verification
  )
AND (
WITH owner AS (SELECT to_regrole('zapbot_owner') AS oid),
expected_relations(name,columns_hash,constraints_hash,indexes_hash) AS (VALUES
('lnm_prepared_intent_venue_pins','58e83fa11297c24c70c64be5889ded6ba472ffce1b01efb2d92902bc375b4a50','12f369292942388fdd9b5ec13e64a2d0c870a907256369b99beddb7465e4d18c','56d1cc76b78901a23750644374c05c801c6965063ce7a395b2b23eda7deb9743'),
('lnm_prepared_intent_venue_profiles','fc14f8b42530ea432816177e0119b38c2ab9cb66a214c5c8b969744526fcda57','b148c700293d8775b8c3c2854853f845a691f9b9bac5300058327bdceed2fdcd','2930ca4ea8eff8e81e69e35906203fd24b2d5688d566ab5aece5a33f518f18dc'),
('lnm_prepared_intent_venue_bindings','dcd89d5c3f49921e3ccc3b63751b73faf171c9d18cedc16b9c7534a42301f710','7805cb055188d5c7b93be07fe1b6b0df1a617f8d616f960b957508c5eb1e21d1','3101c52ae38371f70b7626989799ccb22e30f6c40986b4f39cb15e5a1624d429')),
relations AS (SELECT e.*,c.oid,c.relowner,c.relkind,c.relacl FROM expected_relations e LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||e.name)),
expected_functions(signature,hash,config,language,volatility,strict) AS (VALUES
('public.lnm_venue_canonical(json)','b8b921856a60b6cd597ad47d935012278cc48b4034688d3c67b40c690f5d62dd','search_path=pg_catalog, public','plpgsql','i',true),
('public.lnm_venue_context(json)','5ba7fc728856053b855e43142e8e568709ebaa703b13e13a66df1d5c0f739ee7','search_path=pg_catalog, public','plpgsql','i',false),
('public.lnm_venue_exact(json,text[])','99658f48e941914c20ed541331392b6029e33723db85356c7686f50369496752','search_path=pg_catalog, public','sql','i',false),
('public.lnm_venue_hash(text,text,text)','0626ea345d3cc12f35aba1fb53b8f3f7b5270ce83f13851a5da7aa494b739b81','search_path=pg_catalog','sql','i',true),
('public.lnm_venue_key(text)','1969c7a879ac471ca38b99de8325523df0c9afa75a6d8f7224c6a44992c64756','search_path=pg_catalog','plpgsql','i',false),
('public.lnm_venue_reject_mutation()','436a4fdca41ebb03df762cceede8c6c67c13a1926a0fb2de6baa78c4506aa8f2','search_path=pg_catalog','plpgsql','v',false),
('public.lnm_venue_safety(json)','c93c892467c3081eeb08252b55616445ebea8eb11ec779ed4630560c74cf0418','search_path=pg_catalog','sql','i',false),
('public.lnm_venue_signature(text)','ded17b5bf0928ab9eaa7070e12f39ed3895d5d9ebd5250f3c0f1268c7b763c1a','search_path=pg_catalog','plpgsql','i',false),
('public.lnm_venue_timestamp(text)','54c9f5c5eaa9d6c409c1f112bcda1366f6c4c54be300ec0899702d83126cd77c','search_path=pg_catalog','sql','i',false),
('public.lnm_venue_validate_binding()','030261f2d7aa3e46a49079108cfcf6457cf805377909ce56314ec595f7600cb2','search_path=pg_catalog, public','plpgsql','v',false),
('public.lnm_venue_validate_pin()','82fcfb02273f55f3227cd411069e19e155aca83df31d5945372142d93082f88f','search_path=pg_catalog, public','plpgsql','v',false),
('public.lnm_venue_validate_profile()','207623b2803b5cdbbbb382b537dd9a2492f45004091a862d117c9c4c1b90bf47','search_path=pg_catalog, public','plpgsql','v',false)),
functions AS (SELECT e.*,p.* FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
expected_triggers(table_name,name,function_name,kind) AS (VALUES
('lnm_prepared_intent_venue_pins','lnm_prepared_intent_venue_pins_validate','public.lnm_venue_validate_pin()',7::smallint),
('lnm_prepared_intent_venue_pins','lnm_prepared_intent_venue_pins_immutable','public.lnm_venue_reject_mutation()',27::smallint),
('lnm_prepared_intent_venue_pins','lnm_prepared_intent_venue_pins_truncate','public.lnm_venue_reject_mutation()',34::smallint),
('lnm_prepared_intent_venue_profiles','lnm_prepared_intent_venue_profiles_validate','public.lnm_venue_validate_profile()',7::smallint),
('lnm_prepared_intent_venue_profiles','lnm_prepared_intent_venue_profiles_immutable','public.lnm_venue_reject_mutation()',27::smallint),
('lnm_prepared_intent_venue_profiles','lnm_prepared_intent_venue_profiles_truncate','public.lnm_venue_reject_mutation()',34::smallint),
('lnm_prepared_intent_venue_bindings','lnm_prepared_intent_venue_bindings_validate','public.lnm_venue_validate_binding()',7::smallint),
('lnm_prepared_intent_venue_bindings','lnm_prepared_intent_venue_bindings_immutable','public.lnm_venue_reject_mutation()',27::smallint),
('lnm_prepared_intent_venue_bindings','lnm_prepared_intent_venue_bindings_truncate','public.lnm_venue_reject_mutation()',34::smallint))
SELECT coalesce(
(SELECT count(*)=3 AND bool_and(r.oid IS NOT NULL AND r.relowner=owner.oid AND r.relkind='r') FROM relations r CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM relations r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) x WHERE x.grantee<>r.relowner)
AND NOT EXISTS (SELECT 1 FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE x.grantee<>r.relowner)
AND (SELECT count(*)=12 AND bool_and(p.oid IS NOT NULL AND p.proowner=owner.oid AND NOT p.prosecdef
  AND p.proconfig=ARRAY[p.config]::text[] AND p.provolatile::text=p.volatility AND p.proisstrict=p.strict
  AND (SELECT lanname FROM pg_language WHERE oid=p.prolang)=p.language
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=p.hash) FROM functions p CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>p.proowner)
AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations)
  AND (NOT c.convalidated OR NOT coalesce((to_jsonb(c)->>'conenforced')::boolean,true)))
AND (current_setting('server_version_num')::integer<180000 OR (
  NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid IN (SELECT oid FROM relations) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
    AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=a.attrelid AND c.contype='n' AND c.conkey=ARRAY[a.attnum]::smallint[] AND c.convalidated
      AND coalesce((to_jsonb(c)->>'conenforced')::boolean,true) AND NOT c.condeferrable AND NOT c.condeferred)<>1)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations) AND c.contype='n'
    AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND c.conkey=ARRAY[a.attnum]::smallint[]))))
AND (SELECT count(*)=9 AND bool_and(t.oid IS NOT NULL AND t.tgenabled='A' AND t.tgtype=e.kind AND t.tgfoid=to_regprocedure(e.function_name)
  AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND NOT t.tgisinternal)
  FROM expected_triggers e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.table_name) AND t.tgname=e.name)
AND (SELECT count(*)=9 FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM relations) AND NOT tgisinternal)
AND (SELECT bool_and(
  (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'collation',a.attcollation::regcollation::text,'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)::text,'[]'),'UTF8')),'hex') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped)=r.columns_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid,true),'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred) ORDER BY conname)::text,'[]'),'UTF8')),'hex') FROM pg_constraint WHERE conrelid=r.oid AND contype<>'n')=r.constraints_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_get_expr(i.indpred,i.indrelid),'expression',pg_get_expr(i.indexprs,i.indrelid)) ORDER BY c.relname)::text,'[]'),'UTF8')),'hex') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=r.oid)=r.indexes_hash
) FROM relations r),false)
)
AND (
-- BEGIN prepared intent VENUE consumption exact verification
WITH owner AS (SELECT to_regrole('zapbot_owner') AS oid),
expected_relations(name,columns_hash,constraints_hash,indexes_hash) AS (VALUES
('lnm_prepared_intent_venue_consumptions','abe65eb9e9e0066b12402b3562d4872a5e8de3e9caaf5fab782cdc272221285d','5d895b5856023685890c8ec5ca9b7be6afc32130e3941436739798bf92cbd432','1a324c5ce94c949e9e749f659f36fe031c22c2b3ae33ef3eb36514e47603bcff')),
relations AS (SELECT e.*,c.oid,c.relowner,c.relkind,c.relacl FROM expected_relations e LEFT JOIN pg_class c ON c.oid=to_regclass('public.'||e.name)),
expected_functions(signature,hash,config,language,volatility,strict) AS (VALUES
('public.lnm_consumption_venue_validate()','3853d88493907e701f33e719aecee1995cb00c2fd02bc84c6963d2fccb5a721a','search_path=pg_catalog, public','plpgsql','v',false),
('public.lnm_venue_reject_mutation()','436a4fdca41ebb03df762cceede8c6c67c13a1926a0fb2de6baa78c4506aa8f2','search_path=pg_catalog','plpgsql','v',false)),
functions AS (SELECT e.*,p.* FROM expected_functions e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)),
expected_triggers(table_name,name,function_name,kind) AS (VALUES
('lnm_prepared_intent_venue_consumptions','lnm_venue_consumption_validate','public.lnm_consumption_venue_validate()',7::smallint),
('lnm_prepared_intent_venue_consumptions','lnm_venue_consumption_immutable','public.lnm_venue_reject_mutation()',27::smallint),
('lnm_prepared_intent_venue_consumptions','lnm_venue_consumption_truncate','public.lnm_venue_reject_mutation()',34::smallint))
SELECT coalesce(
(SELECT count(*)=1 AND bool_and(r.oid IS NOT NULL AND r.relowner=owner.oid AND r.relkind='r') FROM relations r CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM relations r CROSS JOIN LATERAL aclexplode(coalesce(r.relacl,acldefault('r',r.relowner))) x WHERE x.grantee<>r.relowner)
AND NOT EXISTS (SELECT 1 FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE x.grantee<>r.relowner)
AND (SELECT count(*)=2 AND bool_and(p.oid IS NOT NULL AND p.proowner=owner.oid AND NOT p.prosecdef
  AND p.proconfig=ARRAY[p.config]::text[] AND p.provolatile::text=p.volatility AND p.proisstrict=p.strict
  AND (SELECT lanname FROM pg_language WHERE oid=p.prolang)=p.language
  AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=p.hash) FROM functions p CROSS JOIN owner)
AND NOT EXISTS (SELECT 1 FROM functions p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantee<>p.proowner)
AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations)
  AND (NOT c.convalidated OR NOT coalesce((to_jsonb(c)->>'conenforced')::boolean,true)))
AND (current_setting('server_version_num')::integer<180000 OR (
  NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid IN (SELECT oid FROM relations) AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull
    AND (SELECT count(*) FROM pg_constraint c WHERE c.conrelid=a.attrelid AND c.contype='n' AND c.conkey=ARRAY[a.attnum]::smallint[] AND c.convalidated
      AND coalesce((to_jsonb(c)->>'conenforced')::boolean,true) AND NOT c.condeferrable AND NOT c.condeferred)<>1)
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid IN (SELECT oid FROM relations) AND c.contype='n'
    AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.conrelid AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull AND c.conkey=ARRAY[a.attnum]::smallint[]))))
AND (SELECT count(*)=3 AND bool_and(t.oid IS NOT NULL AND t.tgenabled='A' AND t.tgtype=e.kind AND t.tgfoid=to_regprocedure(e.function_name)
  AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector AND t.tgconstraint=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND NOT t.tgisinternal)
  FROM expected_triggers e LEFT JOIN pg_trigger t ON t.tgrelid=to_regclass('public.'||e.table_name) AND t.tgname=e.name)
AND (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid IN (SELECT oid FROM relations) AND NOT tgisinternal)
AND (SELECT bool_and(
  (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'collation',a.attcollation::regcollation::text,'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum)::text,'[]'),'UTF8')),'hex') FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped)=r.columns_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('name',conname,'type',contype,'definition',pg_get_constraintdef(oid,true),'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred) ORDER BY conname)::text,'[]'),'UTF8')),'hex') FROM pg_constraint WHERE conrelid=r.oid AND contype<>'n')=r.constraints_hash
  AND (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'unique',i.indisunique,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_get_expr(i.indpred,i.indrelid),'expression',pg_get_expr(i.indexprs,i.indrelid)) ORDER BY c.relname)::text,'[]'),'UTF8')),'hex') FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=r.oid)=r.indexes_hash
) FROM relations r),false)
-- END prepared intent VENUE consumption exact verification
)
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
    test "$image" = "$current_image" || { echo "unexpected 0.1.82 release image for $service" >&2; exit 67; }
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
    test -n "$service_id" || { echo "missing completed 0.1.82 bootstrap service: $service" >&2; exit 67; }
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$service_id")" = 'exited:0' || {
      echo "rollback requires completed 0.1.82 bootstrap service: $service" >&2
      exit 67
    }
  done

  for service in release-sql-export migrate; do
    service_id=$(compose ps -aq "$service" | tail -n 1)
    test "$(docker inspect -f '{{.Config.Image}}' "$service_id")" = "$current_image" || {
      echo "rollback requires current 0.1.82 release image for $service" >&2
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
