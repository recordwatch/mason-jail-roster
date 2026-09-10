import express from 'express';
import fs from 'fs';
import path from 'path';
import PDFParser from 'pdf-parse';
import { extractBookings } from '../parser.js';
import { fetchReleaseStats, computeTimeServed } from '../roster-data.js';
import { parseBookingDate, toIsoDateTime } from '../utils.js';
import { STORAGE_DIR, RELEASE_STATS_HISTORY_FILE, PDF_URL, RELEASE_STATS_URL } from '../config.js';

// Auth (requireAdminKey) is applied at the app level in server.js via
// app.use('/api/admin', ...) / app.use('/api/debug', ...) before this
// router is mounted, so every route below is already gated by the admin key.
const router = express.Router();

// Fixing the release counter for accurate contexttt
router.get('/api/admin/fix-releases', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');

    let fixed = 0;
    let currentDate = null;
    const fixedLines = [];

    for (const line of lines) {
      // Track the current date context from ANY dated entry (BOOKED or RELEASED with valid dates).
      // Accepts ISO ("2026-02-09T10:02:00") or legacy ("02/09/26 10:02:00") lines.
      const dateMatch = line.match(/(?:Booked|Released):\s+(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}|(?:Booked|Released):\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+\d{1,2}:\d{2}:\d{2}/);
      if (dateMatch) {
        currentDate = dateMatch[1] || toIsoDateTime(dateMatch[2]);
      }

      // Also check for release dates without times (like "Released: 2026-02-09")
      const releaseDateOnlyMatch = line.match(/Released:\s+(\d{4}-\d{2}-\d{2})(?:\s|$|\|)/);
      if (releaseDateOnlyMatch && !line.includes('T00:00:00')) {
        currentDate = releaseDateOnlyMatch[1];
      }

      // Fix broken RELEASED entries
      if (line.includes('RELEASED |') && line.includes('Released: Not Released')) {
        if (currentDate) {
          // Replace "Released: Not Released" with "Released: DATE T00:00:00"
          const fixedLine = line.replace('Released: Not Released', `Released: ${currentDate}T00:00:00`);
          fixedLines.push(fixedLine);
          fixed++;
        } else {
          // No date context available, keep the line as-is
          fixedLines.push(line);
        }
      } else {
        fixedLines.push(line);
      }
    }

    // Backup original
    fs.writeFileSync(logFile + '.backup-' + Date.now(), content);

    // Write fixed version
    fs.writeFileSync(logFile, fixedLines.join('\n'));

    res.json({
      success: true,
      fixed: fixed,
      message: `Fixed ${fixed} release entries. Original backed up.`
    });

  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// One-time migration: convert historical "MM/DD/YY HH:MM:SS" dates in
// change_log.txt and release_stats_history.json to our ISO storage format.
// Safe to run more than once — already-ISO dates don't match the legacy
// pattern, so re-running is a no-op. Backs up both files before writing.
function migrateLegacyDateLine(line) {
  return line.replace(
    /(Booked|Released):\s+(\d{1,2}\/\d{1,2}\/\d{2,4})(?:\s+(\d{1,2}:\d{2}:\d{2}))?/g,
    (full, label, datePart, timePart) => `${label}: ${toIsoDateTime(datePart, timePart)}`
  );
}

router.get('/api/admin/migrate-dates-to-iso', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    let logLinesChanged = 0, logTotalLines = 0;

    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n');
      logTotalLines = lines.length;
      const migratedLines = lines.map(migrateLegacyDateLine);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== migratedLines[i]) logLinesChanged++;
      }
      fs.writeFileSync(logFile + '.backup-iso-' + Date.now(), content);
      fs.writeFileSync(logFile, migratedLines.join('\n'));
    }

    let histChanged = 0, histTotal = 0;
    if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
      const rawHist = fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8');
      const history = JSON.parse(rawHist);
      histTotal = history.length;
      const migratedHistory = history.map(entry => {
        const m = (entry.releaseDateTime || '').match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}:\d{2}:\d{2})$/);
        if (!m) return entry;
        histChanged++;
        return { ...entry, releaseDateTime: toIsoDateTime(m[1], m[2]) };
      });
      fs.writeFileSync(RELEASE_STATS_HISTORY_FILE + '.backup-iso-' + Date.now(), rawHist);
      fs.writeFileSync(RELEASE_STATS_HISTORY_FILE, JSON.stringify(migratedHistory, null, 2));
    }

    res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a1a1f;color:#C4D8E6;padding:2rem;">
      <h2>✓ Date Migration Complete</h2>
      <p><b>change_log.txt:</b> ${logLinesChanged} / ${logTotalLines} lines converted to ISO</p>
      <p><b>release_stats_history.json:</b> ${histChanged} / ${histTotal} entries converted to ISO</p>
      <p style="color:#6A8A96;">Both files backed up before changes (.backup-iso-&lt;timestamp&gt;).</p>
      <a href="/api/history" style="color:#4B8FA8;">→ View History</a> &nbsp;
      <a href="/api/stats" style="color:#4B8FA8;">→ View Stats</a> &nbsp;
      <a href="/api/deepstats" style="color:#4B8FA8;">→ View Deep Stats</a>
    </body></html>`);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Backfill time served for all historical entries using actual book date → release date.
// Fixes both change_log.txt (display) and release_stats_history.json (stats calculations).
router.get('/api/admin/backfill-time-served', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');

    // Matches either our ISO storage format or the legacy "MM/DD/YY HH:MM:SS" format.
    const dateToken = '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4} \\d{1,2}:\\d{2}:\\d{2})';

    // ── Step 1: Build name → [{bookDate, lineIdx}] from BOOKED entries ────────
    const content = fs.readFileSync(logFile, 'utf-8');
    const logLines = content.split('\n');
    const bookMap = new Map();

    for (let i = 0; i < logLines.length; i++) {
      const m = logLines[i].match(new RegExp(`^BOOKED \\| (.+?) \\| Booked: ${dateToken}`));
      if (!m) continue;
      const name = m[1].trim();
      const bookDate = m[2].trim();
      if (!bookMap.has(name)) bookMap.set(name, []);
      bookMap.get(name).push({ bookDate, lineIdx: i });
    }

    // Find the most recent booking for a name that occurred before a given release
    const findBookDate = (name, releaseDateTime, releaseLineIdx) => {
      const releaseDate = parseBookingDate(releaseDateTime);
      if (!releaseDate) return null;
      const bookings = bookMap.get(name) || [];
      let best = null, bestDate = null;
      for (const b of bookings) {
        if (releaseLineIdx !== null && b.lineIdx >= releaseLineIdx) continue;
        const bd = parseBookingDate(b.bookDate);
        if (!bd || bd >= releaseDate) continue;
        if (!bestDate || bd > bestDate) { best = b.bookDate; bestDate = bd; }
      }
      return best;
    };

    // ── Step 2: Fix RELEASED lines in change_log.txt ──────────────────────────
    let logFixed = 0, logSkipped = 0;
    const fixedLines = [...logLines];

    for (let i = 0; i < logLines.length; i++) {
      const line = logLines[i];
      if (!line.startsWith('RELEASED | ')) continue;

      const m = line.match(new RegExp(`^RELEASED \\| (.+?) \\| Released: ${dateToken}`));
      if (!m) { logSkipped++; continue; }

      const name = m[1].trim();
      const releaseDateTime = m[2].trim();
      const bookDate = findBookDate(name, releaseDateTime, i);
      if (!bookDate) { logSkipped++; continue; }

      const computed = computeTimeServed(bookDate, releaseDateTime);
      if (!computed) { logSkipped++; continue; }

      let newLine;
      if (line.includes('| Time served:')) {
        newLine = line.replace(/\| Time served: \S+/, '| Time served: ' + computed);
      } else {
        // Insert time served right after the release date/time
        newLine = line.replace(
          new RegExp(`(Released: ${dateToken})(\\s*\\|)`),
          '$1 | Time served: ' + computed + '$2'
        );
      }

      if (newLine !== line) { fixedLines[i] = newLine; logFixed++; }
      else logSkipped++;
    }

    fs.writeFileSync(logFile + '.backup-ts-' + Date.now(), content);
    fs.writeFileSync(logFile, fixedLines.join('\n'));

    // ── Step 3: Fix release_stats_history.json ────────────────────────────────
    let histFixed = 0, histSkipped = 0;

    if (fs.existsSync(RELEASE_STATS_HISTORY_FILE)) {
      const rawHist = fs.readFileSync(RELEASE_STATS_HISTORY_FILE, 'utf-8');
      const history = JSON.parse(rawHist);

      for (const entry of history) {
        const bookDate = findBookDate(entry.name, entry.releaseDateTime, null);
        if (!bookDate) { histSkipped++; continue; }
        const computed = computeTimeServed(bookDate, entry.releaseDateTime);
        if (!computed) { histSkipped++; continue; }
        entry.timeServed = computed;
        histFixed++;
      }

      fs.writeFileSync(RELEASE_STATS_HISTORY_FILE + '.backup-ts-' + Date.now(), rawHist);
      fs.writeFileSync(RELEASE_STATS_HISTORY_FILE, JSON.stringify(history, null, 2));
    }

    res.send(`<!DOCTYPE html><html><body style="font-family:monospace;background:#0a1a1f;color:#C4D8E6;padding:2rem;">
      <h2>✓ Backfill Complete</h2>
      <p><b>change_log.txt:</b> fixed ${logFixed} entries, skipped ${logSkipped}</p>
      <p><b>release_stats_history.json:</b> fixed ${histFixed} entries, skipped ${histSkipped}</p>
      <p style="color:#6A8A96;">Both files backed up before changes. Stats will reflect corrected times immediately.</p>
      <a href="/api/stats" style="color:#4B8FA8;">→ View Stats</a> &nbsp;
      <a href="/api/deepstats" style="color:#4B8FA8;">→ View Deep Stats</a>
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

