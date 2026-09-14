// SQLite storage (node:sqlite, built into Node 24). One file, one schema, no migrations.
import { DatabaseSync } from 'node:sqlite';

/** @param {string} [path] file path or ':memory:' */
export function openDb(path = process.env.DB_PATH || 'recall-radar.db') {
  const db = new DatabaseSync(path);
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists users (
      id text primary key,                       -- OAuth subject (one household per user)
      created_at text default (datetime('now')));
    create table if not exists items (
      id integer primary key,
      user_id text not null,
      name text not null, brand text, model text, category text, purchased_on text, asin text,
      created_at text default (datetime('now')));
    create index if not exists items_user on items(user_id);
    create table if not exists recall_cache (    -- raw upstream responses, TTL-expired by recalls.js
      url text primary key, body text not null, fetched_at integer not null);
    create table if not exists recalls (         -- normalised recall records seen by any check
      id text primary key, source text not null, json text not null, updated_at text default (datetime('now')));
    create table if not exists matches (
      id integer primary key, user_id text not null, item_id integer not null, recall_id text not null,
      confidence real not null, reason text, checked_at text default (datetime('now')),
      unique(item_id, recall_id));
    create table if not exists remedies (
      id integer primary key, user_id text not null, recall_id text not null, item_id integer,
      status text default 'started', remind_on text, started_at text default (datetime('now')));
    create table if not exists oauth_clients (id text primary key, secret text, redirect_uris text not null, name text);
    create table if not exists oauth_codes (code text primary key, client_id text, redirect_uri text, challenge text, sub text, scope text, expires integer);
    create table if not exists oauth_refresh (token text primary key, client_id text, sub text, scope text, expires integer);
  `);
  return db;
}
