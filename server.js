// v2
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import PDFParser from 'pdf-parse';
import { extractBookings } from './parser.js';
import {
  fetchReleaseStats,
  computeTimeServed,
  formatBooked,
  formatReleased,
  normalizeReleaseType,
  normalizeCharge,
  extractDateFromLine
} from './roster-data.js';
import {
  parseBookingDate,
  toIsoDateTime,
  extractLabeledDate,
  formatShortDateTime,
  formatMinutes,
  parseTimeServed,
  daysBetween,
  isMidnight,
  formatDatePST
} from './utils.js';
import {
  PORT,
  PDF_URL,
  STORAGE_DIR,
  SIBLING_MONITORS,
  RELEASE_TYPE_NAMES
} from './config.js';
import { requireAdminKey } from './middleware.js';
import adminRouter from './routes/admin.js';
import { insertEventsFromLine, getAllEventLines, getAllReleases } from './events.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use('/fonts', express.static(path.join(__dirname, 'fonts')));
app.use('/api/admin', requireAdminKey);
app.use('/api/debug', requireAdminKey);
app.use(adminRouter);

// ── Sibling monitors (wajaildata.org hub totals) ──────────────────────────
const SIBLING_CACHE_TTL_MS = 5 * 60 * 1000;
const siblingCache = {}; // name -> { inCustody, changes, fetchedAt }

async function fetchSiblingMonitor(monitor) {
  try {
    const [statusRes, logRes] = await Promise.all([
      fetch(`${monitor.base}/status.json`, { signal: AbortSignal.timeout(4000) }),
      fetch(`${monitor.base}/change_log.json`, { signal: AbortSignal.timeout(4000) }),
    ]);
    const status = statusRes.ok ? await statusRes.json() : null;
    const log = logRes.ok ? await logRes.json() : null;

    const prev = siblingCache[monitor.name];
    const inCustody = status?.inCustody ?? prev?.inCustody ?? 0;
    // Each entry is one booking; a released entry represents both a booked
    // and a released change, matching how Mason's own change log counts
    // BOOKED + RELEASED lines for the same person.
    const changes = Array.isArray(log)
      ? log.reduce((sum, e) => sum + (e.status === 'released' ? 2 : 1), 0)
      : (prev?.changes ?? 0);

    siblingCache[monitor.name] = { inCustody, changes, fetchedAt: Date.now() };
  } catch (e) {
    console.error(`Failed to fetch ${monitor.name} monitor stats:`, e.message);
    // Keep whatever was last cached (if anything) rather than zeroing out.
  }
}

async function getSiblingTotals() {
  const now = Date.now();
  const stale = SIBLING_MONITORS.filter(
    m => !siblingCache[m.name] || now - siblingCache[m.name].fetchedAt > SIBLING_CACHE_TTL_MS
  );
  if (stale.length > 0) {
    await Promise.all(stale.map(fetchSiblingMonitor));
  }

  let inCustody = 0, changes = 0;
  for (const m of SIBLING_MONITORS) {
    const c = siblingCache[m.name];
    if (c) { inCustody += c.inCustody; changes += c.changes; }
  }
  return { inCustody, changes };
}

// Ensure storage directory exists
function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}
ensureStorageDir();

