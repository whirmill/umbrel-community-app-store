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
