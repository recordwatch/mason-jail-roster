import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// roster-data.js imports events.js, which imports db.js, which opens a
// SQLite file at import time based on RAILWAY_VOLUME_MOUNT_PATH — set that
// to an isolated temp dir before roster-data.js is ever imported, same as
// events.test.js does, so tests don't touch the real /data path.
let normalizeCharge, normalizeReleaseType, resolveReleaseTypeCode;

before(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mason-roster-data-test-'));
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tmpDir;
  ({ normalizeCharge, normalizeReleaseType, resolveReleaseTypeCode } = await import('../roster-data.js'));
});

test('normalizeCharge collapses a bare "Protect" fragment into PROTECTION ORDER VIOLATION', () => {
  assert.equal(normalizeCharge('Protect'), 'PROTECTION ORDER VIOLATION');
});

test('resolveReleaseTypeCode folds JRR/SRR/IIR record-source prefixes back to the plain code', () => {
  assert.equal(resolveReleaseTypeCode('JRRPR'), 'RPR');
  assert.equal(resolveReleaseTypeCode('SRRPR'), 'RPR');
  assert.equal(resolveReleaseTypeCode('JRRCB'), 'RCB');
  assert.equal(resolveReleaseTypeCode('IIRCB'), 'RCB');
  assert.equal(resolveReleaseTypeCode('IIRBM'), 'RBM');
  assert.equal(resolveReleaseTypeCode('IIRBB'), 'RBB');
  assert.equal(resolveReleaseTypeCode('SRRBB'), 'RBB');
  assert.equal(resolveReleaseTypeCode('IIRCC'), 'RCC');
  assert.equal(resolveReleaseTypeCode('JRRCC'), 'RCC');
});

test('resolveReleaseTypeCode leaves plain and unrecognized codes alone', () => {
  assert.equal(resolveReleaseTypeCode('RPR'), 'RPR');
  assert.equal(resolveReleaseTypeCode('IAB'), 'IAB');
  assert.equal(resolveReleaseTypeCode('EHM'), 'EHM');
});

test('normalizeReleaseType groups JRRPR/SRRPR/ROA with RPR into the PR bucket', () => {
  assert.equal(normalizeReleaseType('JRRPR'), 'PR');
  assert.equal(normalizeReleaseType('SRRPR'), 'PR');
  assert.equal(normalizeReleaseType('ROA'), 'PR');
  assert.equal(normalizeReleaseType('RPR'), 'PR');
});

test('normalizeReleaseType groups JRRCB/IIRCB with RCB/RBB into the BAIL bucket', () => {
  assert.equal(normalizeReleaseType('JRRCB'), 'BAIL');
  assert.equal(normalizeReleaseType('IIRCB'), 'BAIL');
  assert.equal(normalizeReleaseType('SRRBB'), 'BAIL');
});
