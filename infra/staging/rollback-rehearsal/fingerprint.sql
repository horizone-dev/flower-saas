-- Deterministic fingerprint of ONE database (run as the superuser, output is a TSV; compare two files with diff).
--   T <table>   <row count>  <md5 of every row, ordered by its text form>     one line per public base table
--   S <aspect>  <count>      <md5 over the aspect>                             schema: columns, indexes, constraints, policies, triggers, functions, grants
-- Reads only. Nothing here depends on OIDs, so a restored copy of a database must produce byte-identical output.
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\t'
SELECT 'T', t.table_name,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t.table_name), false, true, '')))[1]::text,
       md5(query_to_xml(format('select * from public.%I x order by x::text', t.table_name), false, false, '')::text)
  FROM information_schema.tables t
 WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
 ORDER BY t.table_name;
SELECT 'S', 'columns', count(*)::text,
       md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, ''), '|' ORDER BY table_name, column_name))
  FROM information_schema.columns WHERE table_schema = 'public';
SELECT 'S', 'indexes', count(*)::text, md5(string_agg(indexdef, '|' ORDER BY indexname)) FROM pg_indexes WHERE schemaname = 'public';
SELECT 'S', 'constraints', count(*)::text,
       md5(string_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid), '|' ORDER BY conrelid::regclass::text, conname))
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace;
SELECT 'S', 'policies', count(*)::text,
       md5(string_agg(tablename || '.' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, ''), '|' ORDER BY tablename, policyname))
  FROM pg_policies WHERE schemaname = 'public';
SELECT 'S', 'triggers', count(*)::text, md5(string_agg(tgrelid::regclass::text || '.' || tgname, '|' ORDER BY tgrelid::regclass::text, tgname))
  FROM pg_trigger WHERE NOT tgisinternal;
SELECT 'S', 'functions', count(*)::text, md5(string_agg(pg_get_functiondef(oid), '|' ORDER BY proname, oid::regprocedure::text))
  FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
SELECT 'S', 'grants', count(*)::text,
       md5(string_agg(grantee || '.' || table_name || ':' || privilege_type, '|' ORDER BY grantee, table_name, privilege_type))
  FROM information_schema.role_table_grants WHERE table_schema = 'public' AND grantee NOT IN ('postgres');
SELECT 'S', 'rls_enabled', count(*)::text, md5(string_agg(relname || ':' || relforcerowsecurity::text, '|' ORDER BY relname))
  FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relrowsecurity;
