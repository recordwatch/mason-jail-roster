import fs from 'fs';
import PDFParser from 'pdf-parse';
import { parseBookingDate, toIsoDateTime, extractLabeledDate } from './utils.js';
import { RELEASE_STATS_URL, RELEASE_STATS_HISTORY_FILE, RELEASE_TYPE_NAMES } from './config.js';
import { insertRelease } from './events.js';

async function fetchReleaseStats() {
  try {
    const response = await fetch(RELEASE_STATS_URL);
    if (!response.ok) return new Map();

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);

    const releaseMap = new Map();
    const lines = result.text.split('\n').map(l => l.trim()).filter(l => l);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for lines starting with date/time
      const dateMatch = line.match(/^(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2}:\d{2})(.*)$/);
      if (!dateMatch) continue;

      const date = dateMatch[1];
      const time = dateMatch[2];
      let rest = dateMatch[3].trim();

      // Accumulate subsequent lines that are part of this record
      let fullText = rest;
      let j = i + 1;

      // Keep adding lines until we hit another date or run out
      while (j < lines.length && !/^\d{2}\/\d{2}\/\d{2}/.test(lines[j])) {
        fullText += ' ' + lines[j];
        j++;
      }

      // Now parse the complete record
      // Pattern: NAME RELEASE_TYPE TIME_SERVED BAIL
      // Example: "BARNACASCEL, LEON D.RNF3 d 3 h 27 m$0.00"
      // Example: "HILARIO GARCIA, JESSICA G. RPR 0 d 23 h 9 m $0.00"

      const recordMatch = fullText.match(/^(.+?)\s*([A-Z]{2,5})\s*(\d+\s*d\s*\d+\s*h\s*\d+\s*m)\s*\$?([\d,]+\.\d{2})/);

      if (recordMatch) {
        const rawName = recordMatch[1];
        const releaseType = recordMatch[2];
        const timeServed = recordMatch[3];
        const bail = recordMatch[4];

        // Clean up name
        const cleanName = rawName.trim()
          .replace(/\s+/g, ' ')
          .replace(/\.\s*$/, '')
          .replace(/\s*\.\s*$/, '');

        releaseMap.set(cleanName, {
          releaseDateTime: toIsoDateTime(date, time),
          releaseType,
          timeServed: timeServed.replace(/\s+/g, ''),
          bail: `$${bail}`
        });

        // Skip the lines we consumed
        i = j - 1;
      }
    }

    console.log(`✓ Parsed ${releaseMap.size} releases from PDF`);

    // Save new entries to history file (dedup by name+releaseDateTime)
    try {
      let history = [];
      if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
        history = JSON.parse(fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8'));
      }
      const existingKeys = new Set(history.map(e => e.name + '|' + e.releaseDateTime));
      let newCount = 0;
      for (const [name, info] of releaseMap.entries()) {
        const key = name + '|' + info.releaseDateTime;
        if (!existingKeys.has(key)) {
          history.push({ name, ...info });
          existingKeys.add(key);
          newCount++;
        }
      }
      if (newCount > 0) {
        fs.writeFileSync(RELEASE_STATS_HISTORY_FILE, JSON.stringify(history, null, 2));
        console.log(`✓ Saved ${newCount} new releases to history (total: ${history.length})`);
      }
    } catch (e) {
      console.error('Error saving release stats history:', e);
    }

    // Dual-write: also insert into SQLite. The releases table's UNIQUE
    // constraint on (name, release_date_time) handles dedup, same as the
    // existingKeys check above does for the JSON file.
    try {
      for (const [name, info] of releaseMap.entries()) {
        insertRelease({ name, releaseDateTime: info.releaseDateTime, releaseType: info.releaseType, timeServed: info.timeServed, bail: info.bail });
      }
    } catch (e) {
      console.error('Error saving release stats to SQLite:', e);
    }

    return releaseMap;
  } catch (error) {
    console.error('Error fetching release stats:', error);
    return new Map();
  }
}

