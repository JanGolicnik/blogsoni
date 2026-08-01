import pici from "./include/picijs/pici.js";
import gss from "./include/gss/gss.js";
import { db, init_db } from "./db.js";
import { try_submit, poll_all } from "./feeds.js";
import { fetch_favicon } from "./favicons.js";

function route_index(req) {
  const id = req.session?.id;

  const filter = req.params.filter ?? "week";
  const sites_only = filter === "sites";
  const days = (filter === "all" || sites_only) ? null : filter === "month" ? -30 : -7;

  const time_filter = days ? `AND date >= datetime('now', '${days} days')` : "";
  const bookmark_filter = sites_only ? "AND is_bookmark = 1" : "";

  const union = !sites_only
    ? `
    UNION ALL
    SELECT NULL, f.url, 'New feed: ' || COALESCE(f.title, f.url), f.added_at as date,
      NULL, NULL, NULL, NULL, NULL, NULL,
      0 as is_bookmark, 1 as is_fake,
      0 as favicon_color1, 0 as favicon_color2,
      0 as n_comments,
      0 AS n_likes, 0 AS n_dislikes, 0 AS n_visits,
      0 AS visited, 0 AS my_rating
    FROM feeds f
    WHERE f.is_bookmark = 0
  `
    : "";

  const sql = `
      SELECT * FROM (
        SELECT e.id, e.url, e.title, e.date as date,
          e.author, e.tags, e.hn_url, e.lobste_url, f.id AS feed_id, f.title AS feed_title,
          f.is_bookmark, 0 as is_fake,
          f.favicon_color1 as favicon_color1, f.favicon_color2 as favicon_color2,
          (SELECT COUNT(c.id) FROM comments c WHERE c.entry_id = e.id) AS n_comments,
          (SELECT COUNT(*) FROM visits v WHERE v.entry_id = e.id AND v.rating = 'like')    AS n_likes,
          (SELECT COUNT(*) FROM visits v WHERE v.entry_id = e.id AND v.rating = 'dislike') AS n_dislikes,
          (SELECT COUNT(*) FROM visits v WHERE v.entry_id = e.id)                          AS n_visits,
          (SELECT COUNT(*) FROM visits v WHERE v.entry_id = e.id AND v.user_id = ?)        AS visited,
          (SELECT v.rating FROM visits v WHERE v.entry_id = e.id AND v.user_id = ?)        AS rating
        FROM entries e
        JOIN feeds f ON e.feed_id = f.id
        ${union}
      )
      WHERE 1 ${time_filter} ${bookmark_filter}
      ORDER BY date DESC
  `;

  return server.render("index.html", {
    entries: db.query(sql).all(id, id),
    msg: req.flash,
    filter,
    sites_only,
    session: req.session,
  });
}

function route_submit(req) {
  const feeds = db
    .query(
      `
          SELECT f.id as id, f.title as title, f.url as url, f.added_by as added_by, COUNT(e.id) AS entry_count, u.username as added_by_username
          FROM feeds f
          LEFT JOIN entries e ON e.feed_id = f.id
          LEFT JOIN users u ON u.id = f.added_by
          GROUP BY f.id
          ORDER BY f.added_at DESC
    `,
    )
    .all();
  const n_feeds = db
    .query(
      `
              SELECT COUNT(id) AS n
              FROM feeds
              WHERE is_bookmark = 0
              ORDER BY added_at DESC
        `,
    )
    .get().n;
  return server.render("submit.html", {
    feeds,
    n_feeds,
    msg: req.flash,
    session: req.session,
  });
}

async function route_submit_post(req) {
  return pici.refresh(await try_submit(req));
}

function route_favicon(req) {
  if (!req.params.id) return pici.not_found();
  const row = db
    .query(
      `SELECT favicon_data, favicon_mime FROM feeds WHERE id = ? AND favicon_data IS NOT NULL`,
    )
    .get(req.params.id);

  if (!row)
    return pici.not_found();

  return pici.ok({
    data: row.favicon_data,
    headers: {
      "Content-Type": row.favicon_mime ?? "image/png",
      "Cache-Control": "public, max-age=604800",
    },
  });
}

function require_login(req) {
  if (!req.session) {
    return pici.redirect("/login");
  }

  const banned = db
    .query("SELECT banned FROM users WHERE id = ?")
    .get(req.session.id)?.banned;
  if (banned) {
    server.remove_session(req);
    return pici.redirect("/login");
  }
}

function require_admin(req) {
  if (!req.session?.is_admin) return pici.redirect("/");
}

function route_delete_post(req) {
  const feed_id = req.params.feed_id;
  if (feed_id) {
    db.query("DELETE FROM entries WHERE feed_id = ?").run(feed_id);
    db.query("DELETE FROM feeds WHERE id = ?").run(feed_id);
  }
  return pici.redirect("/submit");
}

