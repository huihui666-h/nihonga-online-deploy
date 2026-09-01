-- Nihonga Now MVP
--
-- Run once in the Supabase SQL Editor before `npm run crawl:news -- --write`.
-- This migration only creates news-specific tables and indexes. It does not
-- alter public.artists or any authentication table.

create extension if not exists pgcrypto;

create table if not exists public.news (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text not null default '',
  category text not null check (category in ('exhibition', 'open_call', 'artist_news', 'museum', 'nihonga_news')),
  source_name text not null,
  source_url text not null,
  source_item_id text not null default '',
  content_fingerprint text not null default '',
  published_at date,
  start_date date,
  end_date date,
  venue text not null default '',
  image_url text not null default '',
  raw_artist_names jsonb not null default '[]'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  relevance_score numeric(4,3),
  status text not null default 'candidate' check (status in ('candidate', 'published', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint news_source_url_unique unique (source_url),
  constraint news_date_range_valid check (end_date is null or start_date is null or end_date >= start_date),
  constraint news_relevance_score_valid check (relevance_score is null or (relevance_score >= 0 and relevance_score <= 1))
);

create index if not exists news_status_date_idx
  on public.news (status, start_date desc, published_at desc, created_at desc);
create index if not exists news_source_item_idx
  on public.news (source_name, source_item_id);

-- The partial index keeps concurrent batches from inserting the same
-- normalized title/date candidate while leaving legacy blank rows untouched.
alter table public.news
  add column if not exists content_fingerprint text not null default '';
create unique index if not exists news_content_fingerprint_uq
  on public.news (content_fingerprint)
  where content_fingerprint <> '';

create table if not exists public.news_artists (
  news_id uuid not null references public.news(id) on delete cascade,
  artist_id uuid not null references public.artists(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (news_id, artist_id)
);

create index if not exists news_artists_artist_id_idx on public.news_artists (artist_id);

create or replace function public.touch_news_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists news_touch_updated_at on public.news;
create trigger news_touch_updated_at
before update on public.news
for each row execute function public.touch_news_updated_at();

-- The service-role API is the only database client in this MVP. No public
-- policies are added, so crawler reports and candidate rows stay private.
alter table public.news enable row level security;
alter table public.news_artists enable row level security;

comment on table public.news is
  'Compact official-source news records for Nihonga Now. Third-party full text is not stored.';
comment on table public.news_artists is
  'High-confidence links from Nihonga Now records to existing artists.';
