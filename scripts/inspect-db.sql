-- =====================================================
-- ORACLE PARTY — DATABASE INSPECTION (read-only, safe)
-- Changes nothing. Just reports what actually exists.
-- Paste the whole file into the Supabase SQL Editor, press Run,
-- then copy the entire result and send it back.
-- =====================================================

select line from (

  select 1 as ord, '' as sub, '===== TABLES (with row estimates + RLS status) =====' as line
  union all
  select 2, c.relname,
         c.relname
         || '   RLS=' || case when c.relrowsecurity then 'ON' else 'OFF *** UNPROTECTED ***' end
         || '   ~rows=' || greatest(c.reltuples, 0)::bigint
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'

  union all
  select 3, '', ''
  union all
  select 4, '', '===== POLICIES (who is allowed to do what) ====='
  union all
  select 5, tablename || policyname,
         tablename || ' :: ' || policyname
         || '  [' || cmd || ']'
         || '  USING ' || coalesce(qual, '-')
         || '  CHECK ' || coalesce(with_check, '-')
    from pg_policies
   where schemaname = 'public'

  union all
  select 6, '', ''
  union all
  select 7, '', '===== SERVER FUNCTIONS ====='
  union all
  select 8, p.proname,
         p.proname || '(' || pg_get_function_arguments(p.oid) || ')'
         || case when p.prosecdef then '  [SECURITY DEFINER]' else '' end
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'

  union all
  select 9, '', ''
  union all
  select 10, '', '===== COLUMNS PER TABLE ====='
  union all
  select 11, t.table_name, t.table_name || ': ' || t.collist
    from (
      select table_name,
             string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as collist
        from information_schema.columns
       where table_schema = 'public'
       group by table_name
    ) t

  union all
  select 12, '', ''
  union all
  select 13, '', '===== REALTIME PUBLICATION (which tables broadcast live) ====='
  union all
  select 14, tablename, tablename
    from pg_publication_tables
   where pubname = 'supabase_realtime'

) report
order by ord, sub;
