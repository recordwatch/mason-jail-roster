// Read-only access to Internet Archive (Wayback Machine) copies of a URL.
// Used to recover roster PDFs from before this app started archiving its
// own copies (pdf-archive.js) - the county only ever publishes the current
// roster, so these snapshots are the only record of older ones.

// Overridable only so tests can point at a local stand-in.
const WAYBACK_BASE = process.env.WAYBACK_BASE_URL || 'https://web.archive.org';
const FETCH_TIMEOUT_MS = 60000;

/**
 * Lists distinct successful snapshots of a URL, oldest first.
 * @param {string} url - e.g. the roster PDF_URL
 * @returns {Promise<string[]>} - Wayback timestamps like "20260321033528"
 */
async function listWaybackSnapshots(url) {
  const target = url.replace(/^https?:\/\//, '');
  // collapse=digest drops consecutive identical captures; filter keeps only
  // captures where the archive actually got the file (not a 404/redirect).
  const cdx = `${WAYBACK_BASE}/cdx/search/cdx?url=${encodeURIComponent(target)}&output=json&fl=timestamp&filter=statuscode:200&collapse=digest`;
  const res = await fetch(cdx, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wayback CDX lookup failed: ${res.status}`);
  const rows = await res.json();
  // First row is the header (["timestamp"]); an empty result is [] instead.
  return rows.slice(1).map(r => r[0]);
}

/**
 * Fetches the original bytes of one snapshot. The "id_" suffix asks the
 * Wayback Machine for the file exactly as captured, without its own toolbar
 * or URL rewriting.
 */
async function fetchWaybackSnapshot(url, timestamp) {
  const res = await fetch(`${WAYBACK_BASE}/web/${timestamp}id_/${url}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wayback fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // The archive sometimes answers 200 with an HTML error page; parsing that
  // as a roster would just silently find zero bookings.
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('Snapshot is not a PDF');
  return buf;
}

export { listWaybackSnapshots, fetchWaybackSnapshot };
