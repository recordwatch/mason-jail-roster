# Washington Jail Data

A public records monitor for Washington State jail rosters, available at [wajaildata.org](https://wajaildata.org).

## What It Does

- Monitors the Mason County Jail roster PDF for bookings and releases
- Logs every booking and release with timestamp, charges, time served, bail, and release type
- Displays a searchable, date-grouped booking and release log
- Tracks release type statistics and booking trends over time

## Pages

| Route | Description |
|---|---|
| `/` | Directory — links to county monitors |
| `/api/history` | Mason County Jail Roster Monitor (bookings & releases log) |
| `/api/stats` | Statistics dashboard |
| `/api/deepstats` | Extended stats and release type breakdown |

## Data Source

Mason County Sheriff's Office — public records PDF updated every 48 hours:
`https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf`

## Related Monitors

- [Kitsap County Jail Monitor](https://theonlytacocat.github.io/ksco-scraper/)
- [Pierce County Jail Monitor](https://theonlytacocat.github.io/pierce-jail-roster/)

## Stack

- Node.js / Express
- Deployed on Railway with a persistent volume for log data
- DNS via Cloudflare → Railway
