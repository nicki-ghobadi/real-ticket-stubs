-- Pending checkout drafts, full stub fields, and print PNG storage.
-- Run in Supabase SQL Editor after 0001_orders.sql and 0002_cart_json.sql.

-- Pending orders are created before Stripe redirect (no session id yet).
alter table public.orders
  alter column stripe_session_id drop not null;

alter table public.orders
  add column if not exists stub_fields jsonb not null default '{}',
  add column if not exists stub_png_path text not null default '',
  add column if not exists stripe_payment_intent text not null default '',
  add column if not exists owner_notified_at timestamptz;

alter table public.orders drop constraint if exists orders_stripe_session_id_key;

create unique index if not exists orders_stripe_session_id_unique
  on public.orders (stripe_session_id)
  where stripe_session_id is not null and stripe_session_id <> '';

create index if not exists orders_status_idx on public.orders (status);

-- Private bucket for print-ready stub PNGs (server uploads via service role).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'order-stubs',
  'order-stubs',
  false,
  5242880,
  array['image/png']
)
on conflict (id) do nothing;
