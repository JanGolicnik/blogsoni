import { Database } from "bun:sqlite";

export let db;

export function init_db(path) {
  db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      description TEXT,
      favicon_data BLOB,
      favicon_mime TEXT,
      is_bookmark INTEGER DEFAULT 0,
      added_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      date TEXT,
      visits INTEGER DEFAULT 0,
      last_visit_at TEXT,
      author TEXT,
      tags TEXT,
      hn_url TEXT,
      lobste_url TEXT,
      FOREIGN KEY (feed_id) REFERENCES feeds(id) ON DELETE CASCADE,
      UNIQUE(feed_id, url)
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      mail TEXT,
      site TEXT,
      description TEXT,
      banned BOOLEAN,
      can_invite BOOLEAN,
      can_post BOOLEAN,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      inviter_id INTEGER REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS visits (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash BLOB PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC);
    CREATE INDEX IF NOT EXISTS entries_feed_id_idx ON feeds(id);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS visits_entry_id_idx ON visits(entry_id);
  `);

  let user_version = db.query("PRAGMA user_version").get().user_version;
  console.log(`running db version ${user_version}`);
  if (user_version <= 0) {
    user_version++;
    db.query(
      "ALTER TABLE feeds ADD COLUMN added_by INTEGER REFERENCES users(id)",
    ).run();
    db.query("UPDATE feeds SET added_by = 1 WHERE added_by IS NULL").run();
    db.query(
      "CREATE UNIQUE INDEX users_username_key ON users (username)",
    ).run();
  }
  if (user_version <= 1) {
    user_version++;
    db.query("DROP TABLE IF EXISTS comments").run();
    db.query(
      `CREATE TABLE comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
    ).run();
    db.query(
      "CREATE INDEX IF NOT EXISTS comments_entry_id_idx ON comments(entry_id)",
    ).run();
  }
  if (user_version <= 2) {
    user_version++;
    db.query("ALTER TABLE users RENAME COLUMN can_invite TO cant_invite").run();
    db.query("ALTER TABLE users RENAME COLUMN can_post TO cant_post").run();
  }
  if (user_version <= 3) {
    user_version++;
    db.query("ALTER TABLE entries DROP COLUMN visits").run();
    db.query("ALTER TABLE entries DROP COLUMN last_visit_at").run();
  }
  if (user_version <= 4) {
    user_version++;
    db.query("ALTER TABLE visits ADD COLUMN rating TEXT").run();
  }
  if (user_version <= 5) {
    user_version++;
    db.query("ALTER TABLE feeds ADD COLUMN favicon_color1 TEXT").run();
    db.query("ALTER TABLE feeds ADD COLUMN favicon_color2 TEXT").run();
  }
  if (user_version <= 6) {
    user_version++;
    db.query("ALTER TABLE feeds ADD COLUMN last_modified TEXT").run();
  }
  db.query(`PRAGMA user_version = ${user_version}`).get();
}
