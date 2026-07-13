-- Multi-seat orders: one print PNG + field set per ticket.
-- Run after 0004_stub_storage_policies.sql.

alter table public.orders
  add column if not exists stub_tickets jsonb not null default '[]';

comment on column public.orders.stub_tickets is
  'Array of {index, seat, row, section, stub_fields, stub_png_path} — one entry per seat.';
