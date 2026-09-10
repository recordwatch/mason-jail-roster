import express from 'express';
import fs from 'fs';
import path from 'path';
import PDFParser from 'pdf-parse';
import { extractBookings } from '../parser.js';
import { fetchReleaseStats } from '../roster-data.js';
import { toIsoDateTime } from '../utils.js';
import { STORAGE_DIR, RELEASE_STATS_HISTORY_FILE, PDF_URL, RELEASE_STATS_URL } from '../config.js';
import { insertEventsFromLine, insertRelease, clearAllData } from '../events.js';

// Auth (requireAdminKey) is applied at the app level in server.js via
// app.use('/api/admin', ...) / app.use('/api/debug', ...) before this
// router is mounted, so every route below is already gated by the admin key.
const router = express.Router();

// One-time (but safely re-runnable) migration: rebuild the SQLite events/
// releases tables from the current change_log.txt and release_stats_history.json.
// Wipes and reloads both tables from the text files every time it runs —
// events have no unique constraint the way releases do, so re-running an
// additive import would duplicate everything. Rebuilding from the text
// files (which dual-write keeps current) makes this idempotent and safe
// to run again if something looks off after the first run.
router.get('/api/admin/migrate-to-sqlite', (req, res) => {
  try {
    clearAllData();

    let eventLines = 0, eventsInserted = 0;
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    if (fs.existsSync(logFile)) {
      const lines = fs.readFileSync(logFile, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        eventLines++;
        eventsInserted += insertEventsFromLine(line);
      }
    }

    let releaseEntries = 0, releasesInserted = 0;
    if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
      const history = JSON.parse(fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8'));
      releaseEntries = history.length;
      for (const entry of history) {
        // release_stats_history.json entries are already ISO post date-migration,
        // but handle the legacy "MM/DD/YY HH:MM:SS" shape too just in case.
        const legacyMatch = (entry.releaseDateTime || '').match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}:\d{2})$/);
        const releaseDateTime = legacyMatch ? toIsoDateTime(legacyMatch[1], legacyMatch[2]) : entry.releaseDateTime;
        const ok = insertRelease({
          name: entry.name,
          releaseDateTime,
          releaseType: entry.releaseType,
          timeServed: entry.timeServed,
          bail: entry.bail
        });
        if (ok) releasesInserted++;
      }
    }

    res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a1a1f;color:#C4D8E6;padding:2rem;">
      <h2>✓ SQLite Migration Complete</h2>
      <p><b>events:</b> ${eventsInserted} rows inserted from ${eventLines} non-blank change_log.txt lines</p>
      <p><b>releases:</b> ${releasesInserted} / ${releaseEntries} release_stats_history.json entries inserted</p>
      <p style="color:#6A8A96;">Safe to re-run — wipes and rebuilds both tables from the text files every time.</p>
      <a href="/api/history" style="color:#4B8FA8;">→ View History</a> &nbsp;
      <a href="/api/stats" style="color:#4B8FA8;">→ View Stats</a> &nbsp;
      <a href="/api/deepstats" style="color:#4B8FA8;">→ View Deep Stats</a>
    </body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// One-time (but safely re-runnable) repair: some pasted merges via the old