router.get('/api/admin/deduplicate', (req, res) => {
  try {
    const logFile = path.join(STORAGE_DIR, 'change_log.txt');
    const content = fs.readFileSync(logFile, 'utf-8');

    const lines = content.split('\n');
    const uniqueLines = [...new Set(lines)]; // Remove duplicates

    const deduped = uniqueLines.join('\n');

    // Backup original
    fs.writeFileSync(logFile + '.backup', content);

    // Write deduplicated version
    fs.writeFileSync(logFile, deduped);

    res.json({
      success: true,
      originalLines: lines.length,
      uniqueLines: uniqueLines.length,
      removed: lines.length - uniqueLines.length
    });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

router.get('/api/admin/merge', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Merge Old Logs</title>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial; background: #070907; color: #C8C87A; padding: 2rem; }
    .container { max-width: 800px; margin: 0 auto; }
    textarea { width: 100%; height: 400px; background: #152B17; color: #C8C87A; border: 1px solid #1E3522; padding: 1rem; font-family: monospace; font-size: 10pt; }
    button { background: #6B7A2A; color: #fff; border: none; padding: 1rem 2rem; font-size: 1rem; cursor: pointer; border-radius: 8px; margin-top: 1rem; }
    button:hover { background: #C8C87A; }
    .result { margin-top: 1rem; padding: 1rem; background: #152B17; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Merge Old Change Logs</h1>
    <p>Paste your old change log text below and click Merge</p>
    <textarea id="logText" placeholder="Paste old change log entries here..."></textarea>
    <button onclick="mergeLogs()">Merge Logs</button>
    <div id="result" class="result" style="display:none;"></div>
  </div>
  <script>
    async function mergeLogs() {
      const text = document.getElementById('logText').value;
      if (!text.trim()) {
        alert('Please paste some log text first');
        return;
      }

      const response = await fetch('/api/admin/merge-logs', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text
      });

      const result = await response.json();
      const resultDiv = document.getElementById('result');
      resultDiv.style.display = 'block';

      if (result.success) {
        resultDiv.innerHTML = '✓ Success! Old logs merged. <a href="/api/stats" style="color: #6B7A2A;">View Stats Dashboard</a>';
        document.getElementById('logText').value = '';
      } else {
        resultDiv.innerHTML = '✗ Error: ' + result.error;
      }
    }
  </script>
</body>
</html>`);
});

router.post('/api/admin/merge-logs', (req, res) => {
  try {
    let body = '';

    req.on('data', chunk => {
      body += chunk.toString();
    });

    req.on('end', () => {
      const logFile = path.join(STORAGE_DIR, 'change_log.txt');

      // Append old content to current log
      fs.appendFileSync(logFile, '\n' + body);

      res.json({ success: true, message: 'Old logs merged successfully!' });
    });

  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// View full change log
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
