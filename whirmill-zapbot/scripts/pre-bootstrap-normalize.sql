\set ON_ERROR_STOP on
\set ECHO none
\pset pager off

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'zapbot_owner'
  ) THEN
    CREATE ROLE zapbot_owner;
  END IF;
END
$$;

ALTER ROLE zapbot_owner
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

-- A no-owner pg_restore recreates application objects as the connecting
-- administrator. Before changing ownership, fail closed unless every
-- non-extension SECURITY DEFINER function is in the reviewed ZapBot contract.
DO $$
DECLARE
  allowed_security_definer_functions oid[] := pg_catalog.array_remove(
    ARRAY[
      pg_catalog.to_regprocedure(
        'public.freeze_h4_canary_frozen_budget(text,text,bigint,text,jsonb)'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.materialize_h4_canary_economics_evidence(uuid)'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.record_lnmarkets_account_identity_observation(text,text,text,text,timestamp with time zone)'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.lnmarkets_account_identity_status(text)'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.reject_lnm_account_active_snapshot_mutation()'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.validate_lnm_account_active_snapshot_insert()'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.reject_lnm_account_snapshot_raw_evidence_mutation()'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.validate_lnm_account_snapshot_raw_evidence_insert()'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.reject_lnmarkets_global_current_reconciliation_mutation()'
      )::oid,
      pg_catalog.to_regprocedure(
        'public.materialize_lnmarkets_global_current_reconciliation(text)'
      )::oid,
      pg_catalog.to_regprocedure('public.reject_lnm_active_funding_mutation()')::oid,
      pg_catalog.to_regprocedure('public.validate_lnm_active_funding_insert()')::oid,
      pg_catalog.to_regprocedure('public.guard_attested_causal_event_correction()')::oid,
      pg_catalog.to_regprocedure('public.record_causal_event_producer_receipt()')::oid,
      pg_catalog.to_regprocedure('public.validate_forward_return_label_causal_attestation()')::oid,
      pg_catalog.to_regprocedure('public.validate_forward_holdout_successor_campaign_insert()')::oid,
      pg_catalog.to_regprocedure('public.validate_causal_funding_window_completed_insert()')::oid,
      pg_catalog.to_regprocedure('public.validate_causal_execution_economics_finalized_insert()')::oid,
      pg_catalog.to_regprocedure('public.validate_causal_execution_economics_window_completed_insert()')::oid,
      pg_catalog.to_regprocedure('public.validate_execution_economics_acquisition_artifact_insert()')::oid,
      pg_catalog.to_regprocedure('public.validate_execution_economics_acquisition_revision_insert()')::oid,
      pg_catalog.to_regprocedure('public.validate_execution_economics_acquisition_heartbeat_binding()')::oid,
      pg_catalog.to_regprocedure('public.execution_economics_producer_receipt(uuid)')::oid,
      pg_catalog.to_regprocedure('public.lock_risk_authority_protected_setting_mutation()')::oid,
      pg_catalog.to_regprocedure('public.record_risk_authority_setting_change_receipt()')::oid,
      pg_catalog.to_regprocedure('public.risk_authority_protected_settings_payload()')::oid,
      pg_catalog.to_regprocedure('public.risk_authority_unmapped_managed_setting_keys()')::oid,
      pg_catalog.to_regprocedure('public.validate_risk_authority_configuration_snapshot_insert()')::oid,
      pg_catalog.to_regprocedure('public.emit_risk_authority_configuration_snapshot()')::oid,
      pg_catalog.to_regprocedure('public.emit_risk_authority_configuration_snapshot(uuid,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.forward_holdout_v2_source_coverage_v1(uuid,text,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.forward_holdout_v2_source_coverage(uuid,text,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.forward_holdout_v2_source_coverage(uuid,text,timestamp without time zone,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.trusted_v2_replay_source_coverage(uuid,text,timestamp without time zone,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.current_forward_holdout_v2_continuous_checkpoint(uuid,text,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.advance_forward_holdout_v2_continuous_checkpoint(uuid,text,timestamp without time zone,timestamp without time zone,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.append_trusted_v2_causal_event(text,text,text,timestamp without time zone,timestamp without time zone,text,jsonb)')::oid,
      pg_catalog.to_regprocedure('public.seal_forward_holdout_v2(uuid,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.preflight_forward_holdout_v2_seal(uuid,timestamp without time zone)')::oid,
      pg_catalog.to_regprocedure('public.attest_forward_holdout_v2(uuid,text,text)')::oid,
      pg_catalog.to_regprocedure('public.write_forward_holdout_v2_report(uuid)')::oid,
      pg_catalog.to_regprocedure('public.register_lnmarkets_execution_economics_acquisition_key(text,text,uuid,timestamp without time zone,timestamp without time zone,bytea)')::oid
    ],
    NULL
  );
  freeze_function oid := pg_catalog.to_regprocedure(
    'public.freeze_h4_canary_frozen_budget(text,text,bigint,text,jsonb)'
  );
  materializer_function oid := pg_catalog.to_regprocedure(
    'public.materialize_h4_canary_economics_evidence(uuid)'
  );
  account_snapshot_reject_function oid := pg_catalog.to_regprocedure(
    'public.reject_lnm_account_active_snapshot_mutation()'
  );
  account_snapshot_validate_function oid := pg_catalog.to_regprocedure(
    'public.validate_lnm_account_active_snapshot_insert()'
  );
  raw_evidence_rows_valid_function oid := pg_catalog.to_regprocedure(
    'public.lnm_account_snapshot_raw_rows_valid(jsonb,text)'
  );
  raw_evidence_reject_function oid := pg_catalog.to_regprocedure(
    'public.reject_lnm_account_snapshot_raw_evidence_mutation()'
  );
  raw_evidence_validate_function oid := pg_catalog.to_regprocedure(
    'public.validate_lnm_account_snapshot_raw_evidence_insert()'
  );
  global_reconciliation_reject_function oid := pg_catalog.to_regprocedure(
    'public.reject_lnmarkets_global_current_reconciliation_mutation()'
  );
  global_reconciliation_materializer_function oid := pg_catalog.to_regprocedure(
    'public.materialize_lnmarkets_global_current_reconciliation(text)'
  );
  active_funding_reject_function oid := pg_catalog.to_regprocedure(
    'public.reject_lnm_active_funding_mutation()'
  );
  active_funding_validate_function oid := pg_catalog.to_regprocedure(
    'public.validate_lnm_active_funding_insert()'
  );
  freeze_function_reviewed boolean;
  materializer_function_reviewed boolean;
  account_snapshot_reject_function_reviewed boolean;
  account_snapshot_validate_function_reviewed boolean;
  raw_evidence_rows_valid_function_reviewed boolean;
  raw_evidence_reject_function_reviewed boolean;
  raw_evidence_validate_function_reviewed boolean;
  global_reconciliation_reject_function_reviewed boolean;
  global_reconciliation_materializer_function_reviewed boolean;
  active_funding_reject_function_reviewed boolean;
  active_funding_validate_function_reviewed boolean;
  reviewed_count integer;
