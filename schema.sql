create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  source text not null default 'messenger',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_message_at timestamptz,
  profile_pic_url text,
  locale text,
  timezone text,
  gender text,
  summary text,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customer_identities (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  provider text not null,
  provider_user_id text not null,
  display_name text,
  raw_profile jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_user_id)
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  provider text not null,
  provider_message_id text,
  direction text not null check (direction in ('inbound', 'outbound')),
  message_type text not null default 'text',
  text text,
  attachments jsonb not null default '[]',
  raw_event jsonb not null default '{}',
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(provider, provider_message_id)
);

create index if not exists idx_customer_identities_provider_user
  on customer_identities(provider, provider_user_id);

create index if not exists idx_messages_customer_sent_at
  on messages(customer_id, sent_at desc);

create index if not exists idx_customers_last_seen
  on customers(last_seen_at desc);

-- Required for Supabase Realtime browser updates.
-- Run this once if the messages table is not already enabled in Realtime.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
end $$;
