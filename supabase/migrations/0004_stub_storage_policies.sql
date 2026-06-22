-- Raise stub PNG size limit (print-ready exports can exceed 5 MB).
update storage.buckets
set file_size_limit = 15728640
where id = 'order-stubs';

-- Explicit storage policies for the service role (idempotent).
drop policy if exists "order_stubs_service_insert" on storage.objects;
drop policy if exists "order_stubs_service_select" on storage.objects;
drop policy if exists "order_stubs_service_update" on storage.objects;
drop policy if exists "order_stubs_service_delete" on storage.objects;

create policy "order_stubs_service_insert"
  on storage.objects for insert to service_role
  with check (bucket_id = 'order-stubs');

create policy "order_stubs_service_select"
  on storage.objects for select to service_role
  using (bucket_id = 'order-stubs');

create policy "order_stubs_service_update"
  on storage.objects for update to service_role
  using (bucket_id = 'order-stubs')
  with check (bucket_id = 'order-stubs');

create policy "order_stubs_service_delete"
  on storage.objects for delete to service_role
  using (bucket_id = 'order-stubs');