BEGIN
  -- This normalizer precedes migrations on an empty or 224 restore. Once the
  -- M1b function exists, however, accept only its exact reviewed contract.
  IF freeze_function IS NULL THEN
    freeze_function_reviewed := true;
  ELSE
    SELECT
      function.prosecdef
        AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
        AND pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
          'hex'
        ) = '20c7eb1b056883ce6e80a2f34a5dd7f077c50004e521d606d4554c33efea6169'
    INTO freeze_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = freeze_function;
  END IF;

  -- Schema 235 can be present in an ownerless current-schema restore. Verify
  -- its exact source-approved SECDEF bodies before reownership below. An owner
  -- predicate here would incorrectly reject the expected postgres owner from
  -- pg_restore --no-owner; final bootstrap verifies zapbot_owner afterward.
  IF account_snapshot_reject_function IS NULL THEN
    account_snapshot_reject_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = '891728553c3ea97c1fd070b5f0e28ece29036f3ba131d1aadda50b4a34142331'
    INTO account_snapshot_reject_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = account_snapshot_reject_function;
  END IF;

  IF account_snapshot_validate_function IS NULL THEN
    account_snapshot_validate_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = '8fbbe79f6eb6b486314317286cdd49afa8daa5274b3c1010207cdbbe1e13dd63'
    INTO account_snapshot_validate_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = account_snapshot_validate_function;
  END IF;

  -- Schema 236 raw evidence is a cryptographically replayable text witness for
  -- the already signed account-snapshot parent. Validate every function that
  -- participates in its immutable insert path before ownerless restores are
  -- re-owned below; JSONB is only a non-authoritative projection.
  IF raw_evidence_rows_valid_function IS NULL THEN
    raw_evidence_rows_valid_function_reviewed := true;
  ELSE
    SELECT NOT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = '9deb39db22dbab0b42fac685cbde0cd9a0c156cfaeebcdf4069310997e78dcf9'
    INTO raw_evidence_rows_valid_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = raw_evidence_rows_valid_function;
  END IF;

  IF raw_evidence_reject_function IS NULL THEN
    raw_evidence_reject_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = 'aa21e2fdce4fe3725b0b8b25ad88db2a647887d5e3f6904ec8d2ae4778a02a53'
    INTO raw_evidence_reject_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = raw_evidence_reject_function;
  END IF;

  IF raw_evidence_validate_function IS NULL THEN
    raw_evidence_validate_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = '3a09d84b1625edd066c3b7fcb14ff9290bb9a2c3d6aecb88c9800b0dab812192'
    INTO raw_evidence_validate_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = raw_evidence_validate_function;
  END IF;

  -- Schema 237 may be absent on an earlier restore. If it is present, pin
  -- both SECURITY DEFINER bodies before ownerless reownership can occur.
  IF global_reconciliation_reject_function IS NULL THEN
    global_reconciliation_reject_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = '7b72f62c78e7cbe96e2c23d427a73efcddb57660c145256f0110d0667a36a2dc'
    INTO global_reconciliation_reject_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = global_reconciliation_reject_function;
  END IF;

  IF global_reconciliation_materializer_function IS NULL THEN
    global_reconciliation_materializer_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = '65658dc42dbdd35670a559ab8f88462e988a779a7d35f097f735e6fede4953d2'
    INTO global_reconciliation_materializer_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = global_reconciliation_materializer_function;
  END IF;

  -- Schema 238 can be absent before migration. On an ownerless current-schema
  -- restore, reown only the exact source-approved immutable insert path.
  IF active_funding_reject_function IS NULL THEN
    active_funding_reject_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = 'c20dbdc6f6dc1282e8e57656f98fdcde9e08bd4393b61709b8d588060146f464'
    INTO active_funding_reject_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = active_funding_reject_function;
  END IF;

  IF active_funding_validate_function IS NULL THEN
    active_funding_validate_function_reviewed := true;
  ELSE
    SELECT function.prosecdef
      AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
        'hex'
      ) = '24b8b4d2833348a332be313e9148ee8e94f1efe5c375e80d01f33f2c22937d56'
    INTO active_funding_validate_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = active_funding_validate_function;
  END IF;

  -- The schema-234 materializer may be absent before migration. When present,
  -- retain only the reviewed SECDEF search path and immutable body before the
  -- reownership loop below assigns zapbot_owner after an ownerless restore.
  IF materializer_function IS NULL THEN
    materializer_function_reviewed := true;
  ELSE
    SELECT
      function.prosecdef
        AND function.proconfig = ARRAY['search_path=pg_catalog, public']::text[]
        AND pg_catalog.encode(
          pg_catalog.sha256(pg_catalog.convert_to(function.prosrc, 'UTF8')),
          'hex'
        ) = '0608e68275edf2b1faf82641f104a887ef0127b400f9bd15724a7f6434d7995e'
    INTO materializer_function_reviewed
    FROM pg_catalog.pg_proc function
    WHERE function.oid = materializer_function;
  END IF;

  SELECT count(*)
  INTO reviewed_count
  FROM pg_catalog.pg_proc function
  WHERE function.oid = ANY (allowed_security_definer_functions)
    AND function.prosecdef;

  IF reviewed_count <> pg_catalog.cardinality(allowed_security_definer_functions)
     OR freeze_function_reviewed IS NOT TRUE
     OR materializer_function_reviewed IS NOT TRUE
     OR account_snapshot_reject_function_reviewed IS NOT TRUE
     OR account_snapshot_validate_function_reviewed IS NOT TRUE
     OR raw_evidence_rows_valid_function_reviewed IS NOT TRUE
     OR raw_evidence_reject_function_reviewed IS NOT TRUE
     OR raw_evidence_validate_function_reviewed IS NOT TRUE
     OR global_reconciliation_reject_function_reviewed IS NOT TRUE
     OR global_reconciliation_materializer_function_reviewed IS NOT TRUE
     OR active_funding_reject_function_reviewed IS NOT TRUE
     OR active_funding_validate_function_reviewed IS NOT TRUE
     OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc function
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = 'public'
      AND function.prosecdef
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
          AND dependency.objid = function.oid
          AND dependency.deptype = 'e'
      )
      AND function.oid <> ALL (allowed_security_definer_functions)
  ) THEN
    RAISE EXCEPTION 'restored SECURITY DEFINER inventory does not match the reviewed ZapBot contract';
  END IF;
