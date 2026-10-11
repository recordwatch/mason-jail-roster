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
| `/` | Directory — clickable Washington county map plus a list of every monitor |
| `/api/history` | Mason County Jail Roster Monitor (bookings & releases log) |
| `/api/stats` | Statistics dashboard |
| `/api/deepstats?key=…` | Extended stats and release type breakdown (admin key required — lists individuals) |

## Data Source

Mason County Sheriff's Office — public records PDF updated every 48 hours:
`https://hub.masoncountywa.gov/sheriff/reports/incustdy.pdf`

## Related Monitors

Every monitor the hub links to is listed in `HUB_MONITORS` in `hub-map.js`.

### Adding a monitor to the hub map

1. Add one line to `HUB_MONITORS` in `hub-map.js`: the county name exactly as
   it appears in `wa-counties.json` (e.g. `'Grays Harbor'`), a label, and the
   monitor's URL. A non-county jail (like Nisqually) needs a marker instead.
2. Run `npm test` — it fails if the county name doesn't match a map shape.

The map shapes in `wa-counties.json` were generated once from the Census-
derived [`us-atlas`](https://github.com/topojson/us-atlas) package
(`counties-10m`), projected for Washington; they don't need regenerating.

## Stack

- Node.js / Express
- Deployed on Railway with a persistent volume for log data
- DNS via Cloudflare → Railway
