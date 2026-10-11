// Clickable Washington county map for the hub page (/api/status).
//
// wa-counties.json holds pre-projected SVG paths for all 39 counties,
// generated once from the Census-derived us-atlas package (counties-10m)
// with a Washington-centered conformal conic projection, so the page needs
// no mapping library at runtime.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAP = JSON.parse(fs.readFileSync(path.join(__dirname, 'wa-counties.json'), 'utf-8'));

// Every monitor the hub links to. `county` must match a county name in
// wa-counties.json; Nisqually is a tribal jail, drawn as a marker instead.
// `internal` links stay in this tab (Mason is served by this app).
export const HUB_MONITORS = [
  { county: 'Mason',        label: 'Mason County',        url: '/api/history', internal: true },
  { county: 'Kitsap',       label: 'Kitsap County',       url: 'https://recordwatch.github.io/ksco-scraper/' },
  { county: 'Pierce',       label: 'Pierce County',       url: 'https://recordwatch.github.io/pierce-jail-roster/' },
  { county: 'Thurston',     label: 'Thurston County',     url: 'https://recordwatch.github.io/thurston-jail-roster/' },
  { county: 'Whatcom',      label: 'Whatcom County',      url: 'https://recordwatch.github.io/whatcom-jail-monitor/' },
  { county: 'Grays Harbor', label: 'Grays Harbor County', url: 'https://recordwatch.github.io/grays-harbor-jail-monitor/' },
  { county: 'Clallam',      label: 'Clallam County',      url: 'https://recordwatch.github.io/clallam-jail-monitor/' },
  { county: 'King',         label: 'King County',         url: 'https://recordwatch.github.io/king-county/' },
  { county: 'Jefferson',    label: 'Jefferson County',    url: 'https://recordwatch.github.io/jefferson-jail-roster/' },
  { county: 'Pacific',      label: 'Pacific County',      url: 'https://recordwatch.github.io/Pacific-county-monitor/' },
  { county: 'Cowlitz',      label: 'Cowlitz County',      url: 'https://recordwatch.github.io/cowlitz-county-monitor/' },
  { county: 'Wahkiakum',    label: 'Wahkiakum County',    url: 'https://recordwatch.github.io/wahkiakum-county-monitor/' },
  { county: 'Lewis',        label: 'Lewis County',        url: 'https://recordwatch.github.io/lewis-county-monitor/' },
  { county: 'Clark',        label: 'Clark County',        url: 'https://recordwatch.github.io/clark-county-monitor/' },
  { county: 'Skagit',       label: 'Skagit County',       url: 'https://recordwatch.github.io/skagit-county-monitor/' },
  { county: 'Kittitas',     label: 'Kittitas County',     url: 'https://recordwatch.github.io/kittitas-county-monitor/' },
  { county: null,           label: 'Nisqually Tribe',     url: 'https://recordwatch.github.io/nisqually-jail-monitor/', marker: 'nisqually' }
];

// Counties we checked that have no online roster to monitor.
const NO_ONLINE_ROSTER = { Klickitat: 'No online roster — posted in the jail lobby' };

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function linkAttrs(m) {
  return m.internal ? `href="${escapeHtml(m.url)}"` : `href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer"`;
}

export const HUB_MAP_CSS = `
    .map-card { background: #1B2A20; border: 1px solid #2E4433; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.75rem; }
    .wa-map { display: block; width: 100%; height: auto; }
    .wa-map .county { fill: #24332A; stroke: #3A5240; stroke-width: 0.6; }
    .wa-map a .county { fill: #6E9461; stroke: #121A15; stroke-width: 1; cursor: pointer; transition: fill 0.15s; }
    .wa-map a:hover .county, .wa-map a:focus-visible .county, .wa-map a.is-active .county { fill: #A9BE9C; }
    .wa-map a:focus { outline: none; }
    .wa-map a:focus-visible .county { stroke: #E7EBDF; stroke-width: 2; }
    .wa-map .marker { fill: #E7EBDF; stroke: #121A15; stroke-width: 2; cursor: pointer; }
    .wa-map a:hover .marker, .wa-map a:focus-visible .marker { fill: #A9BE9C; }
    .map-caption { min-height: 1.4em; margin-top: 0.5rem; font-size: 9pt; font-weight: 600; color: #E7EBDF; }
    .map-caption .muted { font-weight: 400; color: #83937C; }
    .map-legend { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; margin-top: 0.4rem; font-size: 0.65rem; color: #83937C; }
    .map-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
    .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
    .monitor-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.4rem; margin-bottom: 0.75rem; }
    .monitor-list a { display: block; padding: 0.55rem 0.75rem; background: #1B2A20; color: #C9D3C2; border: 1px solid #2E4433; border-radius: 6px; font-weight: 600; font-size: 8.5pt; }
    .monitor-list a:hover, .monitor-list a.is-active { background: #547048; color: #E7EBDF; }
    .section-label { font-size: 0.6rem; letter-spacing: 1.5px; text-transform: uppercase; color: #83937C; margin: 0.25rem 0 0.4rem; }`;

