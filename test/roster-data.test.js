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

test('normalizeCharge strips a statute prefix with no space and/or a lowercase title letter', () => {
  assert.equal(normalizeCharge('9a.56.360Theft'), 'THEFT');
  assert.equal(normalizeCharge('9a.56.360Court Commitment'), 'Court Commitment');
  assert.equal(normalizeCharge('46.61.502DUI Alcohol or Drugs'), 'DUI / ALCOHOL OFFENSE');
});

test('normalizeCharge strips a statute prefix with a subsection and/or a bare leading parenthetical', () => {
  assert.equal(normalizeCharge('46.61.502(6)(A)DUI Alcohol or Drugs'), 'DUI / ALCOHOL OFFENSE');
  assert.equal(normalizeCharge('9A.88.010 (O)Sex Offense'), 'SEX OFFENSE');
  assert.equal(normalizeCharge('(O)Traffic Accident'), 'Traffic Accident');
});

test('normalizeCharge merges Resisting/Interfering w/Police/Obstructing Justice/Police', () => {
  assert.equal(normalizeCharge('Resisting'), 'RESISTING/OBSTRUCTING LAW ENFORCEMENT');
  assert.equal(normalizeCharge('Interfering w/Police'), 'RESISTING/OBSTRUCTING LAW ENFORCEMENT');
  assert.equal(normalizeCharge('Obstructing Justice'), 'RESISTING/OBSTRUCTING LAW ENFORCEMENT');
  assert.equal(normalizeCharge('Police'), 'RESISTING/OBSTRUCTING LAW ENFORCEMENT');
  assert.equal(normalizeCharge('Resisting Interfering w/Police'), 'RESISTING/OBSTRUCTING LAW ENFORCEMENT');
});

test('normalizeCharge merges Theft and Property', () => {
  assert.equal(normalizeCharge('Theft'), 'THEFT');
  assert.equal(normalizeCharge('Property'), 'THEFT');
});

test('normalizeCharge merges Burglary/Resident/Unlawf Ent', () => {
  assert.equal(normalizeCharge('Burglary'), 'BURGLARY');
  assert.equal(normalizeCharge('Resident'), 'BURGLARY');
  assert.equal(normalizeCharge('Unlawf Ent'), 'BURGLARY');
  assert.equal(normalizeCharge('Burglary Resident Unlawf Ent'), 'BURGLARY');
});

test('normalizeCharge merges Threatening/Intimidation', () => {
  assert.equal(normalizeCharge('Threatening'), 'THREATENING/INTIMIDATION');
  assert.equal(normalizeCharge('Intimidation'), 'THREATENING/INTIMIDATION');
});

test('normalizeCharge merges Controlled Substance/Posession/Cont Subst/Paraphernalia into DRUG POSSESSION', () => {
  assert.equal(normalizeCharge('Controlled Substance'), 'DRUG POSSESSION');
  assert.equal(normalizeCharge('Posession'), 'DRUG POSSESSION');
  assert.equal(normalizeCharge('Cont Subst'), 'DRUG POSSESSION');
  assert.equal(normalizeCharge('Posess Paraphenalia'), 'DRUG POSSESSION');
});

test('normalizeCharge merges Kidnapping/Abduction', () => {
  assert.equal(normalizeCharge('Kidnapping'), 'KIDNAPPING');
  assert.equal(normalizeCharge('Abduction'), 'KIDNAPPING');
});

test('normalizeCharge merges Receive/Posess Stolen Property', () => {
  assert.equal(normalizeCharge('Receive'), 'RECEIVING/POSSESSING STOLEN PROPERTY');
  assert.equal(normalizeCharge('Posess Stolen Property'), 'RECEIVING/POSSESSING STOLEN PROPERTY');
});

test('normalizeCharge merges Sex Offense and Sex Offender Fail to Register', () => {
  assert.equal(normalizeCharge('Sex Offense'), 'SEX OFFENSE');
  assert.equal(normalizeCharge('SEX OFFENDER FAIL TO REGISTER'), 'SEX OFFENSE');
});

test('normalizeCharge merges Fraud/Forgery/Credit Card/ATM Fraud/Impersonation', () => {
  assert.equal(normalizeCharge('Fraud'), 'FRAUD');
  assert.equal(normalizeCharge('Forgery'), 'FRAUD');
  assert.equal(normalizeCharge('Credit Card'), 'FRAUD');
  assert.equal(normalizeCharge('ATM Fraud'), 'FRAUD');
  assert.equal(normalizeCharge('Fraud Impersonation'), 'FRAUD');
});

test('normalizeCharge merges DUI variants and Alcohol Offense', () => {
  assert.equal(normalizeCharge('DUI Alcohol or Drugs'), 'DUI / ALCOHOL OFFENSE');
  assert.equal(normalizeCharge('46.61.021DUI Alcohol or Drugs'), 'DUI / ALCOHOL OFFENSE');
  assert.equal(normalizeCharge('Alcohol Offense'), 'DUI / ALCOHOL OFFENSE');
});

test('normalizeCharge merges Vehicle: Automobile and From Mtr Veh', () => {
  assert.equal(normalizeCharge('Vehicle: Automobile'), 'THEFT FROM MOTOR VEHICLE');
  assert.equal(normalizeCharge('From Mtr Veh'), 'THEFT FROM MOTOR VEHICLE');
});

test('normalizeCharge merges All Other/Other/Not Classified', () => {
  assert.equal(normalizeCharge('All Other'), 'OTHER');
  assert.equal(normalizeCharge('Other'), 'OTHER');
  assert.equal(normalizeCharge('Not Classified'), 'OTHER');
});

test('normalizeCharge merges Knife into ASSAULT', () => {
  assert.equal(normalizeCharge('Knife'), 'ASSAULT');
});

test('normalizeCharge leaves an unrelated charge with "theft" as a substring alone', () => {
  assert.equal(normalizeCharge('Possess Vehicle Theft Tools'), 'Possess Vehicle Theft Tools');
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
