-- Real Ticket Stubs — orders table.
-- Run this in your Supabase project: SQL Editor → paste → Run
-- (or `supabase db push` if you use the Supabase CLI).
--
-- The server writes here with the SERVICE ROLE key, which bypasses RLS. We keep
-- RLS ENABLED with no public policies so the table is NOT readable/writable by
-- the anon/public key — only your server can touch it.

create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  stripe_session_id  text not null unique,           -- idempotency key (one row per checkout)
  email              text not null default '',
  product_key        text not null default '',       -- 'mail' | 'framed'
  product_name       text not null default '',
  amount_total       integer,                         -- charged amount in cents
  currency           text not null default 'usd',
  ship_name          text not null default '',
  ship_line1         text not null default '',
  ship_line2         text not null default '',
  ship_city          text not null default '',
  ship_state         text not null default '',
  ship_postal_code   text not null default '',
  ship_country       text not null default '',
  ticket_artist      text not null default '',
  ticket_venue       text not null default '',
  ticket_datetime    text not null default '',
  address_status     text not null default 'unknown', -- deliverable | needs_review | check_error | unknown
  status             text not null default 'paid',    -- paid | shipped | refunded | cancelled
  created_at         timestamptz not null default now()
);

create index if not exists orders_email_idx       on public.orders (email);
create index if not exists orders_created_at_idx   on public.orders (created_at desc);
create index if not exists orders_status_idx       on public.orders (status);

-- Lock the table down: RLS on, no policies → only the service role can access it.
alter table public.orders enable row level security;
