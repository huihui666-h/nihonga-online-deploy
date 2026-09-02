-- Homepage HUI LOG / update records.
-- Run once in the Supabase SQL Editor. It is safe to run again.

create extension if not exists pgcrypto;

create table if not exists public.site_updates (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 160),
  body text not null default '' check (char_length(body) <= 500),
  published_on date not null default current_date,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists site_updates_status_date_idx
  on public.site_updates (status, published_on desc, created_at desc);

create or replace function public.touch_site_updates_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists site_updates_touch_updated_at on public.site_updates;
create trigger site_updates_touch_updated_at
before update on public.site_updates
for each row execute function public.touch_site_updates_updated_at();

alter table public.site_updates enable row level security;

-- Seed the three records previously embedded in the homepage, but only when
-- the table has no content. Public access still goes through the server API.
insert into public.site_updates (id, title, body, published_on, status)
select seed.id, seed.title, seed.body, seed.published_on, seed.status
from (values
  ('00000000-0000-4000-8000-000000000901'::uuid, 'NIHONGA NOW を公開', '展覧会、公募、作家動向を集める日本画ニュース欄を追加。', '2026-09-01'::date, 'published'),
  ('00000000-0000-4000-8000-000000000831'::uuid, '最近追加された作家を整理', '追加日がある作家は新しい順に。未設定でも案内を保って表示。', '2026-08-31'::date, 'published'),
  ('00000000-0000-4000-8000-000000000830'::uuid, '検索を入口に', '作家名、学校、地域、キーワードから日本画家を探せます。', '2026-08-30'::date, 'published')
) as seed(id, title, body, published_on, status)
where not exists (select 1 from public.site_updates)
on conflict (id) do nothing;

comment on table public.site_updates is
  'Short editorial update records shown in the homepage HUI LOG. Managed only through authenticated server endpoints.';
