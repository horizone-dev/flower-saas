-- Row-level companion of fingerprint.sql: one line per schema object (same aspects, same selectors), sorted as text, so that two databases can be
-- compared with `diff` and a differing aspect hash can be traced to the exact object. Reads only; nothing depends on OIDs.
\pset format unaligned
\pset tuples_only on
SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '')
  FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1;
SELECT 'index ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1;
SELECT 'constraint ' || conrelid::regclass::text || '.' || conname || ' [' || contype::text || ' deferrable=' || condeferrable || ' deferred=' || condeferred || ' validated=' || convalidated || '] ' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1;
SELECT 'policy ' || tablename || '.' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies WHERE schemaname = 'public' ORDER BY 1;
SELECT 'trigger ' || tgrelid::regclass::text || '.' || tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1;
SELECT 'function ' || oid::regprocedure::text || ' ' || md5(pg_get_functiondef(oid)) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f' ORDER BY 1;
SELECT 'grant ' || grantee || '.' || table_name || ':' || privilege_type FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee NOT IN ('postgres') ORDER BY 1;
SELECT 'rls ' || relname || ':' || relforcerowsecurity::text FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relrowsecurity ORDER BY 1;
