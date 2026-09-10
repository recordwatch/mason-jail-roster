import db from './db.js';
import { parseBookingDate, toIsoDateTime } from './utils.js';

// Parse a formatted change-log line (the same text formatBooked/formatReleased
// produce) into structured fields for the events table. Used both for the
// one-time historical migration and for live writes — /api/run still builds
// the display string via formatBooked/formatReleased, then this re-derives
// the structured fields from it, so there is exactly one parsing path to
// keep correct rather than two (a "build" path and a separate "store" path
// that could drift apart).
function parseEventLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;

  let type, rest;
  if (trimmed.startsWith('BOOKED | ')) {
    type = 'BOOKED';
    rest = trimmed.slice('BOOKED | '.length);
  } else if (trimmed.startsWith('RELEASED | ')) {
    type = 'RELEASED';
    rest = trimmed.slice('RELEASED | '.length);
  } else {
    return null; // stray section header or other non-event noise
  }

  const name = (rest.split(' | ')[0] || 'Unknown').trim();

  const dateToken = extractRawDateToken(trimmed, type === 'BOOKED' ? 'Booked' : 'Released');
  const date = toCanonicalIso(dateToken);

  const chargesMatch = trimmed.match(/Charges:\s+(.+)$/);
  const charges = chargesMatch ? chargesMatch[1].trim() : '';

  const timeServedMatch = trimmed.match(/Time served:\s+([^|(]+)/);
  const timeServed = timeServedMatch ? timeServedMatch[1].trim() : null;

  const bailMatch = trimmed.match(/Bail Posted:\s+(\$[\d,]+\.\d{2})/);
  const bail = bailMatch ? bailMatch[1].trim() : null;

  // The release-type parenthetical always immediately precedes "| Charges:"
  // (see formatReleased). Anchoring on that avoids false matches from a
  // parenthetical embedded in the charges/statute text itself, e.g.
  // "9A.46.080 (O)Probation, Parole Violation" has no real release type.
  const releaseTypeMatch = trimmed.match(/\(([^)]+)\)\s*\|\s*Charges:/);
  const releaseType = releaseTypeMatch ? releaseTypeMatch[1].trim() : null;

  return { type, name, date, charges, timeServed, bail, releaseType };
}

function extractRawDateToken(line, label) {
  const m = line.match(new RegExp(
    `${label}:\\s+(\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2})?|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}(?:\\s+\\d{1,2}:\\d{2}:\\d{2})?|Unknown|Not Released)`
  ));
  return m ? m[1] : null;
}

function toCanonicalIso(raw) {
  if (!raw || raw === 'Unknown' || raw === 'Not Released') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return parseBookingDate(raw) ? raw : null;
  }
  const m = raw.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(\d{1,2}:\d{2}:\d{2}))?$/);
  if (!m) return null;
  const iso = toIsoDateTime(m[1], m[2]);
  return parseBookingDate(iso) ? iso : null;
}

// A single raw change_log.txt line can contain more than one record glued
// together with no line break (a known historical data-corruption bug from
// before this migration). Split on every "BOOKED | " / "RELEASED | "
// boundary so each record is parsed independently instead of one record's
// text leaking into another's charges field.
function splitGluedRecords(rawLine) {
  return rawLine.split(/(?=BOOKED \| |RELEASED \| )/).filter(p => p.trim());
}

const insertEventStmt = db.prepare(`
  INSERT INTO events (event_type, name, event_date, charges, time_served, bail, release_type)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function insertEvent({ type, name, date, charges, timeServed, bail, releaseType }) {
  insertEventStmt.run(type, name, date, charges || '', timeServed, bail, releaseType);
}

// Parse and insert every record found in a raw change_log.txt line
// (handling the glued-record case). Returns the number of rows inserted.
function insertEventsFromLine(rawLine) {
  let inserted = 0;
  for (const record of splitGluedRecords(rawLine)) {
    const parsed = parseEventLine(record);
    if (!parsed) continue;
    insertEvent(parsed);
    inserted++;
  }
  return inserted;
}

// Reconstruct the events table as an array of formatted text lines, in the
// exact format formatBooked/formatReleased used to produce, so the existing
// /api/history, /api/stats, and /api/deepstats parsing logic (which expects
// an array of lines) can run completely unchanged against database-backed data.
function getAllEventLines() {
  const rows = db.prepare('SELECT * FROM events ORDER BY id ASC').all();
  return rows.map(row => `${row.event_type} | ${rowToLine(row)}`);
}

// Byte-faithful reconstruction of the original change_log.txt line format
// from stored fields. Deliberately does not recompute anything (e.g. time
// served) — it just replays what was already computed and stored, so a row
// written today reconstructs identically whenever it's read back later.
function rowToLine(row) {
  const chargeText = row.charges && row.charges.length > 0 ? row.charges : 'None listed';

  if (row.event_type === 'BOOKED') {
    const dateStr = row.event_date ?? 'Unknown';
    return `${row.name} | Booked: ${dateStr} | Charges: ${chargeText}`;
  }

  // RELEASED — a RELEASED row always represents a release that did happen;
  // "Unknown" means the date specifically is unknown (matches the historical
  // sentinel actually used in change_log.txt). "Not Released" is a different
  // concept used elsewhere (the live roster CSV/stats) for someone who
  // hasn't been released at all, and never appears on a RELEASED line.
  const dateStr = row.event_date ?? 'Unknown';
  let text = `${row.name} | Released: ${dateStr}`;
  if (row.time_served) text += ` | Time served: ${row.time_served}`;
  if (row.bail) {
    const bailAmount = parseFloat(row.bail.replace(/[$,]/g, ''));
    if (bailAmount > 0) text += ` | Bail Posted: ${row.bail}`;
  }
  if (row.release_type) text += ` (${row.release_type})`;
  text += ` | Charges: ${chargeText}`;
  return text;
}

const insertReleaseStmt = db.prepare(`
  INSERT OR IGNORE INTO releases (name, release_date_time, release_type, time_served, bail)
  VALUES (?, ?, ?, ?, ?)
`);

// Insert a release record (from the release-stats PDF), deduped by
// (name, release_date_time) via the table's UNIQUE constraint — replaces
// the old manual existingKeys Set + JSON rewrite.
function insertRelease({ name, releaseDateTime, releaseType, timeServed, bail }) {
  const result = insertReleaseStmt.run(name, releaseDateTime, releaseType, timeServed, bail);
  return result.changes > 0;
}

function getAllReleases() {
  return db.prepare('SELECT name, release_date_time as releaseDateTime, release_type as releaseType, time_served as timeServed, bail FROM releases ORDER BY id ASC').all();
}

// Wipe both tables. Used by the historical migration endpoint so it can be
// re-run safely — inserts into `events` have no unique constraint (unlike
// `releases`), so re-running an additive import would duplicate everything.
// Rebuilding from the text files (the ground truth during the dual-write
// transition period) on every run keeps the migration idempotent.
function clearAllData() {
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM releases');
  db.exec("DELETE FROM sqlite_sequence WHERE name IN ('events', 'releases')");
}

export {
  parseEventLine,
  splitGluedRecords,
  toCanonicalIso,
  insertEvent,
  insertEventsFromLine,
  getAllEventLines,
  insertRelease,
  getAllReleases,
  clearAllData
};