function route_go(req) {
  const entry_id = req.params.entry_id;
  if (!entry_id) return pici.redirect("/");

  if (req.session) {
    try {
      db.query("INSERT INTO visits (user_id, entry_id) VALUES (?, ?)").run(
        req.session.id,
        entry_id,
      );
    } catch (e) {}
  }

  const entry = db.query("SELECT url FROM entries WHERE id = ?").get(entry_id);

  return pici.redirect(entry.url);
}

function route_random() {
  return pici.redirect(`/entry`, {
    id: db.query("SELECT id FROM entries ORDER BY RANDOM() LIMIT 1").get().id,
  });
}

function route_subscribe_post(req) {
  const sub = req.body;
  db.query(
    `
    INSERT INTO subscriptions (endpoint, p256dh, auth)
    VALUES (?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
    `,
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  return pici.error({ code: 201 });
}

function route_extension(req) {
  return server.render("extension.html", {
    ...req.params,
    msg: req.flash,
    session: req.session,
  });
}

async function route_extension_post(req) {
  return pici.refresh(await try_submit(req));
}

async function route_login(req) {
  return server.render("login.html", { msg: req.flash, session: req.session });
}

async function route_login_post(req) {
  const return_status = (flash) => pici.refresh(flash);

  if (!req.body) return return_status("form body missing i think ?");
  if (!req.body.username) return return_status("username required");
  if (!req.body.password) return return_status("password required");

  const user = db
    .query(
      "SELECT id, username, password_hash, banned FROM users WHERE username = ?",
    )
    .get(req.body.username);

  if (!user) return return_status("incorrect username or password");
  if (user.banned) return return_status("this user has been banned :(");

  if (!(await Bun.password.verify(req.body.password, user.password_hash)))
    return return_status("incorrect username or password");

  if (req.session) server.remove_session(req);

  server.add_session(req, user);

  return pici.redirect("/");
}

async function route_register(req) {
  return req.params.invite
    ? server.render("register.html", {
        msg: req.flash,
        invite: req.params.invite,
        session: req.session,
      })
    : pici.redirect("/");
}

function register_validate_username_password(username, password, password2) {
  if (!username) return "username required";
  if (!password) return "password required";
  if (!password2) return "confirmation password required";
  if (!password != !password2) return "passwords dont match";
  if (username.length > 30) return "username is max 30 characters";
  if (password.length > 30) return "password is max 30 characters";
}

async function route_register_post(req) {
  const return_status = (flash) => pici.refresh(flash);

  if (!req.body) return return_status("form body missing i think ?");
  if (!req.params.invite) return return_status("you need an invite");

  const error = register_validate_username_password(
    req.body.username,
    req.body.password,
    req.body.password2,
  );
  if (error) return return_status(error);

  const invite_hash = req.params.invite;
  const invited_by = db
    .query("SELECT inviter_id FROM invites WHERE hash = ?")
    .get(invite_hash)?.inviter_id;
  if (!invited_by) return return_status("inviter user is missing");

  const cant_invite = db
    .query("SELECT cant_invite FROM users WHERE id = ?")
    .get(invited_by)?.cant_invite;
  if (cant_invite) return return_status("invalid invite");

  const password_hash = await Bun.password.hash(req.body.password);
  try {
    db.query(
      "INSERT INTO users (username, password_hash, invited_by) VALUES (?, ?, ?)",
    ).run(req.body.username, password_hash, invited_by);
    db.query("DELETE FROM invites WHERE hash = ?").run(invite_hash);
    return pici.redirect("/login");
  } catch (e) {
    return return_status(
      e.code === "SQLITE_CONSTRAINT_UNIQUE"
        ? "username alr taken"
        : "smth happened idk",
    );
  }
}

function route_profile(req) {
  const id = req.params?.id ?? null;
  if (!id) return pici.not_found();
  const user = db.query("SELECT * FROM users WHERE id = ?").get(id);
  if (!user) return pici.not_found();
  if (user.invited_by)
    user.invited_by_username = db
      .query("SELECT username FROM users WHERE id = ?")
      .get(user.invited_by)?.username;
  return server.render("profile.html", {
    user,
    msg: req.flash,
    session: req.session,
    invitees: db
      .query("SELECT * FROM users WHERE invited_by = ? ORDER BY created_at")
      .all(id),
    feeds: db
      .query("SELECT * FROM feeds WHERE added_by = ? ORDER BY added_at")
      .all(id),
    invite: db.query("SELECT hash FROM invites WHERE inviter_id = ?").get(id)
      ?.hash,
  });
}

function route_profile_post(req) {
  const id = req.params?.id ?? null;
  if (!id) return pici.not_found();
  db.query(
    `
    UPDATE users SET site = ?, mail = ?, description = ? WHERE id = ?`,
  ).run(
    req.body.site ?? null,
    req.body.mail ?? null,
    req.body.description ?? null,
    id,
  );
  return pici.refresh("updated !");
}

function route_profile_admin_post(req) {
  const id = req.params?.id ?? null;
  if (!id) return pici.not_found();
  db.query(
    `UPDATE users SET banned = ?, cant_invite = ?, cant_post = ? WHERE id = ?`,
  ).run(
    req.body.banned ? 1 : 0,
    req.body.cant_invite ? 1 : 0,
    req.body.cant_post ? 1 : 0,
    id,
  );
  return pici.refresh("updated !", `/profile/id?=${id}`);
}

function route_logout_post(req) {
  server.remove_session(req);
  return pici.refresh("logged out", "/login");
}

function route_create_invite(req) {
  const id = req.session.id;
  const cant_invite = db
    .query("SELECT cant_invite FROM users WHERE id = ?")
    .get(id)?.cant_invite;
  if (cant_invite) return pici.refresh("you dont have permission to invite :/");
  return pici.refresh(
    db
      .query(
        `
    INSERT INTO invites (hash, inviter_id)
    SELECT ?, ?
    WHERE (
      SELECT count(id) FROM invites
      WHERE inviter_id = ?
    ) < 1;
    `,
      )
      .run(Bun.randomUUIDv7(), req.session.id, req.session.id).changes === 0
      ? "cant have more than 1 invite"
      : "",
    `/profile/?id=${id}`,
  );
}

function route_entry(req) {
  const id = req.params.id;
  if (!id) return pici.not_found();
  const entry = db
    .query(
      `SELECT e.*, f.title AS feed_title, f.is_bookmark
    FROM entries e
    JOIN feeds f ON e.feed_id = f.id
    WHERE e.id = ?
  `,
    )
    .get(id);
  if (!entry) return pici.not_found();
  const comments = db
    .query(
      `
    SELECT c.*, u.username
    FROM comments c
    JOIN users u ON u.id = c.author_id
    WHERE c.entry_id = ?
  `,
    )
    .all(id);
  return server.render("entry.html", { entry, comments, session: req.session });
}

function route_entry_post(req) {
  const id = req.params.id;
  if (!id) return pici.not_found();
  const content = req.body.content?.trim().substring(0, 1234) ?? "";
  if (content === "") return pici.refresh("cmon");
  db.query(
    "INSERT INTO comments (content, entry_id, author_id) VALUES (?, ?, ?)",
  ).run(content, id, req.session.id);
  return pici.refresh();
}

function route_about(req) {
  return server.render("about.html", { session: req.session });
}

function route_users(req) {
  const users = db.query("SELECT * FROM users").all();
  return server.render("users.html", { users, session: req.session });
}

function hash_token(token) {
  return new Bun.CryptoHasher("sha256").update(token).digest();
}

function route_rate(req) {
  const rating = req.params.rating;
  const post_id = req.params.id;
  const user_id = req.session.id;
  if (!post_id) return pici.not_found();
  if (rating !== "dislike" && rating !== "like") return pici.not_found();
  const res = db
    .query(
      `
      UPDATE visits SET rating = CASE WHEN rating = ? THEN NULL ELSE ? END
      WHERE entry_id = ? AND user_id = ?`,
    )
    .run(rating, rating, post_id, user_id);
  return res.changes > 0
    ? pici.redirect("/")
    : pici.refresh("you have to read the post to rate it dummy", "/");
}

const server = pici.create({
  render: gss.render,
  get: {
    "/": route_index,
    "/favicon": route_favicon,
    "/about": route_about,
    "/submit": [require_login, route_submit],
    "/go": route_go,
    "/random": route_random,
    "/extension": route_extension,
    "/login": route_login,
    "/register": route_register,
    "/profile": route_profile,
    "/create_invite": [require_login, route_create_invite],
    "/entry": route_entry,
    "/users": route_users,
  },
  post: {
    "/submit": [require_login, route_submit_post],
    "/extension": [require_login, route_extension_post],
    "/delete": [require_login, require_admin, route_delete_post],
    "/subscribe": route_subscribe_post,
    "/login": route_login_post,
    "/logout": [require_login, route_logout_post],
    "/register": route_register_post,
    "/profile": [require_login, route_profile_post],
    "/profile_admin": [require_login, require_admin, route_profile_admin_post],
    "/entry": [require_login, route_entry_post],
    "/rate": [require_login, route_rate],
  },
  add_session: (req, user) => {
    req._new_session_token = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex");
    db.query("INSERT INTO sessions (token_hash, user_id) VALUES (?, ?)").run(
      hash_token(req._new_session_token),
      user.id,
    );
  },
  get_session: (req) => {
    const user_id = db
      .query("SELECT user_id FROM sessions WHERE token_hash = ?")
      .get(hash_token(req.cookies.session))?.user_id;
    if (!user_id) return;
    const user = db.query("SELECT * FROM users WHERE id = ?").get(user_id);
    if (!user) return;
    user.is_admin = user.id === 1;
    return user;
  },
  remove_session: (req) => {
    db.query("DELETE FROM sessions WHERE token_hash = ?").run(
      hash_token(req.cookies.session),
    );
  },
});

init_db(process.env.DATABASE ?? "links.db");

setInterval(poll_all, 3 * 60 * 60 * 1000);
// poll_all();

server.start(5001);
