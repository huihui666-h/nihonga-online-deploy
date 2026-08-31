-- 日本画 Archive：邮箱注册 / 登录会话表
--
-- 在 Supabase SQL Editor 中执行一次。此脚本只创建认证相关对象，
-- 不会读取、删除或修改 artists 中的现有数据。
-- API 使用 service_role key 访问这些表；RLS 保持开启且不添加 anon 策略。

create extension if not exists pgcrypto;

create table if not exists public.site_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  display_name text not null default '',
  status text not null default 'active',
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

-- Keep this migration usable if a partially-created table already exists.
alter table public.site_users add column if not exists email text;
alter table public.site_users add column if not exists password_hash text;
alter table public.site_users add column if not exists display_name text default '';
alter table public.site_users add column if not exists status text default 'active';
alter table public.site_users add column if not exists email_verified_at timestamptz;
alter table public.site_users add column if not exists created_at timestamptz default now();
alter table public.site_users add column if not exists updated_at timestamptz default now();
alter table public.site_users add column if not exists last_login_at timestamptz;

-- Email is normalized to lowercase by the API. The functional index also
-- protects against duplicates if a client bypasses that normalization.
create unique index if not exists site_users_email_lower_uidx
  on public.site_users (lower(email));

create table if not exists public.site_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.site_users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  user_agent text,
  ip_address text
);

alter table public.site_sessions add column if not exists user_id uuid;
alter table public.site_sessions add column if not exists token_hash text;
alter table public.site_sessions add column if not exists expires_at timestamptz;
alter table public.site_sessions add column if not exists created_at timestamptz default now();
alter table public.site_sessions add column if not exists last_seen_at timestamptz default now();
alter table public.site_sessions add column if not exists user_agent text;
alter table public.site_sessions add column if not exists ip_address text;

create unique index if not exists site_sessions_token_hash_uidx
  on public.site_sessions (token_hash);
create index if not exists site_sessions_user_id_idx
  on public.site_sessions (user_id);
create index if not exists site_sessions_expires_at_idx
  on public.site_sessions (expires_at);

-- The API's service role bypasses RLS. No public/anon policies are created,
-- so credentials and session hashes cannot be queried from the browser.
alter table public.site_users enable row level security;
alter table public.site_sessions enable row level security;

create or replace function public.touch_site_user_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists site_users_touch_updated_at on public.site_users;
create trigger site_users_touch_updated_at
before update on public.site_users
for each row execute function public.touch_site_user_updated_at();

comment on table public.site_users is
  'Email accounts for the Nihonga Archive. Passwords are scrypt hashes; never store plaintext.';
comment on table public.site_sessions is
  'Hashed HttpOnly session tokens. Raw tokens are only sent in the session cookie.';
comment on column public.site_sessions.user_agent is
  'Truncated request user-agent for session diagnostics; never used as an authenticator.';
comment on column public.site_sessions.ip_address is
  'Truncated forwarded client address for session diagnostics; never used as an authenticator.';
