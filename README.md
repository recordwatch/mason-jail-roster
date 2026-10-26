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
| `/contact` | Contact form (linked from the hub footer) |
| `/api/admin/contact-messages?key=…` | Every contact submission, newest first; `emailFailed` marks ones that didn't email |

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

## Contact Form

Submissions are appended to `contact_messages.jsonl` on the volume first,
then emailed to `wajaildata@proton.me` through [Resend](https://resend.com).
Proton offers no SMTP for `@proton.me` addresses, so it's the destination only.

Railway env vars:

- `RESEND_API_KEY` — required for email. Without it, messages are still saved
  and visible at `/api/admin/contact-messages`.
- `CONTACT_FROM` — optional; defaults to `onboarding@resend.dev`, which only
  delivers to the Resend account owner's address. Sign up for Resend with
  `wajaildata@proton.me`, or verify `wajaildata.org` in Resend and set this to
  e.g. `WA Jail Data <contact@wajaildata.org>`.
- `CONTACT_TO` — optional; defaults to `wajaildata@proton.me`.

Spam defense is a hidden honeypot field plus 5 submissions per IP per hour.

## Stack

- Node.js / Express
- Deployed on Railway with a persistent volume for log data
- DNS via Cloudflare → Railway
