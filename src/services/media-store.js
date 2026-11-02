'use strict';

// Immutable platform media. The caller uploads and inserts its reference in
// ONE transaction; upload failure aborts that transaction, never falls back
// to storing bytes. During backfill only, a row without a key reads data.
//
// Every key column must REFERENCES media_objects(object_key), with an
// immediate foreign key. Its registry row serializes uploads with cleanup.
// Cleanup deletes that row BEFORE the object, in the same transaction: a
// foreign key refusal leaves the object alone. A concurrent writer either
// keeps the row locked or waits and uploads again after cleanup commits.

const { createHash } = require('node:crypto');
const { createObjectStore } = require('./app-files');
const { pipeline } = require('node:stream/promises');
const transactionIO = require('./media-transaction-io');

const PREFIX = 'media/sha256/';
const KEY = /^media\/sha256\/[a-f0-9]{64}$/;
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

function objectKey(data) {
  if (!Buffer.isBuffer(data)) throw new TypeError('Media must be a Buffer');
  return PREFIX + createHash('sha256').update(data).digest('hex');
}

function checkedKey(key) {
  if (!KEY.test(key)) throw new TypeError('Invalid media object key');
  return key;
}

function requireStore(store) {
  if (!store) throw Object.assign(new Error('MEDIA_STORAGE_* is not configured'), { code: 'media_storage_unavailable' });
  return store;
}

function createMediaStore(config, { client } = {}) {
  const values = [config?.mediaStorageEndpoint, config?.mediaStorageBucket,
    config?.mediaStorageAccessKey, config?.mediaStorageSecretKey];
  if (values.every((v) => !v)) return null;
  if (values.some((v) => !v)) throw new Error('MEDIA_STORAGE_* requires an endpoint, bucket and both keys');
  const url = new URL(values[0]);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid MEDIA_STORAGE_ENDPOINT');
  client ||= new (require('minio').Client)({
    endPoint: url.hostname,
    port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
    useSSL: url.protocol === 'https:',
    accessKey: values[2], secretKey: values[3],
    transport: transactionIO.transport(url.protocol),
  });
  return createObjectStore({
    storageEndpoint: values[0], storageBucket: values[1],
    storageAccessKey: values[2], storageSecretKey: values[3],
  }, { client });
}

// No cached disabled state: a caller supplies its own config/store. Routes
// may construct one store at boot, while tests inject the in-memory store.
function getStore(config) {
  return createMediaStore(config || {
    mediaStorageEndpoint: process.env.MEDIA_STORAGE_ENDPOINT,
    mediaStorageBucket: process.env.MEDIA_STORAGE_BUCKET,
    mediaStorageAccessKey: process.env.MEDIA_STORAGE_ACCESS_KEY,
    mediaStorageSecretKey: process.env.MEDIA_STORAGE_SECRET_KEY,
  });
}

// Lock shared keys in the same order across transactions, including a
// run saving several files and both densities. This avoids deadlocks when
// two runs reuse the same files in a different order.
async function putMany(tx, store, files) {
  const keyed = files.map((file) => ({ ...file, key: objectKey(file.data) }));
  const unique = new Map(keyed.map((file) => [file.key, file]));
  for (const key of [...unique.keys()].sort()) {
    const file = unique.get(key);
    await put(tx, store, file.data, file.contentType);
  }
  return keyed.map((file) => file.key);
}

// `tx` MUST be a checked-out client inside the caller's transaction, so the
// lock survives until its key reference commits. This is intentionally not
// a function taking a pool: it cannot commit an upload separately from its row.
async function put(tx, store, data, contentType = 'application/octet-stream') {
  requireStore(store);
  const key = objectKey(data);
  await tx.query(
    `INSERT INTO media_objects (object_key) VALUES ($1)
     ON CONFLICT (object_key) DO UPDATE SET object_key = EXCLUDED.object_key`, [key]);
  // An immutable key is never rewritten, including on workflow retries:
  // a rewrite would make a fresh billable version in the versioned bucket.
  await transactionIO.run(tx, async (signal) => {
    const existing = await store.statObject(key);
    signal.throwIfAborted();
    if (existing && Number(existing.size) !== data.length) throw new Error(`Media object size mismatch: ${key}`);
    if (!existing) await store.putObject(key, data, contentType);
  });
  return key;
}

async function stream(store, key, range = null) {
  return requireStore(store).getObjectStream(checkedKey(key), range);
}

