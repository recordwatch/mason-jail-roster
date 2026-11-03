import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { renderHubMap, HUB_MONITORS } from '../hub-map.js';

const MAP = JSON.parse(fs.readFileSync(new URL('../wa-counties.json', import.meta.url), 'utf-8'));
const html = renderHubMap();

test('wa-counties.json has all 39 Washington counties', () => {
  assert.equal(MAP.counties.length, 39);
  assert.equal(new Set(MAP.counties.map(c => c.name)).size, 39);
});

test('every monitored county matches a county shape', () => {
  // A typo here would silently leave the county grey and unclickable.
  const names = new Set(MAP.counties.map(c => c.name));
  for (const m of HUB_MONITORS.filter(m => m.county)) {
    assert.ok(names.has(m.county), `no county shape named "${m.county}"`);
  }
});

test('each monitor appears once on the map and once in the list', () => {
  for (const m of HUB_MONITORS) {
    const href = `href="${m.url}"`;
    assert.equal(html.split(href).length - 1, 2, `${m.label}: expected 2 links to ${m.url}`);
  }
});

test('external monitors open in a new tab; Mason stays in this tab', () => {
  const mason = html.match(/<a href="\/api\/history"[^>]*>/g);
  assert.ok(mason && mason.every(a => !a.includes('target=')));
  assert.ok(html.includes('href="https://recordwatch.github.io/clark-county-monitor/" target="_blank" rel="noopener noreferrer"'));
});

test('unmonitored counties are kept out of the keyboard tab order', () => {
  const unmonitored = html.match(/<path class="county" tabindex="-1"/g) || [];
  const monitoredCounties = HUB_MONITORS.filter(m => m.county).length;
  assert.equal(unmonitored.length, 39 - monitoredCounties);
});

test('legend counts monitors and roster links from the list, not a hardcoded number', () => {
  // Only `roster` entries are bare county roster links; every other entry
  // is one of our monitors and must render (and be counted) as monitored.
  const monitored = HUB_MONITORS.filter(m => m.county && !m.roster);
  const rosters = HUB_MONITORS.filter(m => m.county && m.roster);
  assert.ok(html.includes(`Actively monitored (${monitored.length} counties)`));
  assert.ok(html.includes(`County roster link (${rosters.length} counties)`));
  for (const m of monitored) {
    assert.ok(html.includes(`aria-label="${m.label} jail monitor"`), `${m.label} should render as a monitor`);
    assert.ok(new RegExp(`href="${m.url}"[^>]* class="monitored"`).test(html), `${m.label} should be bright green`);
  }
  for (const m of rosters) {
    assert.ok(html.includes(`aria-label="${m.label} jail roster"`), `${m.label} should render as a roster link`);
  }
});

test('every map link has a hover hint, so the caption never reads "null"', () => {
  const links = html.match(/<a [^>]*data-name="[^"]*"[^>]*>/g);
  assert.ok(links.every(a => /data-hint="open (monitor|county roster)"/.test(a)));
});