// The map (each monitored county is a link), a caption that names whatever
// is hovered/focused, a legend, and a plain list of every monitor — the
// list is the accessible/readable alternative and the fallback on small
// screens where Puget Sound counties are tight to tap.
export function renderHubMap() {
  const byCounty = new Map(HUB_MONITORS.filter(m => m.county).map(m => [m.county, m]));
  const nisqually = HUB_MONITORS.find(m => m.marker === 'nisqually');

  const shapes = MAP.counties.map(c => {
    const m = byCounty.get(c.name);
    if (!m) {
      const note = NO_ONLINE_ROSTER[c.name] || 'Not monitored';
      // tabindex -1: Chrome makes titled SVG shapes focusable, which would
      // put 23 dead stops in the keyboard tab order before the real links.
      return `<path class="county" tabindex="-1" d="${c.d}" data-name="${escapeHtml(c.name)} County" data-note="${escapeHtml(note)}"><title>${escapeHtml(c.name)} County — ${escapeHtml(note)}</title></path>`;
    }
    return `<a ${linkAttrs(m)} aria-label="${escapeHtml(m.label)} jail monitor" data-name="${escapeHtml(m.label)}"><path class="county" d="${c.d}"><title>${escapeHtml(m.label)} — open monitor</title></path></a>`;
  }).join('');

  const marker = nisqually
    ? `<a ${linkAttrs(nisqually)} aria-label="${escapeHtml(nisqually.label)} jail monitor" data-name="${escapeHtml(nisqually.label)}"><circle class="marker" cx="${MAP.nisqually.x}" cy="${MAP.nisqually.y}" r="5"><title>${escapeHtml(nisqually.label)} — open monitor</title></circle></a>`
    : '';

  const list = [...HUB_MONITORS]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(m => `<a ${linkAttrs(m)} data-name="${escapeHtml(m.label)}">${escapeHtml(m.label)}</a>`)
    .join('');

  return `
    <div class="map-card">
      <svg class="wa-map" viewBox="0 0 ${MAP.width} ${MAP.height}" role="img" aria-labelledby="wa-map-title">
        <title id="wa-map-title">Map of Washington counties with jail monitors</title>
        ${shapes}${marker}
      </svg>
      <div class="map-caption" id="map-caption"><span class="muted">Select a county to open its jail monitor</span></div>
      <div class="map-legend">
        <span><i class="swatch" style="background:#6E9461"></i>Monitored (${byCounty.size} counties)</span>
        <span><i class="swatch" style="background:#24332A;border:1px solid #3A5240"></i>Not monitored</span>
        <span><i class="swatch" style="background:#E7EBDF;border-radius:50%"></i>Nisqually tribal jail</span>
      </div>
    </div>
    <div class="section-label">All monitors</div>
    <nav class="monitor-list" aria-label="All jail monitors">${list}</nav>
    <script>
      // Name whatever county or list item is hovered/focused, and highlight
      // its twin (map shape <-> list button) so the two read as one.
      (function () {
        var caption = document.getElementById('map-caption');
        var idle = caption.innerHTML;
        var all = document.querySelectorAll('.wa-map [data-name], .monitor-list [data-name]');
        function show(el) {
          var name = el.getAttribute('data-name'), note = el.getAttribute('data-note');
          caption.innerHTML = '';
          caption.appendChild(document.createTextNode(name));
          var sub = document.createElement('span');
          sub.className = 'muted';
          sub.textContent = note ? ' — ' + note : ' — open monitor →';
          caption.appendChild(sub);
          all.forEach(function (o) { o.classList.toggle('is-active', o.getAttribute('data-name') === name && !note); });
        }
        function clear() { caption.innerHTML = idle; all.forEach(function (o) { o.classList.remove('is-active'); }); }
        all.forEach(function (el) {
          el.addEventListener('mouseenter', function () { show(el); });
          // Keyboard focus only — after a mouse click opens a monitor in a
          // new tab, the clicked county shouldn't stay highlighted here.
          el.addEventListener('focus', function () { if (el.matches(':focus-visible')) show(el); });
          el.addEventListener('mouseleave', clear);
          el.addEventListener('blur', clear);
        });
      })();
    </script>`;
}