// Changelog endpoint for frontend
app.get('/api/changelog', (req, res) => {
  try {
    const log = getAllEventLines().join('\n');
    res.json({ success: true, log });
  } catch (error) {
    console.error('Changelog error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Redirect root to status
app.get('/', (req, res) => {
  res.redirect('/api/status');
});

// Status page
app.get('/api/status', async (req, res) => {
  const dataDir = STORAGE_DIR;
  let lastCheck = "Never";
  let inmateCount = 0;
  let changeCount = 0;
  let viewCount = 0;

  try {
    const hashFile = path.join(dataDir, "prev_hash.txt");
    if (fs.existsSync(hashFile)) {
      const stats = fs.statSync(hashFile);
      lastCheck = stats.mtime.toISOString();
    }

    const rosterFile = path.join(dataDir, "prev_roster.txt");
    if (fs.existsSync(rosterFile)) {
      const content = fs.readFileSync(rosterFile, "utf-8");
      const bookingMatches = content.match(/Booking #:/g);
      inmateCount = bookingMatches ? bookingMatches.length : 0;
    }

    changeCount = getAllEventLines().length;

    const metricsFile = path.join(dataDir, "metrics.json");
    let metrics = { statusViews: 0, historyViews: 0, emailViews: 0 };

    if (fs.existsSync(metricsFile)) {
      try {
        metrics = JSON.parse(fs.readFileSync(metricsFile, "utf-8"));
      } catch (e) {}
    }
    metrics.statusViews = (metrics.statusViews || 0) + 1;
    viewCount = metrics.statusViews;

    try {
      fs.writeFileSync(metricsFile, JSON.stringify(metrics));
    } catch (e) {
      console.error("Failed to write metrics:", e);
    }
  } catch (e) {}

  const siblingTotals = await getSiblingTotals();
  inmateCount += siblingTotals.inCustody;
  changeCount += siblingTotals.changes;

  const html = `<!DOCTYPE html>
<html>
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-D2LNWC78X7"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-D2LNWC78X7');
</script>
  <title>Washington Jail Data</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { overflow-x: hidden; width: 100%; }
    body { font-family: 'Inter', Arial, sans-serif; font-size: 8pt; background: #152220; color: #C4D8E6; min-height: 100vh; display: flex; justify-content: center; padding: 2rem 1rem; }
    .wrapper { width: 100%; max-width: 520px; }
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .county-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #A8C4D0; }
    .public-records { font-size: 0.7rem; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; color: #6A8A96; }
    h1 { font-family: 'Playfair Display', Georgia, serif; font-size: 2.5rem; font-weight: 700; color: #F5F0E8; letter-spacing: -1px; line-height: 1.1; margin-bottom: 1rem; }
    .stats-bar { background: #1A3035; border: 1px solid #22443A; border-radius: 6px; padding: 0.85rem 1.25rem; display: flex; gap: 2rem; margin-bottom: 0.75rem; }
    .stats-bar-value { font-size: 1.1rem; font-weight: 600; color: #4B8FA8; }
    .stats-bar-label { font-size: 0.6rem; letter-spacing: 1.5px; text-transform: uppercase; color: #6A8A96; margin-top: 0.1rem; }
    .nav-section { display: flex; flex-direction: column; gap: 0.5rem; margin-bottom: 0.75rem; }
    .nav-btn { display: block; padding: 0.85rem 1.25rem; background: #1A3035; color: #C4D8E6; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 9pt; border: 1px solid #22443A; transition: background 0.15s; }
    .nav-btn:hover { background: #1D4A5C; color: #F5F0E8; }
    details.status { background: #1A3035; border-radius: 6px; border: 1px solid #22443A; overflow: hidden; }
    details.status > summary { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; list-style: none; padding: 0.85rem 1.25rem; }
    details.status > summary::-webkit-details-marker { display: none; }
    .status-dot { width: 8px; height: 8px; background: #22C55E; border-radius: 50%; animation: pulse 2s infinite; flex-shrink: 0; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .status-title { font-weight: 600; color: #F5F0E8; font-size: 9pt; flex: 1; }
    .status-chevron { color: #6A8A96; font-size: 0.7rem; transition: transform 0.2s; }
    details.status[open] .status-chevron { transform: rotate(180deg); }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid #22443A; }
    .stat { padding: 0.7rem 1.25rem; border-bottom: 1px solid #22443A; border-right: 1px solid #22443A; }
    .stat:nth-child(even) { border-right: none; }
    .stat:nth-last-child(-n+2) { border-bottom: none; }
    .stat-label { font-size: 0.6rem; letter-spacing: 1px; text-transform: uppercase; color: #6A8A96; }
    .stat-value { font-weight: 600; color: #F5F0E8; font-size: 9pt; margin-top: 0.1rem; }
    .footer { margin-top: 0.75rem; }
    a { color: #4B8FA8; text-decoration: none; }
    @media (max-width: 600px) { h1 { font-size: 1.75rem; } .stats-bar { gap: 1rem; } .page-header { flex-direction: column; align-items: flex-start; gap: 0.2rem; } }
  </style>
</head>
<body>
  <div class="wrapper">
    <h1>Washington Jail Data</h1>
    <div class="stats-bar">
      <div>
        <div class="stats-bar-value">${lastCheck !== "Never" ? formatDatePST(new Date(lastCheck)) : "Never"}</div>
        <div class="stats-bar-label">Last Updated</div>
      </div>
    </div>
    <div class="nav-section">
      <a href="/api/history" class="nav-btn">Mason County Jail Roster Monitor</a>
      <a href="https://recordwatch.github.io/ksco-scraper/" target="_blank" rel="noopener noreferrer" class="nav-btn">Visit Kitsap County Jail Monitor</a>
      <a href="https://recordwatch.github.io/pierce-jail-roster/" target="_blank" rel="noopener noreferrer" class="nav-btn">Visit Pierce County Jail Monitor</a>
      <a href="https://recordwatch.github.io/thurston-jail-roster/" target="_blank" rel="noopener noreferrer" class="nav-btn">Visit Thurston County Jail Monitor</a>
    </div>
    <details class="status">
      <summary>
        <div class="status-dot"></div>
        <span class="status-title">System Active</span>
        <span class="status-chevron">▾</span>
      </summary>
      <div class="stats-grid">
        <div class="stat">
          <div class="stat-label">Last Check</div>
          <div class="stat-value">${lastCheck !== "Never" ? formatDatePST(new Date(lastCheck)) : "Never"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Current Inmates</div>
          <div class="stat-value">${inmateCount}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Changes Detected</div>
          <div class="stat-value">${changeCount}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Page Views</div>
          <div class="stat-value">${viewCount.toLocaleString()}</div>
        </div>
      </div>
    </details>
    <div class="footer">
      <a href="/legislative" style="display: inline-block; margin-top: 0.75rem; padding: 0.5rem 1rem; background: #1A3035; color: #C4D8E6; border: 1px solid #22443A; border-radius: 6px; text-decoration: none; font-size: 0.75rem;">March 13th 2026: FINAL WA Legislative Session Update</a>
    </div>
  </div>
</body>
</html>`;

  res.send(html);
});

// Adding roster csv api endpoint
app.get('/api/roster.csv', async (req, res) => {
try {
  const response = await fetch(PDF_URL);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const result = await PDFParser(buffer);
  const bookings = extractBookings(result.text);

  const rows = [['Name', 'Booking Date', 'Release Date', 'Charges']];
  for (const b of bookings.values()) {
    rows.push([
      b.name,
      b.bookDate,
      b.releaseDate,
      b.charges.join(' | ')
    ]);
  }

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="mason-county-roster.csv"');
  res.send(csv);
} catch (error) {
  res.status(500).json({ error: error.message });
}
});

// Run check
app.get('/api/run', async (req, res) => {
  try {
    ensureStorageDir();

    // Fetch main roster
    const response = await fetch(PDF_URL);
    if (!response.ok) {
      throw new Error("Failed to download PDF: " + response.status);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const pdfPath = path.join(STORAGE_DIR, "current.pdf");
    fs.writeFileSync(pdfPath, buffer);

    const result = await PDFParser(buffer);
    const text = result.text;

    const textPath = path.join(STORAGE_DIR, "current_text.txt");
    fs.writeFileSync(textPath, text);
    
    // Also save a sample block for debugging
    const sampleBlock = text.substring(0, 2000);
    const debugPath = path.join(STORAGE_DIR, "debug_sample.txt");
    fs.writeFileSync(debugPath, sampleBlock);

    // Fetch release stats
    const releaseStats = await fetchReleaseStats();

    const currentHash = crypto.createHash("md5").update(text).digest("hex");
    const timestamp = new Date().toISOString();

    const hashFile = path.join(STORAGE_DIR, "prev_hash.txt");
    const rosterFile = path.join(STORAGE_DIR, "prev_roster.txt");
    const logFile = path.join(STORAGE_DIR, "change_log.txt");
    const pendingReleasesFile = path.join(STORAGE_DIR, "pending_releases.json");

    let previousHash;
    let previousText;
    let hasChanged = false;
    let isFirstRun = false;
    let addedLines = [];
    let removedLines = [];
    
    // Load pending releases
    let pendingReleases = [];
    if (fs.existsSync(pendingReleasesFile)) {
      try {
        pendingReleases = JSON.parse(fs.readFileSync(pendingReleasesFile, "utf-8"));
      } catch (e) {
        pendingReleases = [];
      }
    }

    if (fs.existsSync(hashFile) && fs.existsSync(rosterFile)) {
      previousHash = fs.readFileSync(hashFile, "utf-8").trim();
      previousText = fs.readFileSync(rosterFile, "utf-8");
      hasChanged = currentHash !== previousHash;

      if (hasChanged) {
        const currentBookings = extractBookings(text);
        const previousBookings = extractBookings(previousText);

        for (const [id, booking] of currentBookings) {
          if (!previousBookings.has(id)) {
            addedLines.push(formatBooked(booking));
          }
        }
        
        // Track releases
        const newPendingReleases = [];
        for (const [id, booking] of previousBookings) {
          if (!currentBookings.has(id)) {
            const releaseResult = formatReleased(booking, releaseStats, true);
            removedLines.push(releaseResult.text);
            
            // If release details are pending, track it
            if (releaseResult.hasPendingDetails) {
              newPendingReleases.push({
                name: booking.name,
                bookingData: booking,
                detectedAt: timestamp
              });
            }
          }
        }
        
        // Update pending releases list
        pendingReleases = [...pendingReleases, ...newPendingReleases];
        
        addedLines = addedLines.slice(0, 30);
        removedLines = removedLines.slice(0, 30);
      }
    } else {
      isFirstRun = true;
    }
    
    // Check for updates to pending releases
    let updatedReleases = [];
    let stillPending = [];
    
    for (const pending of pendingReleases) {
      const releaseInfo = releaseStats.get(pending.name);
      if (releaseInfo) {
        // Found updated info!
        updatedReleases.push({
          name: pending.name,
          details: releaseInfo,
          charges: pending.bookingData.charges,
          bookDate: pending.bookingData.bookDate
        });
      } else {
        // Still waiting for details
        stillPending.push(pending);
      }
    }
    
    // Save updated pending list
    fs.writeFileSync(pendingReleasesFile, JSON.stringify(stillPending, null, 2));

    fs.writeFileSync(hashFile, currentHash);
    fs.writeFileSync(rosterFile, text);

      // Build log entry for roster changes
    let logEntry = "";
    
    if (isFirstRun) {
      // On first run, log all current inmates as booked
      const currentBookings = extractBookings(text);
      const allInmates = Array.from(currentBookings.values()).map(b => formatBooked(b));
      
      // Sort by booking date (newest first)
      allInmates.sort((a, b) => {
        const dateA = extractDateFromLine(a);
        const dateB = extractDateFromLine(b);
        return dateB - dateA; // Newest first
      });
      
      logEntry = allInmates.map(l => "BOOKED | " + l).join("\n") + "\n\n";
      
    } else if (hasChanged) {
      // For changes, add new bookings and releases in chronological order
      const changes = [];
      
      // Add new bookings
      addedLines.forEach(line => {
        changes.push({
          type: "BOOKED",
          line: line,
          date: extractDateFromLine(line)
        });
      });
      
      // Add releases (convert format)
      removedLines.forEach(line => {
        // Convert "Name | Booked: Date | Charges" to "Name | Released: Date | Charges"
        const releaseLine = line.replace("Booked:", "Released:");
        changes.push({
          type: "RELEASED",
          line: releaseLine,
          date: extractDateFromLine(line) || new Date() // Use booking date or current date
        });
      });
      
      // Sort changes by date (newest first)
      changes.sort((a, b) => b.date - a.date);
      
      // Format changes
      logEntry = changes.map(c => `${c.type} | ${c.line}`).join("\n") + "\n\n";
      
    } else {
      logEntry = ""; // No changes, don't add anything
    }

    fs.appendFileSync(logFile, logEntry);

    // Dual-write: also insert into SQLite, parsing the exact same text that
    // was just appended to change_log.txt so both stores can never drift.
    for (const line of logEntry.split('\n')) {
      if (line.trim()) insertEventsFromLine(line);
    }

    // Add separate entry for updated release details if any
    if (updatedReleases.length > 0) {
      const updateEntry =
        "\n================================================================================\n" +
        "Release details update at: " + timestamp +
        "\n================================================================================\n" +
        "UPDATED RELEASE INFORMATION (" + updatedReleases.length + "):\n" +
        updatedReleases.map(r => {
          const bailAmount = parseFloat(r.details.bail.replace(/[$,]/g, ''));
          const bailText = bailAmount > 0 ? " | Bail Posted: " + r.details.bail : "";
          const computed = (r.bookDate && r.bookDate !== 'Unknown')
            ? computeTimeServed(r.bookDate, r.details.releaseDateTime)
            : null;
          const timeServedStr = computed || r.details.timeServed;

          return "  ✓ " + r.name + " | Released: " + r.details.releaseDateTime +
            " | Time served: " + timeServedStr +
            bailText +
            " (" + r.details.releaseType + ")" +
            " | Charges: " + (r.charges.join(", ") || "None listed");
        }).join("\n") + "\n";
      
      fs.appendFileSync(logFile, updateEntry);
    }

    const message = isFirstRun
      ? "Initial roster captured successfully!"
      : hasChanged
        ? "Changes detected! " + addedLines.length + " new bookings, " + removedLines.length + " releases." +
          (updatedReleases.length > 0 ? " Also updated " + updatedReleases.length + " release details." : "")
        : updatedReleases.length > 0
          ? "Updated release details for " + updatedReleases.length + " inmates."
          : "No changes detected.";

    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="3;url=/api/history"><style>body{font-family:sans-serif;background:#070907;color:#C8C87A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.success{color:#6B7A2A;font-size:3rem;margin-bottom:1rem;}h1{color:#F0F0E8;margin-bottom:1rem;}p{color:#FFFFFF;}</style></head><body><div class="container"><div class="success">✓</div><h1>Workflow Complete</h1><p>' +
      message +
      "</p><p>Redirecting to Change Log...</p></div></body></html>";

    res.send(html);
  } catch (error) {
    console.error('Error in /api/run:', error);
    const html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#070907;color:#C8C87A;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}.container{text-align:center;padding:2rem;}.error{color:#ef4444;font-size:3rem;margin-bottom:1rem;}h1{color:#ef4444;margin-bottom:1rem;}p{color:#FFFFFF;}a{color:#C8C87A;}</style></head><body><div class="container"><div class="error">✗</div><h1>Error</h1><p>' +
      (error.message || "Unknown error") +
      '</p><p><a href="/api/status">Back to Status</a></p></div></body></html>';
    res.send(html);
  }
});
// Legislative session page
app.get('/legislative', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en"><html>
<head>
  <title>Washington State Legislative Session News</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', Arial, sans-serif; font-size: 9pt; background: #152220; color: #C4D8E6; min-height: 100vh; padding: 2rem; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { font-family: 'Playfair Display', Georgia, serif; font-size: 2rem; margin-bottom: 0.5rem; color: #F5F0E8; font-weight: 700; letter-spacing: -0.5px; }
    .subtitle { color: #6A8A96; margin-bottom: 2rem; }
    .back-link { display: inline-block; margin-bottom: 1.5rem; color: #4B8FA8; text-decoration: none; }
    .back-link:hover { text-decoration: underline; }
    .content { background: #1A3035; border-radius: 12px; padding: 2rem; margin-bottom: 1rem; line-height: 1.6; }
    .content h2 { font-family: 'Playfair Display', Georgia, serif; color: #4B8FA8; margin-top: 1.5rem; margin-bottom: 0.75rem; font-size: 1.2rem; font-weight: 600; }
    .content h2:first-child { margin-top: 0; }
    .content h3 { font-family: 'Inter', Arial, sans-serif; color: #C4D8E6; margin-top: 1rem; margin-bottom: 0.5rem; font-size: 0.9rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .content p { margin-bottom: 0.75rem; color: #C4D8E6; }
    .content ul { margin-left: 1.5rem; margin-bottom: 1rem; }
    .content li { margin-bottom: 0.5rem; color: #C4D8E6; }
    .update-date { color: #6A8A96; font-weight: bold; margin-bottom: 1rem; }
    .content strong { color: #F5F0E8; }
    a { color: #4B8FA8; }

    .badge { display: inline-block; font-size: 0.7rem; font-weight: bold; padding: 2px 7px; border-radius: 3px; margin-left: 6px; vertical-align: middle; letter-spacing: 0.5px; text-transform: uppercase; }
    .badge-signed    { background: #0B3A2A; color: #5AAAA0; border: 1px solid #0B607C; }
    .badge-passed    { background: #0B2A3A; color: #4B8FA8; border: 1px solid #0B607C; }
    .badge-awaiting  { background: #3A3000; color: #E8D080; }
    .badge-advancing { background: #0B2A3A; color: #C4D8E6; }
    .badge-dead      { background: #3A1A1A; color: #E08080; }
    .badge-effect    { background: #0B3035; color: #4BC4A8; border: 1px solid #0B607C; }
    .badge-uncertain { background: #2A2A1A; color: #C8B860; }

    .session-adjourned { background: #0E1C1A; border: 1px solid #1E3840; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.25rem; }
    .session-adjourned .adj-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #6A8A96; margin-bottom: 4px; }
    .session-adjourned p { color: #C4D8E6; margin: 0; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/status" class="back-link">← Back to Jail Roster Monitor</a>
    <h1>Washington State Legislative Session</h1>
    <p class="subtitle">2026 Session — Post-Adjournment Summary</p>

    <div class="content">
      <p class="update-date">Updated: 3/13/2026</p>

      <h2>Washington state legislature 2026 — adjourned</h2>

      <div class="session-adjourned">
        <div class="adj-label">Session Status — <span class="badge badge-dead">Adjourned Sine Die</span></div>
        <p>The 2026 Washington State Legislature adjourned sine die at approximately 8:30 p.m. on March 12, 2026 — Day 60 of the 60-day session. The session closed with passage of the $79.4 billion supplemental operating budget, a landmark millionaire income tax, and late drama over a data center tax break that nearly forced a special session. Gov. Ferguson has until <strong>April 4, 2026</strong> to sign or veto bills. Bills neither signed nor vetoed become law automatically. Most new laws take effect <strong>June 11, 2026</strong> (90 days post-adjournment). Ferguson is expected to begin signing measures as early as this week.</p>
      </div>

      <h3>POLICE &amp; PUBLIC SAFETY:</h3>
      <p><strong>BAN ON POLICE FACE COVERINGS (SB 5855)</strong> <span class="badge badge-awaiting">Awaiting Signature</span> — Passed both chambers. Ferguson has pledged to sign it. Prohibits state, local, and federal officers — including ICE agents — from wearing masks during routine public interactions, with limited exceptions for SWAT, PPE, and religious coverings. Will face legal challenges; California's similar law is already being contested by the DOJ.</p>

      <p><strong>BAN ON FAKE BADGES / FALSE LAW ENFORCEMENT IMPERSONATION (SB 5876)</strong> <span class="badge badge-awaiting">Awaiting Signature</span> — Companion bill to the mask ban, also passed both chambers. Prohibits anyone who isn't a law enforcement officer from making, possessing, or providing law enforcement insignia in a way that would make a reasonable person think they're an officer. Ferguson vowed to sign it.</p>

      <p><strong>$100 MILLION POLICE HIRING GRANTS (SB 5060)</strong> <span class="badge badge-passed">Passed</span> — Ferguson's priority. Covers 75% of new officer salaries for 36 months. Cities must implement a 0.1% sales tax or already have a similar tax to qualify.</p>

      <p><strong>SHERIFF/POLICE CHIEF REQUIREMENTS (SB 5974)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Was moving through the House in the final days. Minimum age 25, background checks, must maintain peace officer certification. Controversial — Republicans framed it as allowing an unelected state board to effectively remove elected sheriffs.</p>

      <p><strong>PUBLIC DEFENSE FUNDING (SB 5404)</strong> <span class="badge badge-uncertain">Left on Table</span> — Democratic leaders acknowledged after adjournment that funding public defense was among the pressing issues left unresolved for 2027. WA is one of only 2 states that doesn't fully fund public defenders, leading to overworked defenders and constitutional violations.</p>

      <p><strong>FLOCK LICENSE PLATE CAMERA REGULATION (ESSB 6002)</strong> <span class="badge badge-passed">Passed</span> — Regulates automated license plate readers. Passed the Senate and cleared the House Civil Rights &amp; Judiciary Committee before session end.</p>

      <p><strong>BODY CAMERAS FOR ICE ENCOUNTERS (HB 2648)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Had passed the House Community Safety Committee. Would require local police to activate body cams when encountering federal agents doing immigration enforcement and report encounters to their agency.</p>

      <p><strong>ICE COURT ORDERS / SAFE ACT (SB 5906)</strong> <span class="badge badge-dead">Dead</span> — Died at the March 7 opposite-chamber cutoff. Would have required ICE agents to get court approval before entering schools, health care facilities, early learning providers, and election offices. Passed the House in amended form but stalled in the Senate.</p>

      <p><strong>ICE HIRING BAN (HB 2641)</strong> <span class="badge badge-dead">Dead</span> — Died in committee Feb. 5. Would've prohibited hiring former federal immigration agents hired under Trump after Jan. 20, 2025.</p>

      <h3>GUN CONTROL:</h3>
      <p><strong>PERMIT TO PURCHASE (HB 1163)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would require a state permit before buying firearms, like a dozen other states. Final outcome not confirmed at press time.</p>

      <p><strong>GUN-FREE ZONE EXPANSION + BULK PURCHASE LIMITS, GUN STORAGE REQUIREMENTS, GUN DEALER REGULATIONS</strong> <span class="badge badge-uncertain">Mixed Outcomes</span> — Mixed results at the final cutoff. Some provisions may have survived. Full outcomes pending confirmation.</p>

      <h3>SOCIAL MEDIA &amp; CHILDREN:</h3>
      <p><strong>ADDICTIVE FEEDS BAN (HB 1834/SB 5708)</strong> <span class="badge badge-passed">Passed</span> — AG Nick Brown's priority. Bans algorithmic addictive feeds for minors and blocks push notifications during overnight hours and school hours. Modeled on California law.</p>

      <p><strong>PARENTAL CONSENT FOR SOCIAL MEDIA (SB 6111)</strong> <span class="badge badge-dead">Dead</span> — Died at first cutoff. Would've required parental consent for minors under 17 to create accounts.</p>

      <p><strong>CHILD INFLUENCER PROTECTIONS (HB 2400)</strong> <span class="badge badge-dead">Dead</span> — Died at first cutoff. Would've protected kids in monetized family content and let young adults request deletion of childhood videos.</p>

      <p><strong>PORNOGRAPHY ACCESS RESTRICTIONS</strong> <span class="badge badge-dead">Dead</span> — Bipartisan bill died at first cutoff.</p>

      <h3>EDUCATION:</h3>
      <p><strong>PARENTAL RIGHTS INITIATIVES</strong> <span class="badge badge-uncertain">Going to November Ballot</span> — Legislature declined to consider two citizen-sponsored initiatives backed by Let's Go Washington. Both will appear on the November 2026 ballot: one barring transgender girls from girls' sports in schools, another seeking to restore a "Parent's Bill of Rights" that lawmakers adopted two years ago and scaled back last year.</p>

      <p><strong>ISOLATION &amp; RESTRAINT BAN IN SPECIAL EDUCATION</strong> <span class="badge badge-passed">Passed</span> — Bans mechanical and chemical restraint and forced isolation of students receiving special education services. Staff physically holding a student is still permitted if not life-threatening. Schools cannot build new isolation rooms.</p>

      <p><strong>HOMESCHOOL AGE REQUIREMENT (SB 6261)</strong> <span class="badge badge-dead">Dead</span> — Would've lowered homeschool attestation requirement from age 8 to age 6. WA is the only state that waits until age 8.</p>

      <h3>CANNABIS:</h3>
      <p><strong>RYAN'S LAW — Medical Cannabis Patient Protections</strong> <span class="badge badge-signed">Signed into Law</span> — Signed by Gov. Ferguson on March 5, 2026 — the first cannabis bill signed this session. Takes effect June 11, 2026.</p>

      <p><strong>CANNABIS LICENSE FEE INCREASE</strong> <span class="badge badge-passed">Passed</span> — Increases annual cannabis license fees by $400. Passed both chambers in the final days of session. Awaiting signature.</p>

      <p><strong>CANNABIS PRODUCER COOPERATIVES (HB 2681)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Needed a concurrence vote in the House on the final day. Outcome not confirmed.</p>

      <p><strong>HOME GROW LEGISLATION (SB 6204)</strong> <span class="badge badge-dead">Dead — 12th Consecutive Year</span> — Did not pass off the Senate floor before the Feb. 17 deadline. WA remains one of only three states to have legalized both medical and recreational cannabis while still criminalizing home grow, and the only one where it's a felony.</p>

      <p><strong>LOCAL CANNABIS TAX (SB 6328)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would allow counties or cities (not both) to impose up to 2% additional excise tax on retail cannabis sales for up to 7 years.</p>

      <p><strong>CANNABIS HOSPITALITY EVENTS</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Was tagged as potentially NTIB (revenue-generating), giving it cover to move until session end. Outcome not confirmed.</p>

      <p><strong>CANNABIS TAX OVERHAUL (HB 2433)</strong> <span class="badge badge-dead">Dead</span> — Would have replaced WA's 37% excise tax (highest in the nation) with weight and THC potency-based rates. Public hearing pulled from Senate Ways &amp; Means calendar in early February with no reschedule.</p>

      <h3>TAXES &amp; BUDGET:</h3>
      <p><strong>MILLIONAIRE INCOME TAX (SB 6346)</strong> <span class="badge badge-awaiting">Awaiting Signature</span> — Passed the House on March 10 after one of the longest floor debates in state legislative history — nearly 25 hours continuous. Passed the Senate on March 11. Imposes a 9.9% tax on individual income over $1 million starting Jan. 1, 2028. Revenue funds: expansion of Working Families Tax Credit to 460,000 additional households; tax relief for ~140,000 small businesses; exemption of diapers, hygiene products, and OTC medicines from sales tax; and free school breakfast and lunch for all K-12 students. Projected to raise ~$3.5 billion per year when fully in effect. Applies to less than 0.5% of Washingtonians. Lawsuits and a possible ballot referendum are expected — the bill challenges nearly 100 years of state tax policy and Supreme Court precedent. Ferguson intends to sign it.</p>

      <p><strong>SUPPLEMENTAL OPERATING BUDGET — $79.4 BILLION</strong> <span class="badge badge-passed">Passed</span> — Passed on the final evening of session entirely along party lines. Updates the $77.8 billion two-year budget covering July 1, 2025 to June 30, 2027. Balanced using one-time maneuvers, a significant rainy day fund withdrawal, and cuts to child care and education. The next budget cycle is expected to start in deficit unless the millionaire income tax survives legal challenges.</p>

      <p><strong>DATA CENTER TAX BREAK ELIMINATION (SB 6231)</strong> <span class="badge badge-passed">Passed</span> — Passed the House 51-46 after significant late-session drama that nearly forced a special session. Eliminates one of two sales tax exemptions for data centers. Estimated to generate over $140 million every two years. Large tech companies and union electricians both opposed it.</p>

      <p><strong>PAYROLL TAX ON HIGH EARNERS (HB 2100)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — 5% tax on employers for employees making over $125k/year to fund the "Well Washington Fund" for healthcare, education, and human services.</p>

      <p><strong>HIGHER EDUCATION FUNDING RESET</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — 10% tuition cuts for 3 years starting fall 2027, expanding Washington College Grant eligibility.</p>

      <p><strong>BULLION TAX REPEAL (HB 2093)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Republicans pushing to eliminate the sales tax on gold and silver, arguing it's driving coin shops out of business.</p>

      <h3>ARTIFICIAL INTELLIGENCE:</h3>
      <p><strong>AI COMPANION CHATBOTS (SB 5984 / HB 2225)</strong> <span class="badge badge-awaiting">Awaiting Signature</span> — Ferguson's priority. Both chambers passed it. Prohibits romantic AI relationships with minors, requires hourly notifications that it's not human, includes suicide prevention protocols and a private right of action. Tech industry pushed back hard throughout session.</p>

      <p><strong>AI IN SCHOOLS (HB 2481/SB 5956)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would require human oversight of AI systems in schools, addressing surveillance, risk scoring, and automated discipline. Yes, there is actually AI flagging chip bags as weapons in school hallways.</p>

      <p><strong>AI DEEPFAKES / DIGITAL LIKENESS BILL</strong> <span class="badge badge-passed">Passed Both Chambers</span> — Requires developers to make tools available so people can tell when something is AI-generated. Also includes protections for people's AI-generated digital likeness.</p>

      <p><strong>TRAINING DATA TRANSPARENCY</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would require disclosure of what data is used to train AI models.</p>

      <p><strong>HEALTH INSURANCE AI AUTHORIZATION</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would regulate AI-based insurance authorization decisions for medical procedures.</p>

      <p><strong>COLLECTIVE BARGAINING AROUND AI</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would allow unions to negotiate how AI is used in workplaces.</p>

      <p><strong>GROCERY STORE AI SURVEILLANCE</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would regulate facial recognition and AI-based surge pricing.</p>

      <h3>WILDFIRE &amp; ENVIRONMENT:</h3>
      <p><strong>WILDFIRE PREVENTION FUNDING</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Fighting a $60 million cut to wildfire resilience budget. $125 million per biennium for forest health.</p>
      <p><strong>CLEAN ENERGY GRID EXPANSION</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Clean energy grid expansion and semi truck emissions climate legislation were still in play heading into the final days.</p>

      <h3>HOUSING &amp; DEVELOPMENT:</h3>
      <p><strong>COMMERCIAL TO RESIDENTIAL CONVERSION (SB 6026)</strong> <span class="badge badge-passed">Passed</span> — Governor's priority. Requires local governments to allow mixed-use and residential in commercially zoned areas without rezoning. Abandoned strip malls and big-box stores could become housing.</p>

      <p><strong>SHORT-TERM RENTAL TAX (SB 5576)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Up to 4% excise tax on Airbnbs to fund affordable housing. Amended to let local governments decide. Airbnb pumped $4 million into a PAC to kill it — they spent one-fifth of what the tax would generate just to stop local governments from having the option.</p>

      <p><strong>LIMITING BULK HOME BUYING (SB 5496)</strong> <span class="badge badge-dead">Dead</span> — Died at the March 7 opposite-chamber cutoff. Would have barred entities with an interest in more than 100 single-family homes from purchasing more. Passed the Senate but stalled in the House. The proposed limit had already been raised from 25 homes to 50 to 100 over the course of negotiations.</p>

      <h3>IMMIGRATION &amp; LABOR:</h3>
      <p><strong>IMMIGRANT WORKER PROTECTIONS (HB 2105/SB 5852)</strong> <span class="badge badge-passed">Passed</span> — Passed both chambers. Requires employers to give workers notice within 72 hours if ICE does an I-9 audit. Also prohibits school district and early learning employees from collecting data on students' or families' immigration status.</p>

      <p><strong>FARMWORKER COLLECTIVE BARGAINING (SB 6045/HB 2409)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Would bring farmworkers under Public Employment Relations Commission jurisdiction. Farmworkers have been excluded from National Labor Relations Act protections since 1935.</p>

      <p><strong>MINIMUM WAGE $17.13/HOUR</strong> <span class="badge badge-effect">In Effect</span> — Took effect Jan 1, 2026. Highest in the nation. Some cities are higher: Seattle $21.63, SeaTac $20.74.</p>

      <p><strong>32-HOUR WORKWEEK (HB 2611)</strong> <span class="badge badge-dead">Dead</span> — Would've required overtime after 32 hours per week. Food, hospitality, and farm industries opposed. San Juan County implemented a 32-hour week for county employees in 2023: 18% decrease in sick calls, 216% increase in job applications, $2 million saved.</p>

      <p><strong>STRIKING WORKERS GET UNEMPLOYMENT</strong> <span class="badge badge-effect">In Effect</span> — Strikers can collect up to 6 weeks of unemployment benefits after a strike starts.</p>

      <p><strong>PAID FAMILY LEAVE EXPANSION</strong> <span class="badge badge-passed">Passed</span> — Job protection kicks in after only 180 days (down from 12 months). Minimum leave reduced to 4 hours (from 8 hours).</p>

      <p><strong>WORKPLACE VIOLENCE PREVENTION</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Healthcare facilities must investigate violence incidents promptly and update prevention plans annually.</p>

      <p><strong>ISOLATED WORKER PROTECTIONS</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Panic buttons and safety measures for janitors, housekeepers, and security guards who work alone.</p>

      <h3>HEALTHCARE &amp; VACCINES:</h3>
      <p><strong>STATE VACCINE AUTHORITY (SB 5967/HB 2242)</strong> <span class="badge badge-passed">Passed Both Chambers</span> — Ferguson's priority. Allows WA Dept of Health to make vaccine recommendations independent of the CDC. Direct response to Trump politicizing the CDC. Does NOT create new mandates.</p>

      <h3>ALREADY IN EFFECT:</h3>
      <p><strong>MEDICAL DEBT CREDIT REPORTING BAN</strong> <span class="badge badge-effect">In Effect</span> — Medical debt can no longer be reported to credit agencies.</p>

      <p><strong>BLOOD TYPE ON DRIVER'S LICENSE (SB 5689)</strong> <span class="badge badge-effect">In Effect</span> — Voluntary blood type info on state IDs. WA is among the first states to offer this.</p>

      <p><strong>NICOTINE/VAPE TAX</strong> <span class="badge badge-effect">In Effect</span> — 95% excise tax on all nicotine products including synthetic nicotine, vapes, and pouches. A $7 product now costs $15.06 after taxes.</p>

      <p><strong>PLASTIC BAG FEE INCREASE</strong> <span class="badge badge-effect">In Effect</span> — Minimum charge raised from 8 cents to 12 cents per bag.</p>

      <p><strong>CHILD SUPPORT REFORM</strong> <span class="badge badge-effect">In Effect</span> — Updated economic tables now cover incomes up to $50,000 combined per month, up from the old $12,000 cap.</p>

      <p><strong>DIAPER CHANGING STATIONS</strong> <span class="badge badge-effect">In Effect</span> — Mandatory in all new or remodeled public buildings costing $15k+.</p>

      <h3>TRANSPORTATION &amp; ROADS:</h3>
      <p><strong>RECKLESS DRIVING REDEFINED (SB 5890)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — 30+ mph over the speed limit = reckless driving charge.</p>

      <p><strong>RECKLESS INTERFERENCE WITH EMERGENCY OPERATIONS (HB 2203)</strong> <span class="badge badge-dead">Dead</span> — New driving offense for blocking emergency vehicles passed the House but didn't make it through a Senate policy committee.</p>

      <h3>CRIMINAL JUSTICE:</h3>
      <p><strong>POLITICAL AFFILIATION HATE CRIME (SB 5830)</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Makes it a Class C felony to assault someone based on their political beliefs.</p>

      <p><strong>JUVENILE DETENTION OVERCROWDING</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Allowing youth transfers to state prisons and community facilities in certain cases.</p>

      <p><strong>EARLY RELEASE FOR YOUTH OFFENDERS</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Allowing people convicted before age 18 to petition for early release at age 24.</p>

      <p><strong>DUI LAB EXPANSION</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Allowing more labs to perform toxicology tests to speed up DUI cases.</p>

      <p><strong>LOWER BAC THRESHOLD</strong> <span class="badge badge-dead">Dead</span> — Lowering the drunk driving legal limit from 0.08 to 0.05 did not advance this session.</p>

      <h3>RANDOMS:</h3>
      <p><strong>GRAY WOLF RECLASSIFICATION</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Downgrading from "endangered" to "sensitive" status.</p>

      <p><strong>DISCOVER PASS PRICE HIKE</strong> <span class="badge badge-uncertain">Final Status Unclear</span> — Increasing from $30 to $45 for state parks access; would be the first increase in 14 years.</p>

      <p><strong>POSTHUMOUS CANDIDATE BALLOT REMOVAL</strong> <span class="badge badge-dead">Dead</span> — Would have allowed removal of deceased candidates from ballots after the filing deadline. Passed the House, didn't make it out of a Senate policy committee. Prompted by Tom Crowson, who died close enough to the primary that he nearly won posthumously.</p>

      <p style="margin-top: 2rem; color: #6A8A96; font-style: italic;">For more information, visit <a href="https://leg.wa.gov" target="_blank">leg.wa.gov</a>. Session adjourned sine die March 12, 2026. Governor action deadline: April 4, 2026.</p>
    </div>
  </div>
</body>
</html>`;
  
  res.send(html);
});

// History page - UPDATED for new log format
app.get('/api/history', (req, res) => {
  let entries = [];

  try {
    const lines = getAllEventLines();

    // Group by date
    const entriesByDate = {};

    for (const line of lines) {
      if (line.startsWith('BOOKED |') || line.startsWith('RELEASED |')) {
        // Extract date from line, normalized to "YYYY-MM-DD" regardless of
        // whether the line is in ISO or legacy "MM/DD/YY" format.
        const dateMatch = line.match(/(?:Booked|Released):\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})/);
        if (dateMatch) {
          const dateKey = dateMatch[1].includes('/') ? toIsoDateTime(dateMatch[1]) : dateMatch[1];

          if (!entriesByDate[dateKey]) {
            entriesByDate[dateKey] = { date: dateKey, booked: [], released: [] };
          }

          if (line.startsWith('BOOKED |')) {
            entriesByDate[dateKey].booked.push(line.replace('BOOKED | ', ''));
          } else {
            entriesByDate[dateKey].released.push(line.replace('RELEASED | ', ''));
          }
        }
      }
    }

    // Convert to array and sort by date (newest first)
    entries = Object.values(entriesByDate).sort((a, b) => new Date(b.date) - new Date(a.date));
  } catch (e) {
    console.error('History parse error:', e);
  }

  function buildInmateRow(line, type = 'booked') {
    const namePart = line.split(' | ')[0] || 'Unknown';
    // Reconstruct "MM/DD/YY HH:MM:SS" for display regardless of whether the
    // line is stored in ISO or legacy format. Requires a time component, so
    // date-only entries (time genuinely unknown) fall through to blank, same
    // as before the ISO migration.
    const timeMatch = line.match(/(?:Booked|Released):\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}:\d{2})/);
    const time = timeMatch ? formatShortDateTime(parseBookingDate(timeMatch[1])) : '';
    const chargesMatch = line.match(/Charges:\s+(.+)$/);
    const charges = chargesMatch ? chargesMatch[1].trim() : '';
    const timeServedMatch = line.match(/Time served:\s+([^|(]+)/);
    const timeServed = timeServedMatch ? timeServedMatch[1].trim() : '';
    const bailMatch = line.match(/Bail Posted:\s+(\$[\d,]+\.\d{2})/);
    const bail = bailMatch ? bailMatch[1].trim() : '';
    const releaseParenMatch = line.match(/\(([^)]+)\)/);
    const releaseRaw = releaseParenMatch ? releaseParenMatch[1].trim() : '';
    const releaseLabel = releaseRaw ? (RELEASE_TYPE_NAMES[releaseRaw] || releaseRaw) : '';
    const badgeClass = type === 'released' ? 'badge-released' : 'badge-booked';
    const badgeText = type === 'released' ? 'RELEASED' : 'BOOKED';
    let detailRows = '';
    if (charges) detailRows += '<div class="detail-row"><span class="detail-label">Charges</span><span class="detail-value">' + charges + '</span></div>';
    if (timeServed) detailRows += '<div class="detail-row"><span class="detail-label">Served</span><span class="detail-value">' + timeServed + '</span></div>';
    if (bail) detailRows += '<div class="detail-row"><span class="detail-label">Bail</span><span class="detail-value">' + bail + '</span></div>';
    if (releaseLabel) detailRows += '<div class="detail-row"><span class="detail-label">Release</span><span class="detail-value">' + releaseLabel + '</span></div>';
    return '<details class="inmate-row">' +
      '<summary>' +
      '<span class="inmate-name">' + namePart + '</span>' +
      (time ? '<span class="inmate-time">' + time + '</span>' : '') +
      '<span class="status-badge ' + badgeClass + '">' + badgeText + '</span>' +
      '<span class="chevron">▾</span>' +
      '</summary>' +
      (detailRows ? '<div class="inmate-details">' + detailRows + '</div>' : '') +
      '</details>';
  }

  const entriesHtml = entries.length > 0 ? entries.map(entry => {
    // entry.date is "YYYY-MM-DD"; reformat to "MM/DD/YYYY" for display.
    const [year, month, day] = entry.date.split('-');
    const displayDate = `${month}/${day}/${year}`;
    const bookedHtml = entry.booked.length > 0 ?
      '<div class="section-label booked">Booked (' + entry.booked.length + ')</div>' +
      entry.booked.map(b => buildInmateRow(b, 'booked')).join('') : '';
    const releasedHtml = entry.released.length > 0 ?
      '<div class="section-label released">Released (' + entry.released.length + ')</div>' +
      entry.released.map(r => buildInmateRow(r, 'released')).join('') : '';
    return '<div class="date-group"><div class="date-label">' + displayDate + '</div>' +
           bookedHtml + releasedHtml + '</div>';
  }).join('') :
  '<p class="no-data">No changes recorded yet. Run the workflow to start monitoring.</p>';

  const html = `<!DOCTYPE html>
<html>
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-380L7KND2L"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-380L7KND2L');
</script>
  <title>Booked and Released Log - Washington Jail Data</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { overflow-x: hidden; width: 100%; }
    body { font-family: 'Inter', Arial, sans-serif; font-size: 8pt; background: #152220; color: #C4D8E6; min-height: 100vh; }
    .page-header { display: flex; justify-content: space-between; align-items: center; }
    .county-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #A8C4D0; }
    .public-records { font-size: 0.7rem; font-weight: 500; letter-spacing: 1px; text-transform: uppercase; color: #6A8A96; }
    h1 { font-family: 'Playfair Display', Georgia, serif; font-size: 2.5rem; font-weight: 700; color: #F5F0E8; letter-spacing: -0.5px; margin: 0.75rem 0 1rem; }
    .nav-bar { display: flex; gap: 0.5rem; margin-bottom: 1.25rem; }
    .nav-btn { padding: 0.5rem 1rem; background: #1A3035; color: #C4D8E6; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 8pt; border: 1px solid #22443A; transition: background 0.15s; }
    .nav-btn:hover { background: #1D4A5C; color: #F5F0E8; }
    .container { max-width: 900px; margin: 0 auto; padding: 1.5rem 2rem 3rem; }
    .date-group { margin-bottom: 2rem; }
    .date-label { font-size: 0.7rem; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: #4B8FA8; padding-bottom: 0.5rem; border-bottom: 1px solid #22443A; margin-bottom: 0.75rem; }
    .section-label { font-size: 0.65rem; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; margin: 0.75rem 0 0.4rem; }
    .section-label.booked { color: #4B8FA8; }
    .section-label.released { color: #5AAAC8; }
    details.inmate-row { background: #1A3035; border-radius: 6px; margin-bottom: 0.35rem; border: 1px solid #22443A; overflow: hidden; }
    details.inmate-row > summary { list-style: none; display: flex; align-items: center; gap: 0.6rem; padding: 0.7rem 1rem; cursor: pointer; user-select: none; }
    details.inmate-row > summary::-webkit-details-marker { display: none; }
    .inmate-name { font-family: 'Fake Receipt', 'Courier New', monospace; font-size: 9.5pt; font-weight: 700; color: #F5F0E8; text-transform: uppercase; letter-spacing: 0.5px; flex: 1; }
    .inmate-time { color: #6A8A96; font-size: 7pt; white-space: nowrap; }
    .status-badge { font-size: 0.58rem; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; padding: 0.18rem 0.45rem; border-radius: 3px; white-space: nowrap; flex-shrink: 0; }
    .badge-booked { background: rgba(75,143,168,0.15); color: #4B8FA8; border: 1px solid rgba(75,143,168,0.3); }
    .badge-released { background: rgba(90,170,200,0.15); color: #5AAAC8; border: 1px solid rgba(90,170,200,0.3); }
    .chevron { color: #6A8A96; font-size: 0.65rem; flex-shrink: 0; transition: transform 0.15s; }
    details.inmate-row[open] .chevron { transform: rotate(180deg); }
    .inmate-details { border-top: 1px solid #22443A; padding: 0.5rem 1rem 0.65rem; }
    .detail-row { display: flex; align-items: baseline; gap: 0.75rem; padding: 0.3rem 0; border-bottom: 1px solid #1a2e2c; }
    .detail-row:last-child { border-bottom: none; }
    .detail-label { font-size: 0.6rem; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: #6A8A96; min-width: 55px; flex-shrink: 0; }
    .detail-value { color: #A8C4D0; font-size: 7.5pt; line-height: 1.5; }
    .no-data { color: #6A8A96; text-align: center; padding: 3rem; }
    .search-input { width: 100%; padding: 0.7rem 1rem; background: #1A3035; color: #F5F0E8; border: 1px solid #22443A; border-radius: 6px; font-size: 9pt; font-family: 'Inter', Arial, sans-serif; outline: none; margin-bottom: 1.25rem; }
    .search-input::placeholder { color: #6A8A96; }
    .search-input:focus { border-color: #4B8FA8; }
    a { color: #4B8FA8; text-decoration: none; }
    @media (max-width: 600px) { .page-header { flex-direction: column; align-items: flex-start; gap: 0.2rem; } h1 { font-size: 1.75rem; } .container { padding: 0 1rem 3rem; } }
  </style>
</head>
<body>
  <div class="container">
    <div class="page-header">
      <span class="county-label">Mason County</span>
      <span class="public-records">Public Records — Sheriff's Office</span>
    </div>
    <h1>Jail Roster Monitor</h1>
    <div class="nav-bar">
      <a href="/api/status" class="nav-btn">← Washington Jail Data</a>
      <a href="/api/stats" class="nav-btn">Statistics →</a>
    </div>
    <input type="text" class="search-input" placeholder="Search by name..." oninput="filterNames(this.value)">
    ${entriesHtml}
  </div>
  <script>
    function filterNames(q) {
      q = q.trim().toLowerCase();
      document.querySelectorAll('details.inmate-row').forEach(el => {
        const name = el.querySelector('.inmate-name').textContent.toLowerCase();
        el.style.display = (!q || name.includes(q)) ? '' : 'none';
      });
      document.querySelectorAll('.date-group').forEach(group => {
        const hasVisible = [...group.querySelectorAll('details.inmate-row')].some(r => r.style.display !== 'none');
        group.style.display = hasVisible ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;

  res.send(html);
});

// Stats Dashboard - UPDATED for new format
app.get('/api/stats', (req, res) => {
  try {
    const lines = getAllEventLines();

    if (lines.length === 0) {
      return res.send(getStatsHTML({
        totalBookings: 0,
        totalReleases: 0,
        currentPopulation: 0,
        avgPopulation: 0,
        commonCharges: [],
        bookingsByDay: {},
        avgStayDays: 0,
        releaseTypes: {},
        timeSeriesData: [],
        totalBailThisMonth: 0,
        avgBailByCharge: [],
        avgTimeServedMins: 0,
        minTimeServedMins: 0,
        maxTimeServedMins: 0,
        longestInmate: null,
        daysOfData: 0,
        dataCollectionStart: null,
      }));
    }

    // Get data collection start date from first entry in log
    let dataCollectionStart = null;
    let daysOfData = 0;
    for (const line of lines) {
      const firstDate = extractLabeledDate(line, 'Booked') || extractLabeledDate(line, 'Released');
      if (firstDate) {
        dataCollectionStart = firstDate;
        daysOfData = Math.floor((new Date() - firstDate) / (1000 * 60 * 60 * 24));
        break;
      }
    }

    // Parse the log file for NEW format
    let totalBookings = 0;
    let totalReleases = 0;
    let allCharges = [];
    let releaseTypes = {};
    let bookingDates = [];
    let releaseDates = [];
    let stayDurations = [];
    let popEvents = []; // {ts: Date, delta: 1|-1} for avg population

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Check for BOOKED entries in NEW format: "BOOKED | NAME | Booked: DATE | Charges: ..."
      if (trimmedLine.startsWith('BOOKED |')) {
        totalBookings++;
        
        // Extract date
        const date = extractLabeledDate(trimmedLine, 'Booked');
        if (date) {
          bookingDates.push(date);
          popEvents.push({ ts: date, delta: 1 });
        }
        
        // Extract charges
        const chargesMatch = trimmedLine.match(/Charges:\s+(.+)/);
        if (chargesMatch) {
          const charges = chargesMatch[1].trim();
          if (charges && charges !== 'None listed') {
            const chargeList = charges.split(',').map(c => normalizeCharge(c.trim())).filter(Boolean);
            allCharges.push(...chargeList);
          }
        }
      }
      
      // Check for RELEASED entries in NEW format: "RELEASED | NAME | Released: DATE | Charges: ..."
      else if (trimmedLine.startsWith('RELEASED |')) {
        totalReleases++;
        
        // Extract release type
        if (trimmedLine.includes('Not Released')) {
          releaseTypes['Not Released'] = (releaseTypes['Not Released'] || 0) + 1;
        } else if (trimmedLine.includes('Released:')) {
          releaseTypes['Released'] = (releaseTypes['Released'] || 0) + 1;
        }
        
        // Extract release date
        const date = extractLabeledDate(trimmedLine, 'Released');
        if (date) {
          releaseDates.push(date);
          popEvents.push({ ts: date, delta: -1 });
        }
        
        // Extract charges from releases too
        const chargesMatch = trimmedLine.match(/Charges:\s+(.+)/);
        if (chargesMatch) {
          const charges = chargesMatch[1].trim();
          if (charges && charges !== 'None listed' && charges !== 'Not Released') {
            const chargeList = charges.split(',').map(c => normalizeCharge(c.trim())).filter(Boolean);
            allCharges.push(...chargeList);
          }
        }
      }
      
      // OLD format fallback (if you still have some old entries)
      else if (trimmedLine.startsWith('+ ')) {
        totalBookings++;
        // Handle old "+ NAME | Booked: ..." format if needed
      }
      else if (trimmedLine.startsWith('- ')) {
        totalReleases++;
        // Handle old "- NAME | Released: ..." format if needed
      }
    }
    
    // Calculate charge frequencies
    const chargeCounts = {};
    allCharges.forEach(charge => {
      const cleanCharge = charge.trim().replace(/^[\d.]+/, '').trim();
      if (cleanCharge) {
        chargeCounts[cleanCharge] = (chargeCounts[cleanCharge] || 0) + 1;
      }
    });
    
    const commonCharges = Object.entries(chargeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([charge, count]) => ({ charge, count }));
    
    // Calculate bookings by day of week
    const bookingsByDay = { Sun: 0, Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0 };
    bookingDates.forEach(date => {
      if (date && !isNaN(date.getTime())) {
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const day = dayNames[date.getDay()];
        bookingsByDay[day] = (bookingsByDay[day] || 0) + 1;
      }
    });
    
    // Calculate average stay duration by matching names
const bookingsByName = new Map();
const releasesByName = new Map();

// Parse bookings
for (const line of lines) {
  if (line.startsWith('BOOKED |')) {
    const nameMatch = line.match(/BOOKED \| ([^|]+) \|/);
    const bookDate = extractLabeledDate(line, 'Booked');

    if (nameMatch && bookDate) {
      const name = nameMatch[1].trim();
      if (!bookingsByName.has(name)) {
        bookingsByName.set(name, []);
      }
      bookingsByName.get(name).push(bookDate);
    }
  }

  else if (line.startsWith('RELEASED |')) {
    const nameMatch = line.match(/RELEASED \| ([^|]+) \|/);
    const releaseDate = extractLabeledDate(line, 'Released');

    if (nameMatch && releaseDate) {
      const name = nameMatch[1].trim();
      if (!releasesByName.has(name)) {
        releasesByName.set(name, []);
      }
      releasesByName.get(name).push(releaseDate);
    }
  }
}

// Calculate stays
let totalStayHours = 0;
let stayCount = 0;

for (const [name, bookDates] of bookingsByName.entries()) {
  const relDates = releasesByName.get(name);
  if (relDates) {
    // Match most recent booking to most recent release
    const lastBook = bookDates[bookDates.length - 1];
    const lastRelease = relDates[relDates.length - 1];

    if (lastRelease > lastBook) {
      const stayMs = lastRelease - lastBook;
      const stayHours = stayMs / (1000 * 60 * 60);

      if (stayHours > 0 && stayHours < 8760) { // Between 0 and 365 days
        totalStayHours += stayHours;
        stayCount++;
      }
    }
  }
}

const avgStayDays = stayCount > 0 ? Math.round((totalStayHours / stayCount) / 24) : 0;

    // --- NEW STATS FROM RELEASE HISTORY ---

    // Build name->charges map from BOOKED lines
    const nameToCharges = new Map();
    for (const line of lines) {
      if (line.startsWith('BOOKED |')) {
        const nm = line.match(/BOOKED \| ([^|]+) \|/);
        const ch = line.match(/Charges:\s+(.+)/);
        if (nm && ch) {
          const charges = ch[1].split(',').map(c => normalizeCharge(c.trim())).filter(c => c && c !== 'None listed');
          nameToCharges.set(nm[1].trim(), charges);
        }
      }
    }

    // Parse RELEASED lines for release types and bail
    const releaseTypeCounts = {};
    const bailByCharge = {};
    let totalBailThisMonth = 0;
    const nowStats = new Date();

    for (const line of lines) {
      if (line.startsWith('RELEASED |')) {
        // Extract release type code from "(RBB)" pattern
        const typeMatch = line.match(/\(([A-Z]{2,5})\)\s*\|/);
        if (typeMatch) {
          const type = typeMatch[1];
          releaseTypeCounts[type] = (releaseTypeCounts[type] || 0) + 1;
        }

        // Extract bail amount
        const bailMatch = line.match(/Bail Posted:\s*\$([\d,]+\.\d{2})/);
        if (bailMatch) {
          const bail = parseFloat(bailMatch[1].replace(/,/g, ''));
          if (bail > 0) {
            // Check if this month
            const releaseDate = extractLabeledDate(line, 'Released');
            if (releaseDate && releaseDate.getFullYear() === nowStats.getFullYear() && releaseDate.getMonth() === nowStats.getMonth()) {
              totalBailThisMonth += bail;
            }
            // Correlate bail with charges
            const nm = line.match(/RELEASED \| ([^|]+) \|/);
            if (nm) {
              const charges = nameToCharges.get(nm[1].trim()) || [];
              charges.forEach(charge => {
                if (!bailByCharge[charge]) bailByCharge[charge] = { total: 0, count: 0 };
                bailByCharge[charge].total += bail;
                bailByCharge[charge].count++;
              });
            }
          }
        }
      }
    }

    // Average bail by charge type (top 5)
    const avgBailByCharge = Object.entries(bailByCharge)
      .map(([charge, data]) => ({ charge, avgBail: Math.round(data.total / data.count), count: data.count }))
      .sort((a, b) => b.avgBail - a.avgBail)
      .slice(0, 5);

    // Precise time served and release types from history
    let historyTimeMinutes = [];
    let finalReleaseTypes = releaseTypeCounts;
    {
      try {
        const history = getAllReleases();
        const historyTypeCounts = {};
        for (const entry of history) {
          const tsMatch = (entry.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
          if (tsMatch) {
            const mins = parseInt(tsMatch[1]) * 1440 + parseInt(tsMatch[2]) * 60 + parseInt(tsMatch[3]);
            if (mins > 0 && mins < 525600) historyTimeMinutes.push(mins);
          }
          if (entry.releaseType) {
            historyTypeCounts[entry.releaseType] = (historyTypeCounts[entry.releaseType] || 0) + 1;
          }
        }
        if (Object.keys(historyTypeCounts).length > 0) finalReleaseTypes = historyTypeCounts;
      } catch (e) { /* ignore */ }
    }

    // Time served stats (precise, from PDF data)
    let avgTimeServedMins = 0, medianTimeServedMins = 0, minTimeServedMins = 0, maxTimeServedMins = 0;
    if (historyTimeMinutes.length > 0) {
      avgTimeServedMins = Math.round(historyTimeMinutes.reduce((a, b) => a + b, 0) / historyTimeMinutes.length);
      minTimeServedMins = Math.min(...historyTimeMinutes);
      maxTimeServedMins = Math.max(...historyTimeMinutes);
      const sorted = [...historyTimeMinutes].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianTimeServedMins = sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
    }

    // Longest current inmate (from roster)
    let longestInmate = null;
    let longestDays = 0;

    // Get current population from roster file
    let currentPopulation = 0;
    const rosterFile = path.join(STORAGE_DIR, 'prev_roster.txt');
    if (fs.existsSync(rosterFile)) {
      const content = fs.readFileSync(rosterFile, 'utf-8');
      const bookingMatches = content.match(/Booking #:/g);
      currentPopulation = bookingMatches ? bookingMatches.length : 0;

      // Also find longest-serving current inmate
      const currentBookings = extractBookings(content);
      for (const [, booking] of currentBookings.entries()) {
        if (booking.bookDate && booking.bookDate !== 'Unknown') {
          const bookDate = parseBookingDate(booking.bookDate);
          if (bookDate) {
            const daysIn = (nowStats - bookDate) / (1000 * 60 * 60 * 24);
            if (daysIn > longestDays) {
              longestDays = daysIn;
              longestInmate = { name: booking.name, days: Math.floor(daysIn), bookDate: booking.bookDate };
            }
          }
        }
      }
    }
    
    // Average daily population from event timeline
    let avgPopulation = 0;
    if (popEvents.length > 0) {
      popEvents.sort((a, b) => a.ts - b.ts);
      // Estimate starting population: current minus net change logged
      const netChange = totalBookings - totalReleases;
      let pop = Math.max(0, currentPopulation - netChange);
      const dailyPops = {};
      for (const ev of popEvents) {
        pop = Math.max(0, pop + ev.delta);
        dailyPops[ev.ts.toDateString()] = pop;
      }
      const pops = Object.values(dailyPops);
      if (pops.length > 0) {
        avgPopulation = Math.round(pops.reduce((a, b) => a + b, 0) / pops.length);
      }
    }

    // Prepare time series data (last 30 days)
    const last30Days = [];
    const today = new Date();
    
    for (let i = 29; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      
      // Count bookings for this day
      const dayBookings = bookingDates.filter(bookingDate => {
        if (!bookingDate || isNaN(bookingDate.getTime())) return false;
        return bookingDate.toDateString() === date.toDateString();
      }).length;
      
      last30Days.push({ date: dateStr, count: dayBookings });
    }
    
    const stats = {
      totalBookings,
      totalReleases,
      currentPopulation,
      avgPopulation,
      commonCharges,
      bookingsByDay,
      avgStayDays,
      releaseTypes: finalReleaseTypes,
      timeSeriesData: last30Days,
      dataCollectionStart: dataCollectionStart ? dataCollectionStart.toLocaleDateString('en-US') : null,
      daysOfData,
      totalBailThisMonth,
      avgBailByCharge,
      avgTimeServedMins,
      medianTimeServedMins,
      minTimeServedMins,
      maxTimeServedMins,
      longestInmate,
      longestCurrentMins: longestInmate ? Math.round(longestDays * 24 * 60) : 0,
    };
    
    res.send(getStatsHTML(stats));
    
  } catch (error) {
    console.error('Stats error:', error);
    res.send('Error generating stats: ' + error.message);
  }
});

function getStatsHTML(stats) {
  const maxCharge = Math.max(...stats.commonCharges.map(c => c.count), 1);
  const maxDay = Math.max(...Object.values(stats.bookingsByDay), 1);

  // ADD THIS ↓↓↓
  const dataBanner = stats.dataCollectionStart ? `
    <div style="background: #1A3035; border-left: 4px solid #4B8FA8; padding: 1rem; margin-bottom: 1.5rem; border-radius: 4px;">
      <p style="margin: 0; color: #F5F0E8;">
        Data collection started: <strong>${stats.dataCollectionStart}</strong>
        (${stats.daysOfData} days of tracking)
      </p>
      <p style="margin: 0.5rem 0 0 0; font-size: 0.9rem; color: #A8C4D0;">
        Statistics become more accurate as more data is collected over time.
      </p>
    </div>
  ` : '';
  // ↑↑↑ END OF NEW SECTION
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Statistics Dashboard - Washington Jail Data</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    @font-face { font-family: 'Fake Receipt'; src: url('/fonts/FakeReceipt.otf') format('opentype'); font-weight: normal; font-style: normal; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', Arial, sans-serif;
      font-size: 9pt;
      background: #152220;
      color: #C4D8E6;
      min-height: 100vh;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 2.5rem;
      margin-bottom: 0.5rem;
      color: #F5F0E8;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .subtitle { color: #6A8A96; margin-bottom: 2rem; }
    .back-link {
      display: inline-block;
      margin-bottom: 1.5rem;
      color: #4B8FA8;
      text-decoration: none;
    }
    .back-link:hover { text-decoration: underline; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .stat-card {
      background: #1A3035;
      border-radius: 12px;
      padding: 1.5rem;
      border-left: 4px solid #0B607C;
    }
    .stat-card.purple { border-left-color: #4B8FA8; }
    .stat-card.blue { border-left-color: #0B607C; }
    .stat-card.orange { border-left-color: #C4D8E6; }

    .stat-value {
      font-size: 2.5rem;
      font-weight: bold;
      color: #C4D8E6;
      margin-bottom: 0.25rem;
      font-family: 'Playfair Display', Georgia, serif;
    }
    .stat-label {
      color: #6A8A96;
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .chart-container {
      background: #1A3035;
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1rem;
    }
    .chart-title {
      font-family: 'Playfair Display', Georgia, serif;
      color: #F5F0E8;
      font-size: 1.2rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }

    .bar-chart { margin-top: 1rem; }
    .bar-item {
      display: flex;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    .bar-label {
      min-width: 200px;
      color: #C4D8E6;
      font-size: 0.8rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-fill {
      background: linear-gradient(90deg, #0B607C, #4B8FA8);
      height: 24px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      padding: 0 0.5rem;
      color: #F5F0E8;
      font-weight: bold;
      font-size: 0.75rem;
      min-width: 30px;
    }

    .day-chart {
      display: flex;
      gap: 0.5rem;
      align-items: flex-end;
      height: 200px;
      margin-top: 1rem;
    }
    .day-bar {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
    }
    .day-bar-fill {
      width: 100%;
      background: linear-gradient(180deg, #0B607C, #4B8FA8);
      border-radius: 4px 4px 0 0;
      display: flex;
      align-items: flex-end;
      justify-content: center;
      color: #F5F0E8;
      font-size: 0.7rem;
      font-weight: bold;
      padding-bottom: 0.25rem;
    }
    .day-label {
      color: #6A8A96;
      font-size: 0.75rem;
      margin-top: 0.5rem;
    }

    .release-types {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 1rem;
      margin-top: 1rem;
    }
    .release-type {
      background: #0E1C1A;
      padding: 1rem;
      border-radius: 8px;
      text-align: center;
    }
    .release-type-count {
      font-size: 1.5rem;
      font-weight: bold;
      color: #C4D8E6;
      font-family: 'Playfair Display', Georgia, serif;
    }
    .release-type-label {
      color: #6A8A96;
      font-size: 0.75rem;
      margin-top: 0.25rem;
    }

    .time-series {
      display: flex;
      gap: 2px;
      align-items: flex-end;
      height: 150px;
      margin-top: 1rem;
    }
    .time-bar {
      flex: 1;
      background: linear-gradient(180deg, #0B607C, #4B8FA8);
      border-radius: 2px 2px 0 0;
      position: relative;
      min-width: 8px;
    }
    .time-bar:hover {
      background: linear-gradient(180deg, #4B8FA8, #C4D8E6);
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/api/status" class="back-link">← Back to Status</a>
    <h1>Statistics Dashboard</h1>
    <p class="subtitle">Data from the Mason County Jail Roster</p>
    
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.totalBookings.toLocaleString()}</div>
        <div class="stat-label">Total Bookings Tracked</div>
      </div>
      <div class="stat-card purple">
        <div class="stat-value">${stats.totalReleases.toLocaleString()}</div>
        <div class="stat-label">Total Releases Tracked</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-value">${stats.currentPopulation}</div>
        <div class="stat-label">Current Population</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-value">${stats.avgPopulation}</div>
        <div class="stat-label">Avg Daily Population</div>
      </div>
    </div>

    <div class="chart-container">
      <div class="chart-title">Bookings Over Last 30 Days</div>
      <div class="time-series">
        ${stats.timeSeriesData.map(d => {
          const maxCount = Math.max(...stats.timeSeriesData.map(x => x.count), 1);
          const height = (d.count / maxCount) * 100;
          return `<div class="time-bar" style="height: ${height}%" title="${d.date}: ${d.count} booking${d.count !== 1 ? 's' : ''}"></div>`;
        }).join('')}
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart-title">Most Common Charges</div>
      <div class="bar-chart">
        ${stats.commonCharges.map(item => `
          <div class="bar-item">
            <div class="bar-label">${item.charge}</div>
            <div class="bar-fill" style="width: ${(item.count / maxCharge) * 300}px;">
              ${item.count}
            </div>
          </div>
        `).join('')}
        ${stats.commonCharges.length === 0 ? '<p style="color: #72807A;">No charge data available yet</p>' : ''}
      </div>
    </div>
    
    <div class="chart-container">
      <div class="chart-title">Bookings by Day of Week</div>
      <div class="day-chart">
        ${Object.entries(stats.bookingsByDay).map(([day, count]) => `
          <div class="day-bar">
            <div class="day-bar-fill" style="height: ${(count / maxDay) * 180}px;">
              ${count > 0 ? count : ''}
            </div>
            <div class="day-label">${day}</div>
          </div>
        `).join('')}
      </div>
    </div>

    ${Object.keys(stats.releaseTypes).length > 0 ? `
<div class="chart-container">
  <div class="chart-title">Release Type Breakdown</div>
  <div class="release-types">
    ${Object.entries(stats.releaseTypes)
      .filter(([code]) => Object.prototype.hasOwnProperty.call(RELEASE_TYPE_NAMES, code))
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `
      <div class="release-type">
        <div class="release-type-count">${count}</div>
        <div style="font-size: 1rem; font-weight: bold; color: #C8C87A; margin: 0.25rem 0;">${code}</div>
        <div class="release-type-label">${RELEASE_TYPE_NAMES[code] || code}</div>
      </div>
    `).join('')}
  </div>

</div>` : ''}

    ${stats.avgTimeServedMins > 0 ? `
    <div class="chart-container">
      <div class="chart-title">Time Served Statistics (from PDF Data)</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-top: 1rem;">
        <div style="background: #0E1C1A; padding: 1rem; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5rem; font-weight: bold; color: #C4D8E6; font-family: 'Playfair Display', Georgia, serif;">${formatMinutes(stats.avgTimeServedMins)}</div>
          <div style="color: #6A8A96; font-size: 0.75rem; margin-top: 0.25rem;">Mean Time Served</div>
        </div>
        <div style="background: #0E1C1A; padding: 1rem; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5rem; font-weight: bold; color: #C4D8E6; font-family: 'Playfair Display', Georgia, serif;">${formatMinutes(stats.medianTimeServedMins)}</div>
          <div style="color: #6A8A96; font-size: 0.75rem; margin-top: 0.25rem;">Median Time Served</div>
        </div>
        <div style="background: #0E1C1A; padding: 1rem; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5rem; font-weight: bold; color: #C4D8E6; font-family: 'Playfair Display', Georgia, serif;">${formatMinutes(stats.minTimeServedMins)}</div>
          <div style="color: #6A8A96; font-size: 0.75rem; margin-top: 0.25rem;">Shortest Stay</div>
        </div>
        <div style="background: #0E1C1A; padding: 1rem; border-radius: 8px; text-align: center;">
          <div style="font-size: 1.5rem; font-weight: bold; color: #C4D8E6; font-family: 'Playfair Display', Georgia, serif;">${stats.longestCurrentMins > 0 ? formatMinutes(stats.longestCurrentMins) : 'N/A'}</div>
          <div style="color: #6A8A96; font-size: 0.75rem; margin-top: 0.25rem;">Longest Current Stay</div>
          ${stats.longestInmate ? `<div style="color: #6A8A96; font-size: 0.65rem; margin-top: 0.2rem; font-family: 'Fake Receipt', monospace;">${stats.longestInmate.name}</div>` : ''}
        </div>
      </div>
    </div>` : ''}

    ${ /* TODO: re-enable Average Bail by Charge Type in a few weeks (data still being collected via avgBailByCharge)
    stats.avgBailByCharge.length > 0 ? `
    <div class="chart-container">
      <div class="chart-title">Average Bail by Charge Type</div>
      <div class="bar-chart">
        ${(() => {
          const maxBail = Math.max(...stats.avgBailByCharge.map(x => x.avgBail), 1);
          return stats.avgBailByCharge.map(item => `
            <div class="bar-item">
              <div class="bar-label">${item.charge}</div>
              <div class="bar-fill" style="width: ${(item.avgBail / maxBail) * 300}px; background: linear-gradient(90deg, #4E5A58, #C8C87A);">
                $${item.avgBail.toLocaleString()}
              </div>
            </div>
          `).join('');
        })()}
      </div>
    </div>` : ''
    */ ''}

  </div>
</body>
</html>`;
}

// ── DEEP STATS (unlisted admin page) ─────────────────────────────────────────
app.get('/api/deepstats', async (req, res) => {
  try {
    // Load history
    const history = getAllReleases();

    // Build name→charges and booked-names list from change log
    const nameToCharges = new Map();
    const bookedNamesList = [];
    for (const line of getAllEventLines()) {
      if (line.startsWith('BOOKED |')) {
        const nm = line.match(/BOOKED \| ([^|]+) \|/);
        const ch = line.match(/Charges:\s+(.+)/);
        if (nm) {
          const name = nm[1].trim();
          bookedNamesList.push(name);
          if (ch && !nameToCharges.has(name)) {
            const charges = ch[1].split(',').map(c => normalizeCharge(c.trim())).filter(c => c && c !== 'None listed');
            if (charges.length) nameToCharges.set(name, charges);
          }
        }
      }
    }

    const now = new Date();
    const todayStr = now.toDateString();
    const weekAgo  = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const yearStart  = new Date(now.getFullYear(), 0, 1);

    // ── Release type stats ────────────────────────────────────────────────────
    const rtStats = {}; // code → { count, totalMins, totalBail, bailCount }
    for (const e of history) {
      const code = normalizeReleaseType(e.releaseType);
      if (!rtStats[code]) rtStats[code] = { count: 0, totalMins: 0, totalBail: 0, bailCount: 0 };
      rtStats[code].count++;
      const ts = (e.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
      if (ts) {
        const m = parseInt(ts[1])*1440 + parseInt(ts[2])*60 + parseInt(ts[3]);
        if (m > 0 && m < 525600) rtStats[code].totalMins += m;
      }
      const bail = parseFloat((e.bail || '$0').replace(/[$,]/g, ''));
      if (bail > 0) { rtStats[code].totalBail += bail; rtStats[code].bailCount++; }
    }

    // ── Bail stats ────────────────────────────────────────────────────────────
    let bailToday=0, bailWeek=0, bailMonth=0, bailYTD=0;
    let maxBail=0, maxBailEntry=null;
    const bailLeaderboardRaw = [];
    let bailCount=0, noBailCount=0;

    for (const e of history) {
      const bail = parseFloat((e.bail || '$0').replace(/[$,]/g, ''));
      const normalizedType = normalizeReleaseType(e.releaseType);
      const rd = e.releaseDateTime ? parseBookingDate(e.releaseDateTime) : null;
      if (bail > 0) {
        if (rd) {
          if (rd.toDateString() === todayStr) bailToday += bail;
          if (rd >= weekAgo)    bailWeek  += bail;
          if (rd >= monthStart) bailMonth += bail;
          if (rd >= yearStart)  bailYTD   += bail;
        }
        if (bail > maxBail) { maxBail = bail; maxBailEntry = e; }
        bailLeaderboardRaw.push({ ...e, bailAmt: bail, charges: nameToCharges.get(e.name) || [] });
      }
      if (normalizedType === 'BAIL') bailCount++;
      else if (normalizedType === 'PR') noBailCount++;
    }
    bailLeaderboardRaw.sort((a, b) => b.bailAmt - a.bailAmt);
    const top10Bail = bailLeaderboardRaw.slice(0, 10);
    
    // ── Per-charge correlations ───────────────────────────────────────────────
    const bailByCharge = {}, timeByCharge = {}, rtByCharge = {};
    for (const e of history) {
      const charges = nameToCharges.get(e.name) || [];
      const bail = parseFloat((e.bail || '$0').replace(/[$,]/g, ''));
      const ts = (e.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
      const mins = ts ? parseInt(ts[1])*1440 + parseInt(ts[2])*60 + parseInt(ts[3]) : 0;
      const type = e.releaseType || 'UNK';
      for (const charge of charges) {
        if (!charge) continue;
        if (bail > 0) {
          if (!bailByCharge[charge]) bailByCharge[charge] = { total:0, count:0, max:0 };
          bailByCharge[charge].total += bail;
          bailByCharge[charge].count++;
          if (bail > bailByCharge[charge].max) bailByCharge[charge].max = bail;
        }
        if (mins > 0 && mins < 525600) {
          if (!timeByCharge[charge]) timeByCharge[charge] = { totalMins:0, count:0, allMins:[] };
          timeByCharge[charge].totalMins += mins;
          timeByCharge[charge].count++;
          timeByCharge[charge].allMins.push(mins);
        }
        if (!rtByCharge[charge]) rtByCharge[charge] = {};
        rtByCharge[charge][type] = (rtByCharge[charge][type] || 0) + 1;
      }
    }

    // ── Time served ───────────────────────────────────────────────────────────
    let under24=0, over24=0, histMaxMins=0, histMaxEntry=null;
    let histMinMins=Infinity, histMinEntry=null;
    const allServedMins = [];
    for (const e of history) {
      const ts = (e.timeServed || '').match(/(\d+)d(\d+)h(\d+)m/);
      if (ts) {
        const m = parseInt(ts[1])*1440 + parseInt(ts[2])*60 + parseInt(ts[3]);
        if (m > 0 && m < 525600) {
          allServedMins.push(m);
          if (m < 1440) under24++; else over24++;
          if (m > histMaxMins) { histMaxMins = m; histMaxEntry = e; }
          if (m < histMinMins) { histMinMins = m; histMinEntry = e; }
        }
      }
    }
    const histMeanMins = allServedMins.length > 0 ? Math.round(allServedMins.reduce((a,b)=>a+b,0)/allServedMins.length) : 0;
    const _sorted = [...allServedMins].sort((a,b)=>a-b);
    const _mid = Math.floor(_sorted.length/2);
    const histMedianMins = _sorted.length === 0 ? 0 : _sorted.length % 2 === 0 ? Math.round((_sorted[_mid-1]+_sorted[_mid])/2) : _sorted[_mid];

    // ── Frequent flyers ───────────────────────────────────────────────────────
    const nameCounts = {};
    bookedNamesList.forEach(n => { nameCounts[n] = (nameCounts[n] || 0) + 1; });
    const frequentFlyers = Object.entries(nameCounts)
      .filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, count]) => ({ name, count, charges: nameToCharges.get(name) || [] }));

    // ── Busiest release day/time (from history PDF) ───────────────────────────
    const relDays  = { Sun:0, Mon:0, Tue:0, Wed:0, Thu:0, Fri:0, Sat:0 };
    const relHours = Array(24).fill(0);
    for (const e of history) {
      const dt = e.releaseDateTime ? parseBookingDate(e.releaseDateTime) : null;
      if (dt) {
        relDays[['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()]]++;
        const hr = dt.getHours();
        if (hr >= 0 && hr < 24) relHours[hr]++;
      }
    }

    // ── Busiest book day/time + current longest (live roster PDF) ─────────────
    const bookDays  = { Sun:0, Mon:0, Tue:0, Wed:0, Thu:0, Fri:0, Sat:0 };
    const bookHours = Array(24).fill(0);
    let currentLongest = null, currentLongestDays = 0;
    try {
      const pdfResp = await fetch(PDF_URL);
      if (pdfResp.ok) {
        const buf = Buffer.from(await pdfResp.arrayBuffer());
        const parsed = await PDFParser(buf);
        for (const [, b] of extractBookings(parsed.text).entries()) {
          if (b.bookDate && b.bookDate !== 'Unknown') {
            const dt = parseBookingDate(b.bookDate);
            if (dt) {
              bookDays[['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()]]++;
              const hr = dt.getHours();
              if (hr >= 0 && hr < 24) bookHours[hr]++;
              const daysIn = (now - dt) / 86400000;
              if (daysIn > currentLongestDays) {
                currentLongestDays = daysIn;
                currentLongest = { name: b.name, days: Math.floor(daysIn), bookDate: b.bookDate, charges: b.charges };
              }
            }
          }
        }
      }
    } catch (e) { console.error('deepstats PDF error:', e); }

    res.send(getDeepStatsHTML({
      history, rtStats, nameToCharges,
      bailToday, bailWeek, bailMonth, bailYTD, bailCount, noBailCount,
      maxBailEntry, top10Bail,
      bailByCharge, timeByCharge, rtByCharge,
      under24, over24,
      histMaxMins, histMaxEntry,
      histMinMins: histMinMins === Infinity ? 0 : histMinMins, histMinEntry,
      histMeanMins, histMedianMins,
      frequentFlyers,
      relDays, relHours, bookDays, bookHours,
      currentLongest,
    }));
  } catch (err) {
    console.error('Deep stats error:', err);
    res.status(500).send('Error: ' + err.message + '\n\nStack: ' + err.stack);
  }
});

function getDeepStatsHTML(d) {
  const total = d.history.length;
  const $ = n => '$' + (n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const pct = (n, of) => of > 0 ? ((n/of)*100).toFixed(1) + '%' : '—';

  // Precompute sorted arrays
  const rtArr = Object.entries(d.rtStats)
    .sort((a,b) => b[1].count - a[1].count)
    .map(([code, s]) => ({
      code,
      name: RELEASE_TYPE_NAMES[code] || code,
      count: s.count,
      pct: pct(s.count, total),
      avgTime: s.totalMins > 0 ? formatMinutes(Math.round(s.totalMins / s.count)) : '—',
      avgBail: s.bailCount > 0 ? $(Math.round(s.totalBail / s.bailCount)) : '—',
    }));

  const bailByChargeArr = Object.entries(d.bailByCharge)
    .map(([charge, s]) => ({ charge, avg: Math.round(s.total/s.count), max: s.max, count: s.count }))
    .sort((a,b) => b.max - a.max).slice(0, 12);

  const timeByChargeArr = Object.entries(d.timeByCharge)
    .map(([charge, s]) => {
      const sorted = [...s.allMins].sort((a,b) => a-b);
      const mid = Math.floor(sorted.length/2);
      const medianMins = sorted.length % 2 === 0 ? Math.round((sorted[mid-1]+sorted[mid])/2) : sorted[mid];
      return { charge, avgMins: Math.round(s.totalMins/s.count), medianMins, count: s.count };
    })
    .sort((a,b) => b.count - a.count);

  const rtByChargeArr = Object.entries(d.rtByCharge)
    .map(([charge, types]) => {
      const tot = Object.values(types).reduce((a,b)=>a+b,0);
      const top = Object.entries(types).sort((a,b)=>b[1]-a[1]);
      return { charge, total: tot, top };
    })
    .sort((a,b) => b.total - a.total).slice(0, 10);

  const maxRelDay = Math.max(...Object.values(d.relDays), 1);
  const maxRelHour = Math.max(...d.relHours, 1);
  const maxBookDay = Math.max(...Object.values(d.bookDays), 1);
  const maxBookHour = Math.max(...d.bookHours, 1);

  function dayBar(days, max) {
    return Object.entries(days).map(([day, count]) => `
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:4px;">
        <span style="min-width:32px;color:#C4D8E6;font-size:0.75rem;">${day}</span>
        <div style="background:linear-gradient(90deg,#0B607C,#4B8FA8);height:18px;width:${Math.round((count/max)*260)}px;border-radius:3px;min-width:2px;"></div>
        <span style="color:#C4D8E6;font-size:0.75rem;">${count}</span>
      </div>`).join('');
  }

  function hourBar(hours, max) {
    return hours.map((count, hr) => `
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:2px;">
        <span style="min-width:40px;color:#A8C4D0;font-size:0.7rem;">${String(hr).padStart(2,'0')}:00</span>
        <div style="background:linear-gradient(90deg,#0E2A32,#1A4A5C);height:14px;width:${Math.round((count/max)*260)}px;border-radius:2px;min-width:2px;"></div>
        <span style="color:#A8C4D0;font-size:0.7rem;">${count}</span>
      </div>`).join('');
  }

  return `<!DOCTYPE html>
<html>
<head>
  <title>Deep Stats — Washington Jail Data</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Inter',Arial,sans-serif;font-size:8.5pt;background:#152220;color:#C4D8E6;padding:2rem;min-height:100vh}
    .wrap{max-width:1100px;margin:0 auto}
    h1{font-family:'Playfair Display',Georgia,serif;font-size:1.6rem;color:#F5F0E8;margin-bottom:0.25rem;font-weight:700}
    h2{font-family:'Playfair Display',Georgia,serif;font-size:0.95rem;color:#4B8FA8;font-weight:600;margin:2rem 0 0.75rem;border-bottom:1px solid #1E3840;padding-bottom:0.4rem}
    a{color:#4B8FA8;text-decoration:none}
    .subtitle{color:#6A8A96;font-size:0.75rem;margin-bottom:2rem}
    table{width:100%;border-collapse:collapse;font-size:0.8rem;margin-top:0.5rem}
    th{color:#6A8A96;text-align:left;padding:0.4rem 0.5rem;border-bottom:1px solid #1E3840;font-weight:normal;text-transform:uppercase;font-size:0.7rem;letter-spacing:0.5px}
    td{padding:0.35rem 0.5rem;border-bottom:1px solid #0E1C1A;color:#C4D8E6;vertical-align:top}
    tr:hover td{background:#1A3035}
    .val{color:#F5F0E8;font-weight:bold;font-family:'Fake Receipt','Courier New',monospace}
    .dim{color:#6A8A96}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem;margin-top:0.75rem}
    .card{background:#1A3035;border-radius:8px;padding:1rem;border-left:3px solid #0B607C}
    .card .v{font-size:1.6rem;font-weight:bold;color:#C4D8E6;font-family:'Playfair Display',Georgia,serif}
    .card .l{color:#6A8A96;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.5px;margin-top:0.15rem}
    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
    @media(max-width:700px){.two-col{grid-template-columns:1fr}}
    .chip{display:inline-block;background:#0E1C1A;border:1px solid #1E3840;padding:1px 6px;border-radius:3px;font-size:0.7rem;margin:1px;color:#C4D8E6}
  </style>
</head>
<body>
<div class="wrap">
  <a href="/api/status" style="font-size:0.75rem;color:#4B8FA8;">← status</a>
  <h1 style="margin-top:0.5rem;">Deep Analytics</h1>
  <p class="subtitle">Mason County Jail · ${total} releases in history · Unlisted</p>

  <h2>Release Type Breakdown</h2>
  <table>
    <tr><th>Code</th><th>Name</th><th>Count</th><th>%</th><th>Avg Time Served</th><th>Avg Bail (if any)</th></tr>
    ${rtArr.map(r => `<tr>
      <td class="val">${r.code}</td>
      <td>${r.name}</td>
      <td>${r.count}</td>
      <td>${r.pct}</td>
      <td>${r.avgTime}</td>
      <td>${r.avgBail}</td>
    </tr>`).join('')}
    ${rtArr.length === 0 ? '<tr><td colspan="6" class="dim">No data yet — run /api/run first</td></tr>' : ''}
  </table>

  <h2>Bail Summary</h2>
  <div class="cards">
    <div class="card"><div class="v">${$( d.bailToday)}</div><div class="l">Today</div></div>
    <div class="card"><div class="v">${$(d.bailWeek)}</div><div class="l">Last 7 Days</div></div>
    <div class="card"><div class="v">${$(d.bailMonth)}</div><div class="l">This Month</div></div>
    <div class="card"><div class="v">${$(d.bailYTD)}</div><div class="l">Year to Date</div></div>
    <div class="card" style="border-left-color:#0B7C5C"><div class="v">${d.bailCount}</div><div class="l">Paid Bail</div></div>
    <div class="card" style="border-left-color:#7C1A1A"><div class="v">${d.noBailCount}</div><div class="l">Zero-Dollar Releases</div></div>
    <div class="card" style="border-left-color:#2A4A5C">
      <div class="v">${d.bailCount + d.noBailCount > 0 ? pct(d.bailCount, d.bailCount + d.noBailCount) : '—'}</div>
      <div class="l">Bail Bond vs PR Release Ratio</div>
    </div>
    ${d.maxBailEntry ? `<div class="card" style="border-left-color:#5C3A1A">
      <div class="v" style="font-size:1.2rem;">${$(d.maxBailEntry.bailAmt || parseFloat((d.maxBailEntry.bail||'$0').replace(/[$,]/g,'')))}</div>
      <div class="l">Most Expensive Bail Ever</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#C4D8E6;font-family:'Fake Receipt','Courier New',monospace;">${d.maxBailEntry.name}</div>
    </div>` : ''}
  </div>

  <h2>Top 10 Bail Leaderboard</h2>
  <table>
    <tr><th>#</th><th>Name</th><th>Bail</th><th>Type</th><th>Released</th><th>Charges</th></tr>
    ${d.top10Bail.map((e, i) => `<tr>
      <td class="dim">${i+1}</td>
      <td class="val">${e.name}</td>
      <td style="color:#C8C87A;font-weight:bold;">${$(e.bailAmt)}</td>
      <td><span class="chip">${e.releaseType || '?'}</span></td>
      <td class="dim">${e.releaseDateTime ? formatShortDateTime(parseBookingDate(e.releaseDateTime)) || '—' : '—'}</td>
      <td style="font-size:0.7rem;">${e.charges.length ? e.charges.join(', ') : '<span class="dim">—</span>'}</td>
    </tr>`).join('')}
    ${d.top10Bail.length === 0 ? '<tr><td colspan="6" class="dim">No bail data yet</td></tr>' : ''}
  </table>

  <h2>Average &amp; Max Bail by Charge Type</h2>
  <table>
    <tr><th>Charge</th><th>Avg Bail</th><th>Highest Bail</th><th>Count</th></tr>
    ${bailByChargeArr.map(r => `<tr>
      <td>${r.charge}</td>
      <td class="val">${$(r.avg)}</td>
      <td style="color:#C8C87A;">${$(r.max)}</td>
      <td class="dim">${r.count}</td>
    </tr>`).join('')}
    ${bailByChargeArr.length === 0 ? '<tr><td colspan="4" class="dim">No data yet</td></tr>' : ''}
  </table>

  <h2>Time Served by Charge</h2>
  <table>
    <tr><th>Charge</th><th>Mean</th><th>Median</th><th>Count</th></tr>
    ${timeByChargeArr.map(r => `<tr>
      <td>${r.charge}</td>
      <td class="val">${formatMinutes(r.avgMins)}</td>
      <td class="val">${formatMinutes(r.medianMins)}</td>
      <td class="dim">${r.count}</td>
    </tr>`).join('')}
    ${timeByChargeArr.length === 0 ? '<tr><td colspan="4" class="dim">No data yet</td></tr>' : ''}
  </table>

  <h2>Release Type by Charge</h2>
  <table>
    <tr><th>Charge</th><th>Total</th><th>Top Release Type</th><th>Full Breakdown</th></tr>
    ${rtByChargeArr.map(r => `<tr>
      <td>${r.charge}</td>
      <td class="dim">${r.total}</td>
      <td><span class="chip">${r.top[0][0]}</span> <span class="dim">${r.top[0][1]}×</span></td>
      <td style="font-size:0.7rem;">${r.top.map(([code, cnt]) => `<span class="chip">${code} ${cnt}</span>`).join(' ')}</td>
    </tr>`).join('')}
    ${rtByChargeArr.length === 0 ? '<tr><td colspan="4" class="dim">No data yet</td></tr>' : ''}
  </table>

  <h2>Time Served Statistics</h2>
  <div class="cards">
    ${d.histMeanMins > 0 ? `<div class="card">
      <div class="v" style="font-size:1.2rem;">${formatMinutes(d.histMeanMins)}</div>
      <div class="l">Mean Time Served</div>
    </div>` : ''}
    ${d.histMedianMins > 0 ? `<div class="card">
      <div class="v" style="font-size:1.2rem;">${formatMinutes(d.histMedianMins)}</div>
      <div class="l">Median Time Served</div>
    </div>` : ''}
    <div class="card">
      <div class="v">${d.under24 + d.over24 > 0 ? pct(d.under24, d.under24+d.over24) : '—'}</div>
      <div class="l">Released in &lt;24 Hours</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#72807A;">${d.under24} under / ${d.over24} over</div>
    </div>
    ${d.histMinEntry ? `<div class="card" style="border-left-color:#0B7C5C">
      <div class="v" style="font-size:1.2rem;">${formatMinutes(d.histMinMins)}</div>
      <div class="l">Shortest Stay Ever</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#C4D8E6;font-family:'Fake Receipt','Courier New',monospace;">${d.histMinEntry.name}</div>
    </div>` : ''}
    ${d.histMaxEntry ? `<div class="card" style="border-left-color:#7C1A1A">
      <div class="v" style="font-size:1.2rem;">${formatMinutes(d.histMaxMins)}</div>
      <div class="l">Historical Longest Stay</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#C4D8E6;font-family:'Fake Receipt','Courier New',monospace;">${d.histMaxEntry.name}</div>
    </div>` : ''}
    ${d.currentLongest ? `<div class="card" style="border-left-color:#5C3A1A">
      <div class="v" style="font-size:1.2rem;">${d.currentLongest.days}d</div>
      <div class="l">Current Longest Stay</div>
      <div style="margin-top:0.4rem;font-size:0.7rem;color:#C4D8E6;font-family:'Fake Receipt','Courier New',monospace;">${d.currentLongest.name}</div>
      <div style="font-size:0.65rem;color:#6A8A96;">In since ${formatShortDateTime(parseBookingDate(d.currentLongest.bookDate))}</div>
    </div>` : ''}
  </div>

  <h2>Frequent Flyers (Booked 2+ Times)</h2>
  <table>
    <tr><th>Name</th><th>Bookings</th><th>Charges</th></tr>
    ${d.frequentFlyers.map(f => `<tr>
      <td class="val">${f.name}</td>
      <td style="color:#C8C87A;text-align:center;">${f.count}</td>
      <td style="font-size:0.7rem;">${f.charges.length ? f.charges.join(', ') : '<span class="dim">—</span>'}</td>
    </tr>`).join('')}
    ${d.frequentFlyers.length === 0 ? '<tr><td colspan="3" class="dim">No repeat bookings yet</td></tr>' : ''}
  </table>

  <h2>Busiest Release Times (from 48hr PDF)</h2>
  <div class="two-col">
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Day of Week</p>
      ${dayBar(d.relDays, maxRelDay)}
    </div>
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Hour of Day</p>
      ${hourBar(d.relHours, maxRelHour)}
    </div>
  </div>

  <h2>Busiest Booking Times (from live roster PDF)</h2>
  <div class="two-col">
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Day of Week</p>
      ${dayBar(d.bookDays, maxBookDay)}
    </div>
    <div>
      <p style="color:#72807A;font-size:0.7rem;margin-bottom:0.5rem;text-transform:uppercase;">Hour of Day</p>
      ${hourBar(d.bookHours, maxBookHour)}
    </div>
  </div>

  <h2>Release Type Definitions</h2>
  <table>
    <tr><th>Code</th><th>Meaning</th></tr>
    <tr><td class="val">RBB</td><td>Released on Bail Bond — a bail bondsman posted a surety bond on behalf of the inmate</td></tr>
    <tr><td class="val">RPR</td><td>Released on Personal Recognizance — released on a signed promise to appear; no money required</td></tr>
    <tr><td class="val">ROA</td><td>Released on Own Recognizance — same as RPR; released without bail on promise to appear</td></tr>
    <tr><td class="val">RCB</td><td>Released on Cash Bail — full bail amount paid in cash directly to the jail or court</td></tr>
    <tr><td class="val">RCC</td><td>Released — Credit for Time Served — sentence satisfied by time already spent in custody</td></tr>
    <tr><td class="val">RCD</td><td>Released — Court Disposition — released following a court ruling or final case disposition</td></tr>
    <tr><td class="val">RCT</td><td>Released by Court Order — judge issued a specific order to release the inmate</td></tr>
    <tr><td class="val">RFTA</td><td>Released — FTA / Dismissed — charges dismissed or failure-to-appear warrant resolved</td></tr>
    <tr><td class="val">RNCM</td><td>Released — No Charges Filed — prosecutor declined to file; inmate released without charges</td></tr>
    <tr><td class="val">RNHM</td><td>Released — No Hold — no active hold or detainer; no legal basis to continue detention</td></tr>
    <tr><td class="val">MIS</td><td>Released — Mistaken Identity — wrong person was arrested or booked</td></tr>
    <tr><td class="val">RTR</td><td>Released to Rehab/Treatment — transferred to a treatment or rehabilitation program</td></tr>
  </table>

</div>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Visit: http://localhost:${PORT}`);

  // Auto-run roster check every 30 minutes
  const RUN_INTERVAL_MS = 30 * 60 * 1000;
  const autoRun = () => {
    fetch(`http://localhost:${PORT}/api/run`)
      .then(r => r.text())
      .then(t => console.log(`[auto-run] ${new Date().toISOString()} — ${t.slice(0, 120)}`))
      .catch(e => console.error(`[auto-run error] ${new Date().toISOString()} —`, e.message));
  };
  setInterval(autoRun, RUN_INTERVAL_MS);
  console.log(`[auto-run] scheduled every 30 minutes`)
});