async function bytes(store, row, { key = 'object_key', data = 'data' } = {}) {
  if (!row[key]) {
    if (row[data] == null) throw new Error('Media row has neither an object key nor bytes');
    return Buffer.isBuffer(row[data]) ? row[data] : Buffer.from(row[data]);
  }
  // A keyed object failure must propagate. Its old byte column may be
  // empty, and falling back would conceal a missing/corrupt object.
  const chunks = [];
  for await (const chunk of await stream(store, row[key])) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Access checks, status and cache/ETag headers belong to the caller. S3
// receives the range itself; no full video is downloaded just to slice it.
async function respond(res, store, row, range = null) {
  try {
    if (row.object_key) return await pipeline(await stream(store, row.object_key, range), res);
    const data = await bytes(store, row);
    return res.end(range ? data.subarray(range.start, range.end + 1) : data);
  } catch (err) {
    // A failed object open must not leave an immutable media cache policy
    // or a media ETag on the caller's error response.
    if (!res.headersSent) {
      for (const header of ['Cache-Control', 'ETag', 'Content-Length', 'Content-Range', 'Content-Type', 'Content-Disposition']) {
        res.removeHeader(header);
      }
    }
    throw err;
  }
}

// Includes objects left by rolled-back uploads, which have no registry row.
// The FK, rather than a hard-coded table list, protects every migrated
// table's references (including both ordinary and dense keys).
async function removeOrphan(pool, store, key, cutoff) {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    // An upsert takes a row lock even when the key was registered before.
    await tx.query(
      `INSERT INTO media_objects (object_key) VALUES ($1)
       ON CONFLICT (object_key) DO UPDATE SET object_key = EXCLUDED.object_key`, [checkedKey(key)]);
    // Avoid the FK delete check taking locks on an owner's row while a
    // retake holds that row and waits for this registry key. This ordinary
    // MVCC read is conservative; the FK below remains the final authority
    // for new or other referencing tables, and concurrent new references.
    const { rows: [references] } = await tx.query(`SELECT EXISTS (
      SELECT 1 FROM shot_run_files WHERE object_key = $1 OR dense_object_key = $1
      UNION ALL SELECT 1 FROM shot_artifacts WHERE object_key = $1 OR dense_object_key = $1
      UNION ALL SELECT 1 FROM shots_eval_artifacts WHERE object_key = $1
      UNION ALL SELECT 1 FROM shot_diagnostic_artifacts WHERE object_key = $1
      UNION ALL SELECT 1 FROM session_visuals WHERE object_key = $1
      UNION ALL SELECT 1 FROM check_run_media WHERE object_key = $1
      UNION ALL SELECT 1 FROM homeroom_bot_picture_images WHERE object_key = $1
    ) AS present`, [key]);
    if (references.present) {
      await tx.query('COMMIT');
      return false;
    }
    const stat = await transactionIO.run(tx, () => store.statObject(key));
    // Check again under the lock: an upload may have created this object
    // since listing began. An invalid/missing timestamp is never old enough.
    const modified = stat?.lastModified == null ? NaN : new Date(stat.lastModified).getTime();
    if (stat && (!Number.isFinite(modified) || modified >= cutoff)) {
      await tx.query('COMMIT');
      return false;
    }
    await tx.query('SAVEPOINT media_reference');
    try {
      await tx.query('DELETE FROM media_objects WHERE object_key = $1', [key]);
    } catch (err) {
      if (err.code !== '23503') throw err;
      await tx.query('ROLLBACK TO SAVEPOINT media_reference');
      await tx.query('COMMIT');
      return false;
    }
    if (stat) await transactionIO.run(tx, () => store.removeObject(key));
    await tx.query('COMMIT');
    return !!stat;
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

// One bounded page per clock run. Its result persists the cursor, so a
// bucket full of referenced files cannot starve later orphaned ones.
async function sweep(pool, store, {
  after = '', limit = 200, now = Date.now(), shouldStop = () => false,
} = {}) {
  if (!store) return { skipped: 'unconfigured' };
  const out = { examined: 0, removed: 0, after: '' };
  const cutoff = now - ORPHAN_AGE_MS;
  const max = Math.max(1, Math.min(1000, Number(limit) || 200));
  for await (const object of store.objects(PREFIX, after)) {
    if (shouldStop()) { out.after = after; return out; }
    out.examined++;
    after = object.name;
    const modified = object.lastModified == null ? NaN : new Date(object.lastModified).getTime();
    if (KEY.test(object.name) && Number.isFinite(modified) && modified < cutoff) {
      if (await removeOrphan(pool, store, object.name, cutoff)) out.removed++;
    }
    if (out.examined >= max) { out.after = after; return out; }
  }
  return out;
}

module.exports = { PREFIX, ORPHAN_AGE_MS, objectKey, createMediaStore, getStore, put, putMany, stream, bytes, respond, sweep };
