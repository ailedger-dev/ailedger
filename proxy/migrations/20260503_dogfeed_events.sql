-- Dogfeed sidecar event store (ai-4vp / ADR-015).
--
-- Bob's Claude Code sessions queue usage telemetry locally and drain it to
-- POST /v1/events; that endpoint appends rows here. This is the AILedger
-- dogfood signal — completely decoupled from the inference proxy path so
-- a sidecar outage cannot affect Bob's request SLO.

create table if not exists ledger.dogfeed_events (
    id              bigserial primary key,
    received_at     timestamptz not null default now(),
    tenant_id       uuid        not null references auth.users(id),
    event_id        uuid        not null,
    ts              timestamptz not null,
    model           text        not null,
    input_tokens    int         not null check (input_tokens  >= 0),
    output_tokens   int         not null check (output_tokens >= 0),
    latency_ms      int         not null check (latency_ms    >= 0),
    tool_name       text,
    source          text        not null
);

-- Dedupe at the storage layer too: KV is the fast path, this is the durable
-- backstop for races where a retry slips past KV between check and write.
create unique index if not exists dogfeed_events_tenant_event_uniq
    on ledger.dogfeed_events (tenant_id, event_id);

-- Read-by-tenant in time order is the only query we expect.
create index if not exists dogfeed_events_tenant_ts_idx
    on ledger.dogfeed_events (tenant_id, ts desc);

alter table ledger.dogfeed_events enable row level security;
alter table ledger.dogfeed_events force row level security;

create policy "tenants read own dogfeed events"
    on ledger.dogfeed_events
    for select
    using (tenant_id = auth.uid());

revoke update, delete on ledger.dogfeed_events from anon, authenticated;

grant select on ledger.dogfeed_events to anon, authenticated;
grant all privileges on ledger.dogfeed_events to postgres, authenticator, service_role;
grant all privileges on sequence ledger.dogfeed_events_id_seq to postgres, authenticator, service_role;
