// Read-only: node check-credit-served.mjs /path/to/mason.sqlite   (run from the repo root)
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
const { parseBookingDate, formatMinutes, summarizeTimeToPostByBail } = await import(path.resolve('utils.js'));

const db = new DatabaseSync(process.argv[2], { readOnly: true });
const rows = db.prepare(`
  SELECT r.name, r.release_date_time AS releaseDateTime, r.time_served AS masonTimeServed,
         r.release_type AS releaseType, r.bail,
         (SELECT MAX(e.event_date) FROM events e
           WHERE e.event_type = 'BOOKED' AND e.name = r.name
             AND e.event_date <= r.release_date_time) AS bookingDate
  FROM releases r ORDER BY r.id ASC`).all();

// Same rules as the deepstats route (server.js) and computeTimeServed (roster-data.js)
const CEILING = 2628000;
const toMins = s => { const m = (s || '').match(/(\d+)d(\d+)h(\d+)m/); return m ? +m[1] * 1440 + +m[2] * 60 + +m[3] : 0; };
const observedMins = (b, r) => {
  const bd = parseBookingDate(b), rd = parseBookingDate(r);
  if (!bd || !rd || isNaN(bd) || isNaN(rd) || rd - bd <= 0) return 0;
  return Math.floor((rd - bd) / 60000);
};
const BUCKETS = [
  { label: '$1 – $500', min: 0, max: 500 }, { label: '$501 – $1,000', min: 500, max: 1000 },
  { label: '$1,001 – $2,500', min: 1000, max: 2500 }, { label: '$2,501 – $5,000', min: 2500, max: 5000 },
  { label: '$5,001 – $10,000', min: 5000, max: 10000 }, { label: 'Over $10,000', min: 10000, max: Infinity },
];

const all = [], observed = [], creditServed = [];
for (const r of rows) {
  const bailAmt = parseFloat((r.bail || '$0').replace(/[$,]/g, ''));
  if (!(bailAmt > 0)) continue;
  const obs = r.bookingDate ? observedMins(r.bookingDate, r.releaseDateTime) : 0;
  const heldMins = obs > 0 ? obs : toMins(r.masonTimeServed);
  if (heldMins <= 0 || heldMins >= CEILING) continue;
  all.push({ bailAmt, heldMins });
  if (obs > 0) observed.push({ bailAmt, heldMins });
  else creditServed.push({ ...r, bailAmt, heldMins, why: r.bookingDate ? 'booking found but not before release' : 'no BOOKED event for this name' });
}

console.log(`${all.length} rows: ${observed.length} observed, ${creditServed.length} Credit Served\n`);
console.log('── Rows using Credit Served ──');
console.table(creditServed.map(r => ({ name: r.name, released: r.releaseDateTime, type: r.releaseType, bail: r.bail, creditServed: r.masonTimeServed, why: r.why })));

const a = summarizeTimeToPostByBail(all, BUCKETS), o = summarizeTimeToPostByBail(observed, BUCKETS);
console.log('\n── Time to Post table: current (all) vs observed-only ──');
console.table(a.map((x, i) => ({
  range: x.label,
  'n all→obs': `${x.count} → ${o[i].count}`,
  'p25': `${formatMinutes(x.p25Mins)} → ${formatMinutes(o[i].p25Mins)}`,
  'median': `${formatMinutes(x.medianMins)} → ${formatMinutes(o[i].medianMins)}`,
  'p75': `${formatMinutes(x.p75Mins)} → ${formatMinutes(o[i].p75Mins)}`,
  '≤24h': `${x.within24hPct}% → ${o[i].within24hPct}%`,
})));
