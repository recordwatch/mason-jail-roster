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
// counts across all four county monitors, not just Mason's own data.
export const SIBLING_MONITORS = [
  { name: 'kitsap',   base: 'https://recordwatch.github.io/ksco-scraper/data' },
  { name: 'pierce',   base: 'https://recordwatch.github.io/pierce-jail-roster/data' },
  { name: 'thurston', base: 'https://recordwatch.github.io/thurston-jail-roster/data' },
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
  DMHP:  'Designated Mental Health Professional (Involuntary Treatment Act Hold)',
  // The four below are the site operator's own identification of these
  // low-frequency codes, not independently verified against an official
  // Mason County glossary.
  IAB:   'Released to Bureau of Indian Affairs / Tribal Custody',
  IEA:   'Involuntary Emergency Admission (Mental Health Hold)',
  TRT:   'Released to Tactical Response Team (SWAT) Custody',
  MOBS:  'Released to Mobile Operations/Service Unit Custody',
};