// Compute actual time served from book date string → release date string.
// Both dates are in our ISO storage format ("YYYY-MM-DDTHH:MM:SS").
// We calculate this ourselves rather than trusting the PDF's own time-served field,
// which tracks time in the current booking stint and can be far shorter than reality.
function computeTimeServed(bookDateStr, releaseDateTimeStr) {
  try {
    const booked = parseBookingDate(bookDateStr);
    const released = parseBookingDate(releaseDateTimeStr);
    if (!booked || !released || isNaN(booked) || isNaN(released)) return null;
    const diffMs = released - booked;
    if (diffMs <= 0) return null;
    const totalMins = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMins / 1440);
    const hours = Math.floor((totalMins % 1440) / 60);
    const mins = totalMins % 60;
    return `${days}d${hours}h${mins}m`;
  } catch (e) {
    return null;
  }
}

// Format functions
function formatBooked(b) {
  const chargeText = b.charges && b.charges.length > 0 ? b.charges.join(", ") : "None listed";
  return b.name + " | Booked: " + b.bookDate + " | Charges: " + chargeText;
}
function formatReleased(b, stats, isPending = false) {
  const chargeText = b.charges && b.charges.length > 0 ? b.charges.join(", ") : "None listed";
  const releaseInfo = stats.get(b.name);
  if (releaseInfo) {
    const bailAmount = parseFloat(releaseInfo.bail.replace(/[$,]/g, ''));
    const bailText = bailAmount > 0 ? " | Bail Posted: " + releaseInfo.bail : "";

    // Compute time served from the roster's actual book date → PDF's release date/time.
    // The PDF's own time-served field tracks time in the current stint only and is often wrong.
    const computed = (b.bookDate && b.bookDate !== 'Unknown')
      ? computeTimeServed(b.bookDate, releaseInfo.releaseDateTime)
      : null;
    const timeServedStr = computed || releaseInfo.timeServed;

    return {
      text: b.name + " | Released: " + releaseInfo.releaseDateTime +
            " | Time served: " + timeServedStr +
            bailText +
            " (" + (RELEASE_TYPE_NAMES[releaseInfo.releaseType] || releaseInfo.releaseType) + ")" +
            " | Charges: " + chargeText,
      hasPendingDetails: false
    };
  }

  // No match in release PDF — compute time served from book date to detection time.
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const releaseDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const computedNoMatch = (b.bookDate && b.bookDate !== 'Unknown')
    ? computeTimeServed(b.bookDate, releaseDate)
    : null;
  const timeServedSuffix = computedNoMatch ? ' | Time served: ' + computedNoMatch : '';

  return {
    text: b.name + " | Released: " + releaseDate + timeServedSuffix + " | Charges: " + chargeText,
    hasPendingDetails: false
  };
}

// Mason's release-stats PDF tags some releases with a record-source prefix
// glued onto the same reason code used everywhere else — JRR (Jail Release
// Record), SRR (Sheriff Release Record), IIR (a third report section) — so
// e.g. JRRCB and IIRBM are the exact same release reason as RCB and RBM,
// just logged from a different section. Strip the prefix and resolve back
// to the plain code so one release reason isn't split three ways in stats.
function resolveReleaseTypeCode(code) {
  if (!code) return code;
  const upper = code.toUpperCase().trim();
  for (const prefix of ['JRR', 'SRR', 'IIR']) {
    if (upper.startsWith(prefix) && upper.length > prefix.length) {
      const base = 'R' + upper.slice(prefix.length);
      if (Object.prototype.hasOwnProperty.call(RELEASE_TYPE_NAMES, base)) return base;
    }
  }
  return upper;
}

// Normalize release type codes into consolidated buckets
function normalizeReleaseType(code) {
  if (!code) return 'UNK';
  const upper = resolveReleaseTypeCode(code);
  if (['RPR', 'ROA'].includes(upper)) return 'PR';
  if (['RBB', 'RCB'].includes(upper)) return 'BAIL';
  if (['RNHM', 'MIS'].includes(upper)) return 'NO_HOLD';
  return upper;
}