END
$$;

ALTER SCHEMA public OWNER TO zapbot_owner;

DO $$
DECLARE
  app_relation record;
  app_function record;
  app_type record;
BEGIN
  FOR app_relation IN
    SELECT relation.oid, relation.relkind
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND (
        relation.relkind <> 'S'
        OR NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_depend owned_sequence
          WHERE owned_sequence.classid = 'pg_catalog.pg_class'::regclass
            AND owned_sequence.objid = relation.oid
            AND owned_sequence.refclassid = 'pg_catalog.pg_class'::regclass
            AND owned_sequence.deptype IN ('a', 'i')
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
        WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
          AND dependency.objid = relation.oid
          AND dependency.deptype = 'e'
      )
  LOOP
    CASE app_relation.relkind
      WHEN 'S' THEN EXECUTE format('ALTER SEQUENCE %s OWNER TO zapbot_owner', app_relation.oid::regclass);
      WHEN 'v' THEN EXECUTE format('ALTER VIEW %s OWNER TO zapbot_owner', app_relation.oid::regclass);
      WHEN 'm' THEN EXECUTE format('ALTER MATERIALIZED VIEW %s OWNER TO zapbot_owner', app_relation.oid::regclass);
      ELSE EXECUTE format('ALTER TABLE %s OWNER TO zapbot_owner', app_relation.oid::regclass);
    END CASE;
  END LOOP;

  FOR app_function IN
    SELECT function.oid
    FROM pg_catalog.pg_proc function
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = function.pronamespace
    WHERE namespace.nspname = 'public'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
          AND dependency.objid = function.oid
          AND dependency.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO zapbot_owner', app_function.oid::regprocedure);
    IF (SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid = app_function.oid) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', app_function.oid::regprocedure);
    END IF;
  END LOOP;

  FOR app_type IN
    SELECT type.oid
    FROM pg_catalog.pg_type type
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type.typnamespace
    WHERE namespace.nspname = 'public'
      AND type.typrelid = 0
      AND type.typelem = 0
      AND type.typtype IN ('b', 'd', 'e', 'r')
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend dependency
        JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
        WHERE dependency.classid = 'pg_catalog.pg_type'::regclass
          AND dependency.objid = type.oid
          AND dependency.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO zapbot_owner', app_type.oid::regtype);
  END LOOP;
END
$$;

COMMIT;