// /api/admin/merge-logs endpoint concatenated two BOOKED/RELEASED records
// onto a single line with no separating newline (the pasted text lacked a
// trailing newline, so appendFileSync('\n' + body) joined it straight onto
// the next record). That garbles /api/history, since the second record's
// text ends up inside the first record's Charges field. Splits any line
// containing 2+ "BOOKED |" / "RELEASED |" markers back into separate lines
// at each marker boundary. Backs up the file before writing. No-op (and no
// backup written) if nothing is corrupted, so it's safe to re-run.
router.get('/api/admin/split-merged-log-lines', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    if (!fs.existsSync(logFile)) {
      return res.send('No log file found');
    }

    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');

    let linesFixed = 0, recordsRecovered = 0;
    const fixedLines = [];
    for (const line of lines) {
      const markerCount = (line.match(/(?:BOOKED|RELEASED) \|/g) || []).length;
      if (markerCount < 2) {
        fixedLines.push(line);
        continue;
      }
      const parts = line.split(/(?=(?:BOOKED|RELEASED) \|)/);
      linesFixed++;
      recordsRecovered += parts.length - 1;
      fixedLines.push(...parts);
    }

    if (linesFixed === 0) {
      return res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a1a1f;color:#C4D8E6;padding:2rem;">
        <h2>✓ No merged lines found</h2>
        <p>Scanned ${lines.length} lines — none had multiple BOOKED/RELEASED markers. Nothing changed, no backup written.</p>
      </body></html>`);
    }

    fs.writeFileSync(logFile + '.backup-splitlines-' + Date.now(), content);
    fs.writeFileSync(logFile, fixedLines.join('\n'));

    res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a1a1f;color:#C4D8E6;padding:2rem;">
      <h2>✓ Merged Log Lines Split</h2>
      <p><b>${linesFixed}</b> corrupted line(s) found, recovering <b>${recordsRecovered}</b> hidden record(s).</p>
      <p><b>change_log.txt:</b> ${lines.length} → ${fixedLines.length} lines</p>
      <p style="color:#6A8A96;">Original backed up before changes (.backup-splitlines-&lt;timestamp&gt;).</p>
      <a href="/api/history" style="color:#4B8FA8;">→ View History</a>
    </body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// this is where im putting the release stats debug endpoint
router.get('/api/debug/release-pdf-raw', async (req, res) => {
  try {
    const response = await fetch(RELEASE_STATS_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);

    // Get first 3000 characters of raw text
    const sample = result.text.substring(0, 3000);

    // Also try to parse and show what we get
    const lines = result.text.split('\n');
    const relevantLines = [];

    for (let i = 0; i < Math.min(50, lines.length); i++) {
      const line = lines[i];
      if (line.trim()) {
        relevantLines.push({
          index: i,
          text: line,
          length: line.length,
          startsWithDate: /^\d{2}\/\d{2}\/\d{2}/.test(line)
        });
      }
    }

    res.json({
      rawSample: sample,
      relevantLines: relevantLines
    });

  } catch (error) {
    res.json({ error: error.message });
  }
});

router.get('/api/debug/reset', (req, res) => {
  try {
    const hashFile = path.join(STORAGE_DIR, 'prev_hash.txt');
    const rosterFile = path.join(STORAGE_DIR, 'prev_roster.txt');

    let deleted = [];

    if (fs.existsSync(hashFile)) {
      fs.unlinkSync(hashFile);
      deleted.push('prev_hash.txt');
    }

    if (fs.existsSync(rosterFile)) {
      fs.unlinkSync(rosterFile);
      deleted.push('prev_roster.txt');
    }

    res.json({
      success: true,
      deleted: deleted,
      message: 'Files deleted. Now visit /api/run to capture current roster with charges.'
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug Log Tail endpoint
router.get('/api/debug/log-tail', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      // Get last 5000 characters
      const tail = content.slice(-5000);
      res.setHeader('Content-Type', 'text/plain');
      res.send(tail);
    } else {
      res.send('No log file found');
    }
  } catch (error) {
    res.send('Error: ' + error.message);
  }
});

// Debug charges enpoint I think
router.get('/api/debug/charges', async (req, res) => {
  try {
    const response = await fetch(PDF_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;

    const bookings = extractBookings(text);
    const sample = Array.from(bookings.values()).slice(0, 10).map(b => ({
      name: b.name,
      bookDate: b.bookDate,
      releaseDate: b.releaseDate,
      charges: b.charges
    }));

    res.json({
      totalInmates: bookings.size,
      sample: sample
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug endpoint to see parsed PDF text
router.get('/api/debug', async (req, res) => {
  try {
    const response = await fetch(PDF_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;

    // Get first 3000 characters
    const sample = text.substring(0, 3000);

    res.setHeader('Content-Type', 'text/plain');
    res.send(sample);
  } catch (error) {
    res.send('Error: ' + error.message);
  }
});

// Debug endpoint to see what files are in storage
router.get('/api/debug/files', (req, res) => {
  try {
    const files = fs.readdirSync(STORAGE_DIR);
    const fileDetails = files.map(f => {
      const stats = fs.statSync(path.join(STORAGE_DIR, f));
      return {
        name: f,
        size: stats.size,
        modified: stats.mtime
      };
    });
    res.json({
      storageDir: STORAGE_DIR,
      files: fileDetails
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug endpoint to see pending releases
router.get('/api/debug/pending', (req, res) => {
  try {
    const pendingFile = path.join(STORAGE_DIR, 'pending_releases.json');
    if (fs.existsSync(pendingFile)) {
      const data = JSON.parse(fs.readFileSync(pendingFile, 'utf-8'));
      res.json({
        count: data.length,
        pendingReleases: data
      });
    } else {
      res.json({ message: 'No pending releases file found' });
    }
  } catch (error) {
    res.json({ error: error.message });
  }
});

// Debug endpoint to see release stats
router.get('/api/debug/release-stats', async (req, res) => {
  try {
    const releaseStats = await fetchReleaseStats();
    res.json({
      count: releaseStats.size,
      sample: Array.from(releaseStats.entries()).slice(0, 10)
    });
  } catch (error) {
    res.json({ error: error.message });
  }
});

router.get('/api/debug/charge-lines', async (req, res) => {
  try {
    const response = await fetch(PDF_URL);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await PDFParser(buffer);
    const text = result.text;

    const blocks = text.split(/(?=Booking #:)/);
    const firstBlock = blocks.find(b => b.includes("Booking #:"));

    if (!firstBlock) {
      return res.json({ error: 'No booking blocks found' });
    }

    const lines = firstBlock.split("\n");
    const relevantLines = [];

    // Get 30 lines to see what's happening
    for (let i = 0; i < Math.min(30, lines.length); i++) {
      const t = lines[i].trim();
      relevantLines.push({
        index: i,
        text: t,
        length: t.length,
        includesStatute: t.includes("Statute"),
        includesOffense: t.includes("Offense"),
        exactMatch: t === "StatuteOffenseCourtOffenseClass"
      });
    }

    res.json({ relevantLines });
  } catch (error) {
    res.json({ error: error.message });
  }
});

// adding this so that i can view the raw data that my release stats are drawing from
router.get('/api/debug/release-history', (req, res) => {
  try {
    if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8'));
      res.json({ count: data.length, entries: data });
    } else {
      res.json({ message: 'No history file found' });
    }
  } catch (error) {
    res.json({ error: error.message });
  }
});

router.get('/api/admin/view-log', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      res.setHeader('Content-Type', 'text/plain');
      res.send(content);
    } else {
      res.send('No log file found');
    }
  } catch (error) {
    res.send('Error: ' + error.message);
  }
});

export default router;
