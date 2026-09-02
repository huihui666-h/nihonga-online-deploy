const { assertConfig, canonicalInstagramUrl, rateLimit, sendJson, setCors, supabaseFetch } = require("./_supabase");

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!rateLimit(req, res, { limit: 120, windowMs: 60_000, keyPrefix: "rankings" })) return;

  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, message: "方法不支持。" });
    return;
  }

  if (!assertConfig(res)) return;

  try {
    const today = todayInTokyo();
    const clicks = await supabaseFetch(`artist_clicks?clicked_on=eq.${today}&select=artist_id&limit=20000`);
    const counts = new Map();
    clicks.forEach((row) => {
      counts.set(row.artist_id, (counts.get(row.artist_id) || 0) + 1);
    });

    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    if (!top.length) {
      sendJson(res, 200, { ok: true, date: today, rankings: [] });
      return;
    }

    const ids = top.map(([id]) => id);
    const artists = await supabaseFetch(`artists?id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})&select=*`);
    const artistMap = new Map(artists.map((artist) => [artist.id, artist]));

    const rankings = top
      .map(([id, count]) => {
        const artist = artistMap.get(id);
        if (!artist) return null;
        return {
          id,
          count,
          name: artist.name || "",
          handle: artist.handle || "",
          instagram: canonicalInstagramUrl(artist.instagram || artist.handle)
        };
      })
      .filter(Boolean);

    sendJson(res, 200, { ok: true, date: today, rankings });
  } catch (error) {
    sendJson(res, error.status || 500, {
      ok: false,
      message: error.message || "读取今日排名失败。"
    });
  }
};

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
