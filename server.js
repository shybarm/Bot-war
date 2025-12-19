async function getGeneralNews(limit = 8) {
  // Safer, NewsData-friendly query (avoid parentheses/complex boolean)
  // Goal: non-finance headlines that still move markets.
  const queryTerms = [
    "oil",
    "opec",
    "inflation",
    "rates",
    "fed",
    "sanctions",
    "war",
    "shipping",
    "supply chain",
    "chip",
    "semiconductor",
    "ai",
    "cybersecurity",
    "outage",
    "strike",
    "election",
    "regulation",
  ];

  // NewsData accepts a plain q string; keep it simple and broad.
  const q = queryTerms.join(" OR ");

  // 1) NewsData.io (primary)
  if (NEWSDATA_KEY) {
    try {
      const url =
        `https://newsdata.io/api/1/news?` +
        `apikey=${encodeURIComponent(NEWSDATA_KEY)}` +
        `&q=${encodeURIComponent(q)}` +
        `&language=en` +
        `&category=top`; // helps NewsData return something consistently

      const r = await fetch(url, { timeout: 15000 });
      const parsed = await safeJson(r);

      if (parsed.ok && Array.isArray(parsed.json?.results)) {
        const raw = parsed.json.results.map((a) => ({
          title: a.title || "",
          url: a.link || "",
          source: a.source_id || "newsdata",
          publishedAt: a.pubDate || "",
          summary: a.description || "",
        }));

        const items = raw
          .filter((a) => a.title)
          .filter((a) => !looksTooFinancey(a))
          .slice(0, limit);

        if (items.length) return { provider: "newsdata", items };

        // If NewsData returns only financey items, still return something (don’t go mock immediately)
        const fallbackItems = raw.filter((a) => a.title).slice(0, limit);
        if (fallbackItems.length) return { provider: "newsdata", items: fallbackItems };
      }

      // If API responded but no results
      // fall through to backup
    } catch {}
  }

  // 2) NewsAPI.org (backup)
  if (NEWSAPI_KEY) {
    try {
      const url =
        `https://newsapi.org/v2/top-headlines?` +
        `language=en&pageSize=${Math.min(limit * 2, 20)}`;

      const r = await fetch(url, {
        timeout: 15000,
        headers: { "X-Api-Key": NEWSAPI_KEY },
      });

      const parsed = await safeJson(r);
      if (parsed.ok && Array.isArray(parsed.json?.articles)) {
        const items = parsed.json.articles
          .map((a) => ({
            title: a.title || "",
            url: a.url || "",
            source: a.source?.name || "newsapi",
            publishedAt: a.publishedAt || "",
            summary: a.description || "",
          }))
          .filter((a) => a.title)
          .filter((a) => !looksTooFinancey(a))
          .slice(0, limit);

        if (items.length) return { provider: "newsapi", items };
      }
    } catch {}
  }

  // 3) Mock fallback (never empty)
  const items = Array.from({ length: Math.min(limit, 8) }).map((_, i) => ({
    title: `Demo headline #${i + 1} (enable NEWS_API_KEY for real headlines)`,
    url: "#",
    source: "mock",
    publishedAt: new Date().toISOString(),
    summary:
      "Demo mode is active. Add NEWS_API_KEY (NewsData.io) in Railway to fetch real headlines.",
  }));

  return { provider: "mock", items };
}