// Normalize charge strings to collapse near-duplicates
function normalizeCharge(charge) {
  if (!charge) return '';
  // Strip a leading RCW-style statute citation — e.g. "46.61.021", "9A.56.360",
  // "9a.56.360" (lowercase title letter), optionally followed by a subsection
  // like "(6)(A)", with or without a space before the offense text — and
  // separately strip a bare leading parenthetical qualifier like "(O)" when
  // there's no statute code at all (e.g. "(O)Traffic Accident"). Real
  // production data has all of these variants.
  let c = charge.trim()
    .replace(/^\d+[A-Za-z]?(\.\d+)*(\([^)]*\))*\s*/, '')
    .replace(/^\([^)]*\)\s*/, '')
    .trim();
  const u = c.toUpperCase();

  // Below, several categories fold together charges that read as distinct
  // offenses but are, per the site operator's own review of the data,
  // the same real-world category — often two fragments of one offense
  // description that wrapped across lines in the source PDF (see the
  // continuation-joining fix in parser.js), other times just inconsistent
  // labeling of the same charge across records.
  if (/^PROBATION$|PROBATION.*(VIOL|VIO)|PAROLE.*(VIOL|VIO)/.test(u))                   return 'PROBATION VIOLATION';
  if (/^ASSAULT|SIMPLE ASSAULT|^KNIFE$/.test(u))                                        return 'ASSAULT';
  if (/CONTROLLED SUBSTANCE|SIMPLE POSSESSION|^SIMPLE$|^POSESSION$|^POSSESSION$|^CONT SUBST$|PARAPHENALIA|PARAPHERNALIA/.test(u)) return 'DRUG POSSESSION';
  if (/^PROTECT$|VIOLATION.*(NO.CONTACT|NCO)|NO.CONTACT.*(VIOL|VIO)|PROPECT|PROTECT.*ORDER|PROTECTION.*ORDER/.test(u)) return 'PROTECTION ORDER VIOLATION';
  if (/FAILURE.TO.APPEAR|WARRANT.ARREST/.test(u))                                        return 'FAILURE TO APPEAR';
  if (/SEX OFFENSE|SEX.*OFFENDER/.test(u))                                               return 'SEX OFFENSE';
  if (/STRONGARM/.test(u))                                                               return 'Robbery/Burglary (Strongarm)';
  if (/^RESISTING$|INTERFERING.*POLICE|OBSTRUCTING.*JUSTICE|^POLICE$/.test(u))           return 'RESISTING/OBSTRUCTING LAW ENFORCEMENT';
  if (/^BURGLARY|^RESIDENT$|UNLAWF.*ENT/.test(u))                                        return 'BURGLARY';
  if (/^THEFT$|^PROPERTY$/.test(u))                                                      return 'THEFT';
  if (/^THREATENING|^INTIMIDATION/.test(u))                                              return 'THREATENING/INTIMIDATION';
  if (/^KIDNAPPING|^ABDUCTION/.test(u))                                                  return 'KIDNAPPING';
  if (/^RECEIVE$|POSESS.*STOLEN|POSSESS.*STOLEN/.test(u))                                return 'RECEIVING/POSSESSING STOLEN PROPERTY';
  if (/FRAUD|FORGERY|^CREDIT CARD$|IMPERSONATION/.test(u))                               return 'FRAUD';
  if (/\bDUI\b|^ALCOHOL OFFENSE$/.test(u))                                               return 'DUI / ALCOHOL OFFENSE';
  if (/^VEHICLE:\s*AUTOMOBILE$|FROM MTR VEH/.test(u))                                    return 'THEFT FROM MOTOR VEHICLE';
  if (/^ALL OTHER$|^OTHER$|^NOT CLASSIFIED$/.test(u))                                    return 'OTHER';

  return c.trim();
}

// Helper function to extract date from log line
function extractDateFromLine(line) {
  const booked = extractLabeledDate(line, 'Booked');
  if (booked) return booked;

  const released = extractLabeledDate(line, 'Released');
  if (released) return released;

  // If no valid date found, return current date
  return new Date();
}

export {
  fetchReleaseStats,
  computeTimeServed,
  formatBooked,
  formatReleased,
  normalizeReleaseType,
  resolveReleaseTypeCode,
  normalizeCharge,
  extractDateFromLine
};
