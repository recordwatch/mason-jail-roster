import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// db.js opens a SQLite file at import time based on RAILWAY_VOLUME_MOUNT_PATH,
// so that has to be set to an isolated temp dir before events.js (which
// imports db.js) is ever imported — otherwise tests would write to the real
// /data path.
let tmpDir;
let parseEventLine, splitGluedRecords, toCanonicalIso, insertEventsFromLine, getAllEventLines;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mason-events-test-'));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;
  ({ parseEventLine, splitGluedRecords, toCanonicalIso, insertEventsFromLine, getAllEventLines } = await import('../events.js'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('splitGluedRecords splits two records concatenated with no line break', () => {
  const glued = 'BOOKED | LACLAIR, DALE R | Booked: 06/25/24 09:12:00 | Charges: HomicideBOOKED | ORDONEZ MARTIN, ANTONIO | Booked: 02/09/26 18:36:00 | Charges: Assault, Simple';
  const parts = splitGluedRecords(glued);
  assert.equal(parts.length, 2);
  assert.match(parts[0], /^BOOKED \| LACLAIR/);
  assert.match(parts[1], /^BOOKED \| ORDONEZ MARTIN/);
});

test('splitGluedRecords leaves a normal single record unchanged', () => {
  const line = 'BOOKED | SMITH, JOHN A | Booked: 2026-01-18T01:45:00 | Charges: Assault, Simple';
  assert.deepEqual(splitGluedRecords(line), [line]);
});

test('toCanonicalIso converts legacy MM/DD/YY HH:MM:SS to ISO', () => {
  assert.equal(toCanonicalIso('02/09/26 10:02:00'), '2026-02-09T10:02:00');
});

test('toCanonicalIso passes through already-ISO dates', () => {
  assert.equal(toCanonicalIso('2026-02-09T10:02:00'), '2026-02-09T10:02:00');
  assert.equal(toCanonicalIso('2026-02-09'), '2026-02-09');
});

test('toCanonicalIso returns null for Unknown/Not Released/garbage', () => {
  assert.equal(toCanonicalIso('Unknown'), null);
  assert.equal(toCanonicalIso('Not Released'), null);
  assert.equal(toCanonicalIso('02/30/26 10:00:00'), null); // Feb 30 doesn't exist
});

test('parseEventLine extracts a normal BOOKED record', () => {
  const parsed = parseEventLine('BOOKED | SMITH, JOHN A | Booked: 2026-01-18T01:45:00 | Charges: Assault, Simple');
  assert.equal(parsed.type, 'BOOKED');
  assert.equal(parsed.name, 'SMITH, JOHN A');
  assert.equal(parsed.date, '2026-01-18T01:45:00');
  assert.equal(parsed.charges, 'Assault, Simple');
});

test('parseEventLine extracts a normal RELEASED record with time served, bail, and release type', () => {
  const parsed = parseEventLine('RELEASED | DOE, JANE B | Released: 2026-03-05T14:45:00 | Time served: 4d6h30m | Bail Posted: $500.00 (Released on Bail Bond) | Charges: DUI Alcohol or Drugs');
  assert.equal(parsed.type, 'RELEASED');
  assert.equal(parsed.date, '2026-03-05T14:45:00');
  assert.equal(parsed.timeServed, '4d6h30m');
  assert.equal(parsed.bail, '$500.00');
  assert.equal(parsed.releaseType, 'Released on Bail Bond');
});

test('parseEventLine does not mistake a parenthetical inside the charges/statute text for the release type', () => {
  // Regression test: "9A.46.080 (O)Probation..." has no real release type in
  // this line, but a naive "first (...) anywhere" regex would have grabbed
  // "(O)" from the charges text. Confirmed against real production data.
  const parsed = parseEventLine('RELEASED | YEAROUT, DUSTIN L | Released: 2026-02-24T00:08:33 | Time served: 13d12h28m | Charges: 9A.46.080 (O)Probation, Parole Violation');
  assert.equal(parsed.releaseType, null);
  assert.equal(parsed.timeServed, '13d12h28m');
});

test('parseEventLine returns null date for "Unknown" and null for a stray non-event line', () => {
  const parsed = parseEventLine('BOOKED | GRIMNES, SHERRY S | Booked: Unknown | Charges: None listed');
  assert.equal(parsed.date, null);
  assert.equal(parseEventLine('JANUARY 2026'), null);
  assert.equal(parseEventLine(''), null);
});

test('parseEventLine preserves a date-only (time-unknown) release date', () => {
  const parsed = parseEventLine('RELEASED | FREIBERG, BRITTANY S | Released: 2026-02-09 | Charges: Assault, Simple');
  assert.equal(parsed.date, '2026-02-09');
});

test('insertEventsFromLine + getAllEventLines round-trips a glued corrupted line into two clean records', () => {
  const glued = 'BOOKED | COOPER, CODY F | Booked: 2026-02-10T11:14:00 | Charges: VandalismBOOKED | KUZIOR, SKIPPER W | Booked: 2026-02-11T01:20:00 | Charges: Traffic Offense';
  const inserted = insertEventsFromLine(glued);
  assert.equal(inserted, 2);

  const lines = getAllEventLines();
  assert.ok(lines.some(l => l === 'BOOKED | COOPER, CODY F | Booked: 2026-02-10T11:14:00 | Charges: Vandalism'));
  assert.ok(lines.some(l => l === 'BOOKED | KUZIOR, SKIPPER W | Booked: 2026-02-11T01:20:00 | Charges: Traffic Offense'));
});
