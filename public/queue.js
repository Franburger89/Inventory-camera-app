const DB_NAME = 'stocktake';
const DB_VERSION = 1;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('photos')) {
        const photos = database.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('sessionId', 'sessionId', { unique: false });
        photos.createIndex('status', 'status', { unique: false });
      }
      if (!database.objectStoreNames.contains('blobs')) {
        database.createObjectStore('blobs', { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let databasePromise;
function database() {
  if (!databasePromise) databasePromise = openDatabase();
  return databasePromise;
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export async function enqueuePhoto(record, blob) {
  const db = await database();
  const tx = db.transaction(['photos', 'blobs'], 'readwrite');
  tx.objectStore('photos').put({
    id: record.id,
    sessionId: record.sessionId,
    sequence: record.sequence,
    quantity: record.quantity,
    capturedAt: record.capturedAt,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: 0,
    lastError: '',
    filename: '',
  });
  tx.objectStore('blobs').put({ id: record.id, blob });
  await transactionDone(tx);
  pump();
}

export async function allPhotos() {
  const db = await database();
  const tx = db.transaction('photos', 'readonly');
  const request = tx.objectStore('photos').getAll();
  const rows = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  await transactionDone(tx);
  return rows;
}

function reduceStats(rows) {
  return {
    captured: rows.length,
    quantity: rows.reduce((sum, row) => sum + (Number(row.quantity) || 1), 0),
    queued: rows.filter((row) => row.status === 'queued' || row.status === 'uploading').length,
    uploaded: rows.filter((row) => row.status === 'uploaded').length,
    failed: rows.filter((row) => row.status === 'failed').length,
  };
}

export async function statsFor(sessionId) {
  const rows = await allPhotos();
  const mine = sessionId ? rows.filter((row) => row.sessionId === sessionId) : rows;
  return reduceStats(mine);
}

export async function maxSequence(sessionId) {
  const rows = await allPhotos();
  return rows
    .filter((row) => row.sessionId === sessionId)
    .reduce((max, row) => Math.max(max, Number(row.sequence) || 0), 0);
}

async function putPhoto(row) {
  const db = await database();
  const tx = db.transaction('photos', 'readwrite');
  tx.objectStore('photos').put(row);
  await transactionDone(tx);
}

async function readBlob(id) {
  const db = await database();
  const tx = db.transaction('blobs', 'readonly');
  const request = tx.objectStore('blobs').get(id);
  const row = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
  await transactionDone(tx);
  return row ? row.blob : null;
}

async function deleteBlob(id) {
  const db = await database();
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').delete(id);
  await transactionDone(tx);
}

let uploadFn = async () => {};
let onChange = () => {};
let onAuthRequired = () => {};
let running = false;
let paused = false;
let started = false;

export function startQueue(options) {
  uploadFn = options.upload;
  onChange = options.onChange || (() => {});
  onAuthRequired = options.onAuthRequired || (() => {});
  if (started) return;
  started = true;
  resetStuck()
    .catch(() => {})
    .finally(() => {
      pump();
    });
  setInterval(() => {
    pump();
  }, 2500);
  window.addEventListener('online', () => {
    paused = false;
    pump();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pump();
  });
}

async function resetStuck() {
  const rows = await allPhotos();
  for (const row of rows) {
    if (row.status === 'uploading') {
      row.status = 'queued';
      await putPhoto(row);
    }
  }
}

export function resumeQueue() {
  paused = false;
  pump();
}

export async function retryFailed(sessionId) {
  const rows = await allPhotos();
  for (const row of rows) {
    if (row.status !== 'failed') continue;
    if (sessionId && row.sessionId !== sessionId) continue;
    row.status = 'queued';
    row.attempts = 0;
    row.nextAttemptAt = 0;
    row.lastError = '';
    await putPhoto(row);
  }
  paused = false;
  await pump();
}

async function nextJob() {
  const now = Date.now();
  const rows = await allPhotos();
  return (
    rows
      .filter((row) => row.status === 'queued' && (row.nextAttemptAt || 0) <= now)
      .sort((a, b) => a.sequence - b.sequence || String(a.capturedAt).localeCompare(String(b.capturedAt)))[0] ||
    null
  );
}

export async function pump() {
  if (running || paused) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  running = true;
  try {
    for (let step = 0; step < 4; step += 1) {
      const job = await nextJob();
      if (!job) break;
      job.status = 'uploading';
      await putPhoto(job);
      onChange();
      try {
        const blob = await readBlob(job.id);
        if (!blob) {
          job.status = 'failed';
          job.lastError = 'Photo data missing on this device';
          await putPhoto(job);
          continue;
        }
        const result = await uploadFn(job, blob);
        job.status = 'uploaded';
        job.filename = result?.filename || '';
        job.lastError = '';
        await putPhoto(job);
        await deleteBlob(job.id);
      } catch (error) {
        const status = Number(error.status) || 0;
        job.attempts = (job.attempts || 0) + 1;
        job.lastError = error.message || 'Upload failed';
        if (status === 401) {
          job.status = 'queued';
          job.attempts -= 1;
          job.nextAttemptAt = 0;
          paused = true;
          await putPhoto(job);
          onAuthRequired();
          break;
        }
        const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (permanent) {
          job.status = 'failed';
        } else {
          job.status = 'queued';
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(job.attempts, 5));
          job.nextAttemptAt = Date.now() + delay;
        }
        await putPhoto(job);
        if (!permanent) break;
      }
    }
  } finally {
    running = false;
    onChange();
  }
}
