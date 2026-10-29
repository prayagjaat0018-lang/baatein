-- Baatein Step 5: Status (24 ghante wala) - Supabase SQL Editor me ek baar chalana hai

-- 1) Kya main aur "other" kisi chat me saath hain?
create or replace function public.shares_chat(other uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.conversation_members a
    join public.conversation_members b on a.conversation_id = b.conversation_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- 2) Statuses
create table if not exists public.statuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('text', 'image')),
  text text,
  bg text,
  image_path text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint status_content check (
    (kind = 'text' and text is not null and char_length(text) between 1 and 200)
    or (kind = 'image' and image_path is not null and (text is null or char_length(text) <= 200))
  )
);
create index if not exists statuses_user_idx on public.statuses (user_id, created_at);
alter table public.statuses enable row level security;

drop policy if exists "see own and chat-friends statuses" on public.statuses;
create policy "see own and chat-friends statuses" on public.statuses
  for select to authenticated
  using (expires_at > now() and (user_id = auth.uid() or public.shares_chat(user_id)));

drop policy if exists "post own status" on public.statuses;
create policy "post own status" on public.statuses
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "delete own status" on public.statuses;
create policy "delete own status" on public.statuses
  for delete to authenticated using (user_id = auth.uid());

-- 3) Kisne dekha
create table if not exists public.status_views (
  status_id uuid not null references public.statuses(id) on delete cascade,
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (status_id, viewer_id)
);
alter table public.status_views enable row level security;

drop policy if exists "owner or viewer sees views" on public.status_views;
create policy "owner or viewer sees views" on public.status_views
  for select to authenticated
  using (
    viewer_id = auth.uid()
    or exists (select 1 from public.statuses s where s.id = status_id and s.user_id = auth.uid())
  );

drop policy if exists "mark my view" on public.status_views;
create policy "mark my view" on public.status_views
  for insert to authenticated
  with check (
    viewer_id = auth.uid()
    and exists (select 1 from public.statuses s where s.id = status_id)
  );

-- 4) Photos ke liye private storage (max 5 MB, sirf images)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('status', 'status', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "upload own status photo" on storage.objects;
create policy "upload own status photo" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'status' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "see own status photo" on storage.objects;
create policy "see own status photo" on storage.objects
  for select to authenticated
  using (bucket_id = 'status' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "see visible status photo" on storage.objects;
create policy "see visible status photo" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'status'
    and exists (select 1 from public.statuses s where s.image_path = name)
  );

drop policy if exists "delete own status photo" on storage.objects;
create policy "delete own status photo" on storage.objects
  for delete to authenticated
  using (bucket_id = 'status' and (storage.foldername(name))[1] = auth.uid()::text);


-- Baatein Calling: call history table. Run in Supabase SQL Editor.
create table if not exists public.call_history (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  started_by uuid not null references public.profiles(id) on delete cascade,
  call_type text not null check (call_type in ('audio','video')),
  call_scope text not null check (call_scope in ('one_to_one','group')),
  outcome text not null default 'started' check (outcome in ('started','ended','missed','rejected')),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists call_history_conversation_idx on public.call_history(conversation_id, started_at desc);
alter table public.call_history enable row level security;
drop policy if exists "members can read call history" on public.call_history;
create policy "members can read call history" on public.call_history for select to authenticated
using (exists (select 1 from public.conversation_members cm where cm.conversation_id = call_history.conversation_id and cm.user_id = auth.uid()));
drop policy if exists "members can create call history" on public.call_history;
create policy "members can create call history" on public.call_history for insert to authenticated
with check (started_by = auth.uid() and exists (select 1 from public.conversation_members cm where cm.conversation_id = call_history.conversation_id and cm.user_id = auth.uid()));
drop policy if exists "members can update call history" on public.call_history;
create policy "members can update call history" on public.call_history for update to authenticated
using (exists (select 1 from public.conversation_members cm where cm.conversation_id = call_history.conversation_id and cm.user_id = auth.uid()))
with check (exists (select 1 from public.conversation_members cm where cm.conversation_id = call_history.conversation_id and cm.user_id = auth.uid()));
