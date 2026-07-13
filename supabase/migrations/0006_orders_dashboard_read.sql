-- Allow logged-in Supabase Dashboard users to read orders in Table Editor.
-- The service role (server) already bypasses RLS; this fixes empty Table Editor
-- views when RLS is enabled with no SELECT policies.
--
-- Run in SQL Editor if orders exist via API but Table Editor shows 0 rows.

create policy "orders_select_authenticated"
  on public.orders
  for select
  to authenticated
  using (true);
