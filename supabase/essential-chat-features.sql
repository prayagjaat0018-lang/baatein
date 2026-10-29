-- Baatein Essential Chat Features (incremental migration)
-- Run this file ONCE in Supabase SQL Editor AFTER the earlier Baatein setup steps.
-- Do NOT drop or recreate existing tables.

-- Message reply/edit metadata
alter table public.chat_messages
  add column if not exists reply_to bigint references public.chat_messages(id) on delete set null;
alter table public.chat_messages
  add column if not exists edited_at timestamptz;

-- Ensure read timestamp exists for online read receipts and unread counts.
alter table public.conversation_members
  add column if not exists last_read_at timestamptz not null default now();

-- Only the sender can edit their own messages.
drop policy if exists "sender edits own messages" on public.chat_messages;
create policy "sender edits own messages" on public.chat_messages
  for update to authenticated
  using (sender_id = auth.uid() and public.is_member(conversation_id))
  with check (sender_id = auth.uid() and public.is_member(conversation_id));

-- Only the sender can delete their own messages.
drop policy if exists "sender deletes own messages" on public.chat_messages;
create policy "sender deletes own messages" on public.chat_messages
  for delete to authenticated
  using (sender_id = auth.uid() and public.is_member(conversation_id));

-- Keep unread counts working if the function was not created in an earlier step.
create or replace function public.unread_counts()
returns table (conversation_id uuid, unread bigint)
language sql
security definer
stable
set search_path = public
as $$
  select m.conversation_id, count(c.id)
  from public.conversation_members m
  left join public.chat_messages c
    on c.conversation_id = m.conversation_id
   and c.created_at > m.last_read_at
   and c.sender_id <> auth.uid()
  where m.user_id = auth.uid()
  group by m.conversation_id;
$$;

create or replace function public.mark_read(cid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.conversation_members
  set last_read_at = now()
  where conversation_id = cid and user_id = auth.uid();
end;
$$;

revoke all on function public.unread_counts() from public;
revoke all on function public.mark_read(uuid) from public;
grant execute on function public.unread_counts() to authenticated;
grant execute on function public.mark_read(uuid) to authenticated;
