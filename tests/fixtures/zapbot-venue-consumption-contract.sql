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
