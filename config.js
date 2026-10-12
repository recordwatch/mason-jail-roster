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
export const SIBLING_MONITORS = [
  { name: 'kitsap',       base: 'https://recordwatch.github.io/ksco-scraper/data' },
  { name: 'pierce',       base: 'https://recordwatch.github.io/pierce-jail-roster/data' },
  { name: 'thurston',     base: 'https://recordwatch.github.io/thurston-jail-roster/data' },
  { name: 'whatcom',      base: 'https://recordwatch.github.io/whatcom-jail-monitor/data' },
  { name: 'clallam',      base: 'https://recordwatch.github.io/clallam-jail-monitor/data' },
  { name: 'grays-harbor', base: 'https://recordwatch.github.io/grays-harbor-jail-monitor/data' },
  { name: 'king',         base: 'https://recordwatch.github.io/king-county/data' },
  { name: 'wahkiakum',    base: 'https://recordwatch.github.io/wahkiakum-jail-monitor/data' },
  { name: 'clark',        base: 'https://recordwatch.github.io/clark-jail-monitor/data' },
  { name: 'lewis',        base: 'https://recordwatch.github.io/lewis-jail-monitor/data' },
  { name: 'pacific',      base: 'https://recordwatch.github.io/pacific-jail-monitor/data' },
  { name: 'kittitas',     base: 'https://recordwatch.github.io/kittitas-jail-monitor/data' },
  { name: 'jefferson',    base: 'https://recordwatch.github.io/jefferson-jail-monitor/data' },
  { name: 'skagit',       base: 'https://recordwatch.github.io/skagit-jail-monitor/data' },
  { name: 'nisqually',    base: 'https://recordwatch.github.io/nisqually-jail-monitor/data' },
  { name: 'cowlitz',      base: 'https://recordwatch.github.io/cowlitz-jail-monitor/data' },
  { name: 'skagit',       base: 'https://recordwatch.github.io/skagit-jail-monitor/data' },
];

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
