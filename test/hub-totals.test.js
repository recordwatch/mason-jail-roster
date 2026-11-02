import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HUB_MONITORS } from '../hub-map.js';
import { SIBLING_MONITORS, HUB_TOTALS_EXCLUDED } from '../config.js';

// The hub map (hub-map.js) and the hub totals (config.js) list the same
// monitors in two places. These tests fail when they drift apart, which is
// how 10 monitors once went missing from Current Inmates.
const siblingBases = new Set(SIBLING_MONITORS.map(m => m.base));
const externalMonitors = HUB_MONITORS.filter(m => !m.internal);

test('every monitor on the hub map is counted in the totals or deliberately excluded', () => {
  for (const m of externalMonitors) {
    const base = `${m.url}data`;
    assert.ok(
      siblingBases.has(base) || m.url in HUB_TOTALS_EXCLUDED,
      `${m.label} (${m.url}) is on the map but not in SIBLING_MONITORS or HUB_TOTALS_EXCLUDED`
    );
  }
});

test('every monitor in the totals is on the hub map', () => {
  const mapBases = new Set(externalMonitors.map(m => `${m.url}data`));
  for (const s of SIBLING_MONITORS) {
    assert.ok(mapBases.has(s.base), `${s.name} is counted in the totals but missing from the map`);
  }
});

test('no monitor is both counted and excluded', () => {
  for (const url of Object.keys(HUB_TOTALS_EXCLUDED)) {
    assert.ok(!siblingBases.has(`${url}data`), `${url} is in both lists`);
  }
});
