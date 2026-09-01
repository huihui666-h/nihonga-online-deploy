# Nihonga Online deployment log / 部署记录

## Nihonga Now MVP - 2026-09-01

- Added an independent trusted-source news crawler for 日本美術院, 日展, and 山種美術館 official pages.
- Added strict AI metadata processing, deterministic publication rules, URL/title deduplication, conservative Artist matching, and non-destructive expiry handling.
- Added the Supabase `news` and `news_artists` migration script.
- Added the homepage `03 / NIHONGA NOW` preview and the standalone `/news` page.
- Added local commands, tests, and operating documentation.
- Image capture remains disabled for the MVP; crawler excerpts remain local processor input and are not published as summaries.

Deployment status: frontend and API deployed to production on 2026-09-01.

- Production deployment: `dpl_41bJQZJLuNC4S1Qntp92TV825NHQ`
- Production URL: `https://nihonga-online-deploy.vercel.app`
- Verified: `/`, `/admin`, `/news`, `/api/artists`, and `/api/rankings` return HTTP 200.
- Completed: ran `seed/nihonga-now-news.sql` in the production Supabase SQL Editor
  on 2026-09-01. The migration created `public.news`, `public.news_artists`,
  indexes, the update trigger, and row-level security without inserting rows.
- Verified after migration: `/api/news?limit=3` returns HTTP 200 with the expected
  empty-list payload, and `/news` returns HTTP 200 with its empty state.
