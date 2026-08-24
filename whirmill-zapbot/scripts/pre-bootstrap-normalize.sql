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
      pg_catalog.to_regprocedure('public.guard_attested_causal_event_correction()')::oid,
      pg_catalog.to_regprocedure('public.record_causal_event_producer_receipt()')::oid,
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
  reviewed_count integer;
BEGIN
  SELECT count(*)
  INTO reviewed_count
  FROM pg_catalog.pg_proc function
  WHERE function.oid = ANY (allowed_security_definer_functions)
    AND function.prosecdef;

  IF reviewed_count <> pg_catalog.cardinality(allowed_security_definer_functions) OR EXISTS (
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
