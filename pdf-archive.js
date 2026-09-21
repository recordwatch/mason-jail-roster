import crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Railway's "AWS SDK preset" injects these into the environment when a
// Storage Bucket is connected to this service. AWS_S3_URL_STYLE is
// Railway's own addition (not a standard AWS SDK variable) signaling
// whether the bucket needs path-style addressing ("path") or the default
// virtual-hosted style ("virtual") - read here rather than hardcoded per
// instruction, since guessing wrong causes signature failures.
const BUCKET = process.env.AWS_S3_BUCKET_NAME;
const FORCE_PATH_STYLE = (process.env.AWS_S3_URL_STYLE || '').toLowerCase() === 'path';

const s3 = (BUCKET && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  ? new S3Client({
      region: process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION,
      endpoint: process.env.AWS_ENDPOINT_URL,
      forcePathStyle: FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

// Single manifest for both archived sources - each line identifies which
// source file it's for. S3-compatible storage has no native append, so
// "appending a line" means read-modify-write the whole object; this app's
// scrape runs on a single instance on a fixed interval, so the resulting
// race window (two concurrent writers clobbering each other's line) is a
// theoretical, low-consequence gap - worst case a duplicate re-archive
// next run, never data loss of an already-archived PDF - not worth the
// added complexity of conditional/optimistic-concurrency writes here.
const MANIFEST_KEY = 'mason/manifest.ndjson';

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readManifestLines() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: MANIFEST_KEY }));
    const body = await streamToBuffer(res.Body);
    return body.toString('utf-8').split('\n').filter(Boolean);
  } catch (e) {
    if (e.name === 'NoSuchKey') return [];
    throw e;
  }
}

function utcTimestamp() {
  // Compact ISO 8601 (no separators) - unambiguous, S3/URL-safe, and
  // sortable lexicographically within a filename's own prefix.
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Archives raw, unparsed PDF bytes to the connected Railway Storage Bucket,
 * but only when their SHA-256 differs from the last archived copy of the
 * same source file (per the manifest). Never throws: archiving is a
 * best-effort side channel and must never break the scrape it's attached to.
 *
 * @param {Buffer} buffer - the exact bytes fetched, before any parsing
 * @param {string} sourceUrl - the URL the bytes were fetched from
 * @param {Response} [response] - the fetch Response, for its Last-Modified header
 */
async function archiveRawPdf(buffer, sourceUrl, response) {
  if (!s3) return; // no bucket connected - silently a no-op
  try {
    const filename = sourceUrl.split('/').pop();
    const base = filename.replace(/\.pdf$/i, '');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    const lines = await readManifestLines();
    let lastHashForFile = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.file === filename) lastHashForFile = entry.sha256;
      } catch (_) { /* skip a malformed manifest line rather than fail archiving */ }
    }
    if (lastHashForFile === sha256) return; // unchanged since last archive

    const key = `mason/${base}/${utcTimestamp()}_${sha256.slice(0, 12)}.pdf`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'application/pdf',
    }));

    const manifestLine = JSON.stringify({
      file: filename,
      fetchedAt: new Date().toISOString(),
      sourceUrl,
      sha256,
      byteSize: buffer.length,
      lastModified: response?.headers?.get?.('last-modified') || null,
      key,
    });
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: MANIFEST_KEY,
      Body: [...lines, manifestLine].join('\n') + '\n',
      ContentType: 'application/x-ndjson',
    }));
  } catch (e) {
    console.error('PDF archive error (non-fatal, scrape continues):', e.message);
  }
}

export { archiveRawPdf };
