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
