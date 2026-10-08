import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { STORAGE_DIR } from './config.js';

const DB_PATH = path.join(STORAGE_DIR, 'mason.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL CHECK(event_type IN ('BOOKED', 'RELEASED')),
    name TEXT NOT NULL,
    event_date TEXT,
    charges TEXT NOT NULL DEFAULT '',
    time_served TEXT,
    bail TEXT,
    release_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);');
db.exec('CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);');
db.exec('CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);');

db.exec(`
  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    release_date_time TEXT NOT NULL,
    release_type TEXT,
    time_served TEXT,
    bail TEXT,
    UNIQUE(name, release_date_time)
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_releases_date ON releases(release_date_time);');

// Court and offense class per charge per booking, from the roster PDF. Kept
// separate from events.charges (plain offense text) so it can be recorded
// for every booking seen — live scrapes and re-parsed archived PDFs alike —
// without touching the event log. booking_id is the roster's own Booking #.
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_charges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id TEXT NOT NULL,
    name TEXT NOT NULL,
    book_date TEXT,
    offense TEXT NOT NULL,
    court TEXT,
    offense_class TEXT,
    source TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(booking_id, offense, court, offense_class)
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_booking_charges_book ON booking_charges(name, book_date);');

export default db;
export { DB_PATH };
