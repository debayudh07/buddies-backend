-- Enable RLS + revoke Data API access for app roles (defense in depth).
-- Prisma / service-role connection continue to bypass or use superuser-style access.
-- Apply after: npx prisma db push

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
    -- No permissive policies → default deny for RLS roles without BYPASSRLS
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', r.tablename);
  END LOOP;
END $$;

-- Future tables created by the same owners stay denied by default for API roles
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- Comments for operators
COMMENT ON SCHEMA public IS
  'Domain tables owned by Prisma. RLS enabled; anon/authenticated should not have table grants.';
