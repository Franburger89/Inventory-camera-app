import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const QUANTITIES = new Set([1, 2, 3, 5]);

export function slugify(value) {
  const slug = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'location';
}

export function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function padSequence(sequence) {
  return `${String(sequence).padStart(4, '0')}.jpg`;
}

export function summarize(session, { includePhotos = false } = {}) {
  const photos = session.photos || [];
  const body = {
    id: session.id,
    location: session.location,
    location_slug: session.location_slug,
    person: session.person,
    staff: session.staff,
    started_at: session.started_at,
    ended_at: session.ended_at,
    processed: Boolean(session.processed),
    processed_at: session.processed_at,
    folder: session.folder,
    photo_count: photos.length,
    total_quantity: photos.reduce((sum, photo) => sum + (Number(photo.quantity) || 0), 0),
  };
  if (includePhotos) {
    body.photos = photos.map((photo) => ({
      filename: photo.filename,
      captured_at: photo.captured_at,
      quantity: photo.quantity,
      status: photo.status,
      client_id: photo.client_id,
    }));
  }
  return body;
}

export function createStore(dataDir) {
  const sessionsDir = path.join(dataDir, 'sessions');
  const indexPath = path.join(sessionsDir, 'index.json');
  const chains = new Map();

  function withLock(key, fn) {
    const prev = chains.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  async function ensure() {
    await fs.mkdir(sessionsDir, { recursive: true });
  }

  async function readIndex() {
    try {
      const raw = await fs.readFile(indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  async function writeIndex(index) {
    const tmp = path.join(sessionsDir, `.index.${process.pid}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(index));
    await fs.rename(tmp, indexPath);
  }

  async function writeManifest(dir, manifest) {
    const tmp = path.join(dir, `.session.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(tmp, path.join(dir, 'session.json'));
  }

  async function readManifestFile(dir) {
    const raw = await fs.readFile(path.join(dir, 'session.json'), 'utf8');
    return JSON.parse(raw);
  }

  async function list() {
    await ensure();
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        sessions.push(await readManifestFile(path.join(sessionsDir, entry.name)));
      } catch {
        // Ignore folders that are not finished sessions.
      }
    }
    sessions.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    return sessions;
  }

  async function directoryFor(id) {
    if (!/^[a-f0-9]{10}$/.test(id)) return null;
    const indexed = await readIndex();
    if (indexed[id]) {
      const dir = path.join(sessionsDir, indexed[id]);
      try {
        await fs.access(path.join(dir, 'session.json'));
        return dir;
      } catch {
        // The index is stale. Rebuild it below.
      }
    }
    return withLock('index', async () => {
      const fresh = await readIndex();
      if (fresh[id]) {
        const dir = path.join(sessionsDir, fresh[id]);
        try {
          await fs.access(path.join(dir, 'session.json'));
          return dir;
        } catch {
          // Scan the session folders.
        }
      }
      const sessions = await list();
      const found = sessions.find((session) => session.id === id);
      if (!found) return null;
      fresh[id] = found.folder;
      await writeIndex(fresh);
      return path.join(sessionsDir, found.folder);
    });
  }

  async function read(id) {
    const dir = await directoryFor(id);
    if (!dir) return null;
    try {
      return await readManifestFile(dir);
    } catch {
      return null;
    }
  }

  function createSession({ location, person, staff }) {
    return withLock('index', async () => {
      await ensure();
      const started = new Date();
      let id = '';
      let folder = '';
      let dir = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        id = crypto.randomBytes(5).toString('hex');
        const locationSlug = slugify(location);
        folder = `${started.toISOString().slice(0, 10)}_${locationSlug}_${id}`;
        dir = path.join(sessionsDir, folder);
        try {
          await fs.mkdir(dir);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST' || attempt === 4) throw error;
        }
      }

      const manifest = {
        id,
        location,
        location_slug: slugify(location),
        person: person || null,
        staff,
        started_at: started.toISOString(),
        ended_at: null,
        processed: false,
        processed_at: null,
        folder,
        photos: [],
      };
      await writeManifest(dir, manifest);
      const index = await readIndex();
      index[id] = folder;
      await writeIndex(index);
      return manifest;
    });
  }

  function addPhoto(id, { clientId, capturedAt, quantity, sequence, buffer }) {
    return withLock(id, async () => {
      const dir = await directoryFor(id);
      if (!dir) return null;
      const manifest = await readManifestFile(dir);
      const existing = manifest.photos.find((photo) => photo.client_id === clientId);
      if (existing) {
        const dest = path.join(dir, existing.filename);
        try {
          await fs.access(dest);
        } catch {
          await fs.writeFile(dest, buffer);
        }
        return { manifest, photo: existing, duplicate: true };
      }

      const used = new Set(
        manifest.photos.map((photo) => Number(photo.filename.replace('.jpg', ''))),
      );
      let next = Number.isInteger(sequence) && sequence > 0 && sequence < 100000 ? sequence : manifest.photos.length + 1;
      while (used.has(next)) next += 1;
      const filename = padSequence(next);
      const dest = path.join(dir, filename);
      const tmp = path.join(dir, `.${clientId}.jpg.tmp`);
      await fs.writeFile(tmp, buffer);
      await fs.rename(tmp, dest);

      const photo = {
        filename,
        captured_at: capturedAt,
        quantity,
        status: 'uploaded',
        client_id: clientId,
      };
      manifest.photos.push(photo);
      manifest.photos.sort((a, b) => a.filename.localeCompare(b.filename));
      await writeManifest(dir, manifest);
      return { manifest, photo, duplicate: false };
    });
  }

  function finish(id, endedAt = new Date().toISOString()) {
    return withLock(id, async () => {
      const dir = await directoryFor(id);
      if (!dir) return null;
      const manifest = await readManifestFile(dir);
      if (!manifest.ended_at) {
        manifest.ended_at = endedAt;
        await writeManifest(dir, manifest);
      }
      return manifest;
    });
  }

  function setProcessed(id, processed, at = new Date().toISOString()) {
    return withLock(id, async () => {
      const dir = await directoryFor(id);
      if (!dir) return null;
      const manifest = await readManifestFile(dir);
      manifest.processed = processed;
      manifest.processed_at = processed ? at : null;
      await writeManifest(dir, manifest);
      return manifest;
    });
  }

  function photoPath(id, filename) {
    return withLock(id, async () => {
      if (!/^[0-9]{4}\.jpg$/.test(filename)) return null;
      const dir = await directoryFor(id);
      if (!dir) return null;
      const manifest = await readManifestFile(dir);
      const photo = manifest.photos.find((item) => item.filename === filename);
      if (!photo) return null;
      const full = path.join(dir, filename);
      try {
        await fs.access(full);
      } catch {
        return null;
      }
      return { manifest, photo, full, dir };
    });
  }

  return {
    dataDir,
    sessionsDir,
    list,
    read,
    createSession,
    addPhoto,
    finish,
    setProcessed,
    photoPath,
    directoryFor,
  };
}

export function parseQuantity(value) {
  const quantity = Number(value);
  if (!QUANTITIES.has(quantity)) return null;
  return quantity;
}

export function parseCapturedAt(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const now = Date.now();
  const earliest = Date.UTC(2000, 0, 1);
  if (time < earliest || time > now + 24 * 60 * 60 * 1000) return null;
  return new Date(time).toISOString();
}

export function parseClientId(value) {
  if (typeof value !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(value)) return null;
  return value;
}
