-- Migration: create read-only role for Grafana dashboard access
-- 2026-05-18: Grafana installed on forge (http://100.113.167.50:3001) needs
-- a Postgres datasource. Service-role would over-grant; this role gets
-- SELECT-only access to the ledger schema + nothing else.
--
-- Apply: in Supabase SQL Editor.
-- IDEMPOTENT.

-- Create the role if not exists. Set a strong password.
-- IMPORTANT: replace [REPLACE_WITH_STRONG_PASSWORD] with the actual password
-- before running. Then put the password in proxy/secrets and into Grafana's
-- datasource config.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
        CREATE ROLE grafana_reader WITH LOGIN PASSWORD '[REPLACE_WITH_STRONG_PASSWORD]';
    END IF;
END $$;

-- Grant connect on the database
GRANT CONNECT ON DATABASE postgres TO grafana_reader;

-- Grant usage on the ledger schema
GRANT USAGE ON SCHEMA ledger TO grafana_reader;

-- Grant SELECT on all current tables in the ledger schema
GRANT SELECT ON ALL TABLES IN SCHEMA ledger TO grafana_reader;

-- And on tables created in the future
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger
    GRANT SELECT ON TABLES TO grafana_reader;

-- Also grant SELECT on the chain-verification function (read-only by nature)
-- Note: verify_chain is a function, not a table. EXECUTE is what's needed.
GRANT EXECUTE ON FUNCTION ledger.verify_chain TO grafana_reader;

-- ────────────────────────────────────────────────────────────────────────
-- What grafana_reader CAN do:
--   - Connect to the database
--   - SELECT from any ledger.* table (now or future)
--   - EXECUTE ledger.verify_chain() for chain-integrity panel
--
-- What grafana_reader CANNOT do:
--   - INSERT / UPDATE / DELETE anywhere
--   - Access any other schema (public, auth, storage, etc.)
--   - Execute any other function
--   - Create / alter any object
--
-- ────────────────────────────────────────────────────────────────────────
-- Grafana datasource config (Supabase project Settings → Database):
--   Host: db.[project-ref].supabase.co  (or pooler.supabase.com for transaction-mode pooler)
--   Port: 5432 (direct) or 6543 (pooler)
--   Database: postgres
--   User: grafana_reader
--   Password: [the password you set above]
--   SSL: require
--
-- Use the direct connection for Grafana (better for analytical queries).
-- ────────────────────────────────────────────────────────────────────────
