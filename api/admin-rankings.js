const {
  assertConfig,
  readBody,
  requireAdmin,
  sendJson,
  setCors,
  supabaseFetch
} = require("./_supabase");

const MAX_MANUAL_COUNT = 9999;

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!assertConfig(res) || !requireAdmin(req, res)) return;

  try {
    if (req.method === "GET") {
      const rankings = await getTodayRankings();
      sendJson(res, 200, { ok: true, date: todayInTokyo(), rankings });
      return;
    }

    if (req.method === "PATCH") {
      const body = await readBody(req);
      const artistId = String(body.artistId || "").trim();
      const count = Number.parseInt(body.count, 10);

      if (!artistId) {
        sendJson(res, 400, { ok: false, message: "缺少画家 id。" });
        return;
      }

      if (!Number.isFinite(count) || count < 0 || count > MAX_MANUAL_COUNT) {
        sendJson(res, 400, { ok: false, message: `点击量需在 0-${MAX_MANUAL_COUNT} 之间。` });
        return;
      }

      const today = todayInTokyo();
      await supabaseFetch(`artist_clicks?artist_id=eq.${encodeURIComponent(artistId)}&clicked_on=eq.${today}`, {
        method: "DELETE"
      });

      if (count > 0) {
        for (let start = 0; start < count; start += 500) {
          const size = Math.min(500, count - start);
          const rows = Array.from({ length: size }, () => ({
            artist_id: artistId,
            clicked_on: today
          }));
          await supabaseFetch("artist_clicks", {
            method: "POST",
            headers: { prefer: "return=minimal" },
            body: JSON.stringify(rows)
          });
        }
      }

      const rankings = await getTodayRankings();
      sendJson(res, 200, { ok: true, date: today, rankings });
      return;
    }

    sendJson(res, 405, { ok: false, message: "方法不支持。" });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "点击量管理失败。"
    });
  }
};

async function getTodayRankings() {
  const today = todayInTokyo();
  const clicks = await supabaseFetch(`artist_clicks?clicked_on=eq.${today}&select=artist_id&limit=20000`);
  const counts = new Map();
  clicks.forEach((row) => {
    counts.set(row.artist_id, (counts.get(row.artist_id) || 0) + 1);
  });

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50);

  if (!top.length) return [];

  const ids = top.map(([id]) => id);
  const artists = await supabaseFetch(`artists?id=in.(${ids.join(",")})&select=*`);
  const artistMap = new Map(artists.map((artist) => [artist.id, artist]));

  return top
    .map(([id, count]) => {
      const artist = artistMap.get(id);
      if (!artist) return null;
      return {
        id,
        count,
        name: artist.name || "",
        handle: artist.handle || "",
        school: artist.school || "",
        instagram: artist.instagram || ""
      };
    })
    .filter(Boolean);
}

function todayInTokyo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
