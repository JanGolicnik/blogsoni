import Parser from "rss-parser";
const parser = new Parser();
import webpush from "web-push";
import { fetch_favicon } from "./favicons.js";
import { db } from "./db.js";

webpush.setVapidDetails(
  "mailto:jan@nejka.net",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
);

const COMMON_FEED_PATHS = [
  "/feed",
  "/feed/",
  "/rss",
  "/rss/",
  "/feed.xml",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feeds/posts/default",
  "/?feed=rss2",
];

const link_re =
  /<link\b[^>]*?(?:rel=["']alternate["'][^>]*?type=["']application\/(?:rss|atom)\+xml["']|type=["']application\/(?:rss|atom)\+xml["'][^>]*?rel=["']alternate["'])[^>]*?href=["']([^"']+)["']/gi;
const simple_re =
  /<link\b[^>]*?type=["']application\/(?:rss|atom)\+xml["'][^>]*?href=["']([^"']+)["']/gi;
const href_first_re =
  /<link\b[^>]*?href=["']([^"']+)["'][^>]*?type=["']application\/(?:rss|atom)\+xml["']/gi;

async function fetch_url(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "blogson/1.0 (jan@nejka.net)" },
      signal: AbortSignal.timeout(3000),
      redirect: "follow",
    });
    if (!res.ok) return { error: `Server returned ${res.status}` };
    return { content: await res.arrayBuffer(), resolved: res.url };
  } catch (e) {
    return { error: `Fetch failed (${e.message})` };
  }
}

async function parseFeed(content) {
  try {
    return await parser.parseString(Buffer.from(content).toString("utf8"));
  } catch (e) {
    return null;
  }
}

async function discover_feed(url, content) {
  const html = Buffer.from(content).toString("utf8");
  if (await parseFeed(content)) return { resolved: url };

  for (const re of [link_re, simple_re, href_first_re]) {
    re.lastIndex = 0;
    const m = re.exec(html);
    if (!m) continue;
    const { error, content, resolved } = await fetch_url(
      new URL(m[1], url).href,
    );
    if (error) continue;
    if (await parseFeed(content)) return { resolved };
  }

  const root = new URL(url).origin;
  for (const path of COMMON_FEED_PATHS) {
    const { error, content, resolved } = await fetch_url(root + path);
    if (error) continue;
    if (await parseFeed(content)) return { resolved };
  }

  return { error: "No feed found" };
}

async function validate_feed(url, skip_parse) {
  if (!url) return { error: "Url is required" };
  if (!url.startsWith("http://") && !url.startsWith("https://"))
    return { error: "URL must start with http:// or https://" };

  let { error, content, resolved } = await fetch_url(url);
  if (error) return { error };

  if (skip_parse) return { resolved };
  return await discover_feed(resolved, content);
}

function normalize_url(url) {
  const p = new URL(url.trim());
  const host = p.hostname.replace(/^www\./, "");
  const path = p.pathname.replace(/\/+$/, "") || "/";
  return host + path;
}
async function find_url_on_hn(url) {
  const normalized = normalize_url(url);
  const q = new URLSearchParams({
    query: url,
    restrictSearchableAttributes: "url",
    tags: "story",
    hitsPerPage: 100,
  });
  try {
    const res = await fetch(`https://hn.algolia.com/api/v1/search?${q}`);
    const data = await res.json();
    const hit = (data.hits ?? []).find(
      (h) => h.url && normalize_url(h.url) === normalized,
    );
    return hit ? `https://news.ycombinator.com/item?id=${hit.objectID}` : null;
  } catch {
    return null;
  }
}

async function find_url_on_lobste(url) {
  const q = new URLSearchParams({ url });
  try {
    const res = await fetch(`https://lobste.rs/stories/url/all.json?${q}`, {
      headers: { "User-Agent": "blogson/1.0 (jan@nejka.net)" },
    });
    const data = await res.json();
    return data[0]?.comments_url ?? data[0]?.short_id_url ?? null;
  } catch {
    return null;
  }
}

async function poll_feed(id, url, poll_favicon) {
  const { error, content, resolved } = await fetch_url(url);
  if (error) return { error };
  url = resolved;
  const feed = await parseFeed(content);
  if (!feed) return;

  let updates = {};
  if (feed.title) updates.title = feed.title;
  if (feed.description) updates.description = feed.description;

  if (poll_favicon) {
    const favicon = await fetch_favicon(url) ?? {
      favicon_mime: "",
      favicon_data: "",
      favicon_color1: '0, 0, 0',
    };
    if (favicon) updates = { ...updates, ...favicon };
  }

  if (Object.keys(updates).length > 0) {
    const set = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    db.query(`UPDATE feeds SET ${set} WHERE id = ?`).run(
      ...Object.values(updates),
      id,
    );
  }

  const all_inserted = [];
  for (const item of feed.items) {
    const url = item.link;
    if (!url) continue;
    const title = item.title ?? url;
    const date = item.isoDate
      ? new Date(item.isoDate).toISOString()
      : new Date().toISOString();
    const author = item.author?.trim() || null;
    const tags =
      item.categories?.length > 0 ? item.categories.join(", ") : null;

    const inserted = db
      .query(
        `
      INSERT OR IGNORE INTO entries (feed_id, url, title, date, author, tags)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id, title
    `,
      )
      .get(id, url, title, date, author, tags);
    if (inserted) all_inserted.push({ ...inserted, feed: feed.title });
  }

  const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .query(
      `
    SELECT id, url, hn_url, lobste_url FROM entries
    WHERE feed_id = ? AND (hn_url IS NULL OR lobste_url IS NULL) AND date > ?
    ORDER BY date DESC LIMIT 25
  `,
    )
    .all(id, cutoff);

  for (const row of rows) {
    const hn_url = row.hn_url ?? (await find_url_on_hn(row.url));
    const lobste_url = row.lobste_url ?? (await find_url_on_lobste(row.url));
    db.query("UPDATE entries SET hn_url = ?, lobste_url = ? WHERE id = ?").run(
      hn_url,
      lobste_url,
      row.id,
    );
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`finished polling feed ${id}`);

  return all_inserted;
}

async function sendNotification(data) {
  console.log(`sending notification about ${data}`);
  db.query(`SELECT * FROM subscriptions`)
    .all()
    .forEach(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth },
          },
          data,
        );
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          db.query("DELETE FROM subscriptions WHERE endpoint = ?").run(
            s.endpoint,
          );
        } else {
          console.log(err);
        }
      }
    });
}

