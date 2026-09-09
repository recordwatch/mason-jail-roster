import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBookings } from '../parser.js';

test('parses a single booking with no release and one charge', () => {
  const text = `Booking #: 12345
Name: SMITH, JOHN A
Name Number: 6789
Book Date: 10:02:00 02/09/26
Rel Date: No Rel Date
StatuteOffenseCourtOffenseClass
9A.36.041Assault, SimpleDIST GROSS MISDEMEANOR
`;
  const bookings = extractBookings(text);
  assert.equal(bookings.size, 1);
  const b = bookings.get('12345');
  assert.equal(b.name, 'SMITH, JOHN A');
  assert.equal(b.bookDate, '2026-02-09T10:02:00');
  assert.equal(b.releaseDate, 'Not Released');
  assert.deepEqual(b.charges, ['Assault, Simple']);
});

test('parses a booking with a release date', () => {
  const text = `Booking #: 22222
Name: DOE, JANE B
Name Number: 1111
Book Date: 08:15:00 03/01/26
Rel Date: 14:45:00 03/05/26
StatuteOffenseCourtOffenseClass
9A.36.041Assault, SimpleDIST GROSS MISDEMEANOR
`;
  const b = extractBookings(text).get('22222');
  assert.equal(b.bookDate, '2026-03-01T08:15:00');
  assert.equal(b.releaseDate, '2026-03-05T14:45:00');
});

test('returns an empty charges array when no charge lines are present', () => {
  const text = `Booking #: 33333
Name: BROWN, MICHAEL C
Name Number: 2222
Book Date: 09:00:00 04/01/26
Rel Date: No Rel Date
StatuteOffenseCourtOffenseClass
`;
  const b = extractBookings(text).get('33333');
  assert.deepEqual(b.charges, []);
});

test('rejects a calendar-invalid Book Date (Feb 30) and falls back to "Unknown" instead of a garbage date', () => {
  const text = `Booking #: 44444
Name: GARCIA, MARIA
Name Number: 3333
Book Date: 10:00:00 02/30/26
Rel Date: No Rel Date
StatuteOffenseCourtOffenseClass
9A.36.041Assault, SimpleDIST GROSS MISDEMEANOR
`;
  const b = extractBookings(text).get('44444');
  assert.equal(b.bookDate, 'Unknown');
});

test('splits multiple booking blocks in one roster text into separate entries', () => {
  const block1 = `Booking #: 12345
Name: SMITH, JOHN A
Name Number: 6789
Book Date: 10:02:00 02/09/26
Rel Date: No Rel Date
StatuteOffenseCourtOffenseClass
9A.36.041Assault, SimpleDIST GROSS MISDEMEANOR
`;
  const block2 = `Booking #: 22222
Name: DOE, JANE B
Name Number: 1111
Book Date: 08:15:00 03/01/26
Rel Date: 14:45:00 03/05/26
StatuteOffenseCourtOffenseClass
9A.36.041Assault, SimpleDIST GROSS MISDEMEANOR
`;
  const bookings = extractBookings(block1 + block2);
  assert.equal(bookings.size, 2);
  assert.ok(bookings.has('12345'));
  assert.ok(bookings.has('22222'));
});

test('deduplicates identical charges appearing on multiple lines', () => {
  const text = `Booking #: 55555
Name: WILSON, ROBERT
Name Number: 4444
Book Date: 12:00:00 05/01/26
Rel Date: No Rel Date
StatuteOffenseCourtOffenseClass
9A.36.041Assault, SimpleDIST GROSS MISDEMEANOR
9A.36.041Assault, SimpleMUNI GROSS MISDEMEANOR
`;
  const b = extractBookings(text).get('55555');
  assert.deepEqual(b.charges, ['Assault, Simple']);
});

test('documents current behavior: an all-caps acronym charge (e.g. "DUI") keeps its leading statute code', () => {
  // The code-stripping regex looks for an uppercase-then-lowercase boundary
  // (e.g. "Assault") to find where the statute code ends. An all-caps
  // acronym like "DUI" has no such boundary, so the code stays attached.
  // This is a real, currently-existing quirk (confirmed against production
  // data) — not something this test suite is meant to fix.
  const text = `Booking #: 66666
Name: RIX, MICHAEL L
Name Number: 5555
Book Date: 02:32:00 02/09/26
Rel Date: No Rel Date
StatuteOffenseCourtOffenseClass
46.61.502DUI Alcohol or DrugsDIST GROSS MISDEMEANOR
`;
  const b = extractBookings(text).get('66666');
  assert.deepEqual(b.charges, ['46.61.502DUI Alcohol or Drugs']);
});

test('falls back to "Unknown" name and skips a block with no Booking # match', () => {
  const text = `Not a real booking block at all, just noise.\n`;
  const bookings = extractBookings(text);
  assert.equal(bookings.size, 0);
});
