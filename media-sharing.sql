-- Baatein Media Sharing + Voice Notes
-- Run ONCE in Supabase SQL Editor after your existing Baatein setup.
-- Does not drop or recreate existing tables.

alter table public.chat_messages add column if not exists attachment_path text;
alter table public.chat_messages add column if not exists attachment_name text;
alter table public.chat_messages add column if not exists attachment_mime text;
alter table public.chat_messages add column if not exists attachment_size bigint;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media', 'chat-media', false, 20971520,
  array['image/jpeg','image/png','image/gif','image/webp','image/heic','video/mp4','video/webm','video/quicktime','audio/webm','audio/ogg','audio/mp4','audio/mpeg','application/pdf','text/plain','application/zip','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation']
)
on conflict (id) do update set public = false, file_size_limit = 20971520;

-- Object path format: conversation UUID / uploader user UUID / unique filename.
-- Access is limited to authenticated members of the conversation.
drop policy if exists "chat media members can read" on storage.objects;
create policy "chat media members can read" on storage.objects
for select to authenticated
using (
  bucket_id = 'chat-media'
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and public.is_member(((storage.foldername(name))[1])::uuid)
);

drop policy if exists "chat media members can upload own folder" on storage.objects;
create policy "chat media members can upload own folder" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'chat-media'
  and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
  and (storage.foldername(name))[2] = auth.uid()::text
  and public.is_member(((storage.foldername(name))[1])::uuid)
);