let index = 1;
export async function poll_all() {
  const start = Date.now();

  const all_inserted = [];

  const feeds = db
    .query("SELECT id, url FROM feeds WHERE is_bookmark = 0")
    .all();

  const poll_favicon = index++ % 10 === 0;
  for (let i = 0; i < feeds.length; i += 5) {
    const batch = feeds.slice(i, i + 5);
    all_inserted.push(
      ...(
        await Promise.all(
          batch.map((feed) => poll_feed(feed.id, feed.url, poll_favicon)),
        )
      )
        .filter(Array.isArray)
        .flat(),
    );
  }

  const interval = process.env.POLL_INTERVAL / all_inserted.length;
  all_inserted.forEach((entry, i) => {
    setTimeout(
      () =>
        sendNotification(
          JSON.stringify({
            title: entry.feed,
            body: entry.title,
            url: `/go/?entry_id=${entry.id}`,
          }),
        ),
      interval * i * 1000,
    );
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`polled ${feeds.length} feeds in ${elapsed} seconds`);
}

async function insert_feed(url, bookmark, user_id) {
  try {
    db.query(
      "INSERT INTO feeds (url, is_bookmark, added_by) VALUES (?, ?, ?)",
    ).run(url, bookmark ? 1 : 0, user_id);
  } catch (e) {
    return e.code === "SQLITE_CONSTRAINT_UNIQUE"
      ? "already exists"
      : "unknown error";
  }

  const feed_id = db.query("SELECT id FROM feeds WHERE url = ?").get(url).id;

  if (!bookmark) {
    await poll_feed(feed_id, url, true);
  } else {
    const q = `
      INSERT INTO entries (feed_id, url, title, date, tags)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
      `;
    const inserted = db
      .query(q)
      .get(feed_id, url, url, new Date().toISOString(), "site");

    sendNotification(
      JSON.stringify({
        title: "site showcase !",
        body: url,
        url: `/go/?entry_id=${inserted.id}`,
      }),
    );
  }

  return `added ${url}`;
}

export async function try_submit(req) {
  if (!req.session) return "you must be logged in to submit stuff";

  const cant_post = db
    .query("SELECT cant_post FROM users WHERE id = ?")
    .get(req.session.id)?.cant_post;
  if (cant_post) return "you cant post im sorry";

  const url = req.body.url?.trim() ?? "";
  const bookmark = (req.body.no_rss ?? 0) === "on";

  const { error, resolved } = await validate_feed(url, bookmark);
  if (error) return error;

  return await insert_feed(resolved, bookmark, req.session.id);
}
