import path from 'path';

export const PORT = process.env.PORT || 3000;
export const PDF_URL = 'https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf';
export const RELEASE_STATS_URL = 'https://hub.masoncountywa.gov/sheriff/reports/release_stats48hrs.pdf';
export const STORAGE_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
export const RELEASE_STATS_HISTORY_FILE = path.join(STORAGE_DIR, 'release_stats_history.json');

// Admin/debug routes can mutate or delete the canonical data files, so they
// require a key even though the rest of the site is public.
export const ADMIN_KEY = process.env.ADMIN_KEY;

// The landing page aggregates current population and changes-detected
// counts across all county monitors, not just Mason's own data.
// Monitors whose data/status.json (inCustody) and data/change_log.json
// (bookings) are added into the hub page's Current Inmates and Changes
// Detected totals. A missing file just counts as 0 (see fetchSiblingMonitor).
// Every monitor on the hub map must be here or in HUB_TOTALS_EXCLUDED —
// test/hub-totals.test.js enforces it so the list can't silently drift.
export const SIBLING_MONITORS = [
  { name: 'kitsap',       base: 'https://recordwatch.github.io/ksco-scraper/data' },
  { name: 'pierce',       base: 'https://recordwatch.github.io/pierce-jail-roster/data' },
  { name: 'thurston',     base: 'https://recordwatch.github.io/thurston-jail-roster/data' },
  { name: 'whatcom',      base: 'https://recordwatch.github.io/whatcom-jail-monitor/data' },
  { name: 'clallam',      base: 'https://recordwatch.github.io/clallam-jail-monitor/data' },
  { name: 'grays-harbor', base: 'https://recordwatch.github.io/grays-harbor-jail-monitor/data' },
  { name: 'jefferson',    base: 'https://recordwatch.github.io/jefferson-jail-roster/data' },
  // Pacific and Wahkiakum publish status.json but no change_log.json, so
  // they add to Current Inmates only.
  { name: 'pacific',      base: 'https://recordwatch.github.io/Pacific-county-monitor/data' },
  { name: 'cowlitz',      base: 'https://recordwatch.github.io/cowlitz-county-monitor/data' },
  { name: 'wahkiakum',    base: 'https://recordwatch.github.io/wahkiakum-county-monitor/data' },
  { name: 'lewis',        base: 'https://recordwatch.github.io/lewis-county-monitor/data' },
  { name: 'clark',        base: 'https://recordwatch.github.io/clark-county-monitor/data' },
  { name: 'skagit',       base: 'https://recordwatch.github.io/skagit-county-monitor/data' },
  { name: 'kittitas',     base: 'https://recordwatch.github.io/kittitas-county-monitor/data' },
  { name: 'nisqually',    base: 'https://recordwatch.github.io/nisqually-jail-monitor/data' },
];

// Hub-map monitors deliberately left out of the totals, with the reason.
export const HUB_TOTALS_EXCLUDED = {
  'https://recordwatch.github.io/king-county/': 'matches WA DOC records; publishes no in-custody count',
  'https://www.ferry-county.com/law_and_justice/sheriff/jail/inmate_roster.php#outer-387': 'official county roster page, not a monitor; publishes no status.json',
  'https://stevenscountywa.municipalone.com/20972/Inmate-Roster': 'official county roster page, not a monitor; publishes no status.json',
  'https://omsweb.public-safety-cloud.com/jtclientweb/jailtracker/index/Lincoln_County_WA': 'official JailTracker page, not a monitor; publishes no status.json',
};

export const RELEASE_TYPE_NAMES = {
  RBB:   'Released on Bail Bond',
  RPR:   'Released Personal Recognizance',
  ROA:   'Released Own Recognizance',
  RCB:   'Released Cash Bail',
  RCC:   'Released Credit for Time Served',
  RCD:   'Released Court Disposition',
  MIS:   'Mistaken Identity',
  RTR:   'Released to Rehab/Treatment',
  RCT:   'Released Court Order',
  RFTA:  'Released FTA / Dismissed',
  RNCM:  'No Charges Filed',
  RNHM:  'No Hold',
  RNF:   'Released — No Charges Filed',
  RBM:   'Released by Magistrate',
  RPA:   'Released — Prosecution Declined',
  JRRPR: 'Jail Release Record — Personal Recognizance',
  JRRCB: 'Jail Release Record — Cash Bail',
  SRRPR: 'Sheriff Release Record — Personal Recognizance',
  EHM:   'Electronic Home Monitoring',
  // The four below are the site operator's own identification of these
  // low-frequency codes, not independently verified against an official
  // Mason County glossary.
  IAB:   'Released to Indian Affairs Bureau',
  IEA:   'Involuntary Emergency Admission (Mental Health Hold)',
  TRT:   'Released to Treatment',
};

// Contact form (/contact). Every submission is appended to CONTACT_LOG_FILE
// first, then emailed via Resend — so a missing key or a Resend outage never
// loses a message. Proton has no SMTP for @proton.me addresses, so Proton is
// only the destination. onboarding@resend.dev can only deliver to the Resend
// account owner's address, which works as long as that's CONTACT_TO; switch
// CONTACT_FROM to an @wajaildata.org sender once the domain is verified.
export const RESEND_API_KEY = process.env.RESEND_API_KEY;
export const CONTACT_TO = process.env.CONTACT_TO || 'wajaildata@proton.me';
export const CONTACT_FROM = process.env.CONTACT_FROM || 'WA Jail Data <onboarding@resend.dev>';
export const CONTACT_LOG_FILE = path.join(STORAGE_DIR, 'contact_messages.jsonl');
