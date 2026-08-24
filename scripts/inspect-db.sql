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

  -- FOREIGN KEYS, and specifically what each one does on DELETE.
  --
  -- This is here because it has had to be measured by hand twice, both times
  -- after a bug that made no sense without it. game_plays cascaded from BOTH
  -- rooms and players, so every play record was destroyed seconds after it was
  -- written and the table read 0 rows while everything in the counting path was
  -- correct (CLAUDE.md #9). And whether answers.player_id cascades decides
  -- whether a rejoining player's score can be recovered at all — if it does,
  -- there is nothing left to reassign and that promise was never kept.
  --
  -- The automated probe cannot answer this: PostgREST's OpenAPI output for this
  -- project carries no foreign-key annotations, so it honestly reports that it
  -- cannot tell. This is the only place the answer is available.
  union all
  select 12, '', ''
  union all
  select 13, '', '===== FOREIGN KEYS (c=CASCADE  n=SET NULL  a=NO ACTION  r=RESTRICT) ====='
  union all
  select 14, con.conname,
         src.relname || '.' || att.attname
         || ' -> ' || tgt.relname
         || '   ON DELETE ' ||
         case con.confdeltype
           when 'c' then 'CASCADE  *** rows die with the parent ***'
           when 'n' then 'SET NULL'
           when 'd' then 'SET DEFAULT'
           when 'r' then 'RESTRICT'
           else 'NO ACTION'
         end
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_namespace n2 on n2.oid = src.relnamespace
    join unnest(con.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
   where con.contype = 'f' and n2.nspname = 'public'

  union all
  select 15, '', ''
  union all
  select 16, '', '===== REALTIME PUBLICATION (which tables broadcast live) ====='
  union all
  select 17, tablename, tablename
    from pg_publication_tables
   where pubname = 'supabase_realtime'

) report
order by ord, sub;
