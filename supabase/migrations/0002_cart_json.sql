-- Add cart line items to orders (multi-product checkout).
alter table public.orders
  add column if not exists cart_json text not null default '';
