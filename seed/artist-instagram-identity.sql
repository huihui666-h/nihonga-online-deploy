-- Durable duplicate guard for crawler and admin writes.
--
-- The public Artist columns are intentionally unchanged.  New crawler rows
-- are normalized to an @handle before insertion, so this expression index
-- makes concurrent requests for the same Instagram username conflict at the
-- database boundary.  Placeholder values such as "IG 待补" are excluded.
-- Run the preflight query first; resolve any reported duplicates before the
-- CREATE UNIQUE INDEX statement.

-- Preflight: this must return zero rows before the unique index is created.
select
  lower(regexp_replace(btrim(handle), '^@', '')) as instagram_handle_key,
  count(*) as row_count,
  array_agg(id order by id) as artist_ids
from public.artists
where btrim(handle) ~* '^@?[a-z0-9._]{1,30}$'
group by 1
having count(*) > 1;

-- Preflight for rows that carry a canonical profile URL but no usable handle.
select
  lower(regexp_replace(btrim(instagram), '/+$', '')) as instagram_url_key,
  count(*) as row_count,
  array_agg(id order by id) as artist_ids
from public.artists
where btrim(instagram) ~* '^https?://(?:www\.)?instagram\.com/[a-z0-9._]{1,30}/?$'
group by 1
having count(*) > 1;

create unique index if not exists artists_instagram_handle_key_uq
  on public.artists (lower(regexp_replace(btrim(handle), '^@', '')))
  where btrim(handle) ~* '^@?[a-z0-9._]{1,30}$';

create unique index if not exists artists_instagram_url_key_uq
  on public.artists (lower(regexp_replace(btrim(instagram), '/+$', '')))
  where btrim(instagram) ~* '^https?://(?:www\.)?instagram\.com/[a-z0-9._]{1,30}/?$';

comment on index public.artists_instagram_handle_key_uq is
  'Case-insensitive Instagram handle identity; crawler/admin writes must use canonical @handle values.';

comment on index public.artists_instagram_url_key_uq is
  'Case-insensitive canonical Instagram profile URL identity for legacy rows with a missing handle.';
