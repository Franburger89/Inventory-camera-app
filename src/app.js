import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import archiver from 'archiver';
import express from 'express';
import multer from 'multer';

import {
  bearerToken,
  readCookie,
  requestIsSecure,
  safeEqual,
  signStaffCookie,
  staffCookieHeader,
  verifyStaffCookie,
} from './auth.js';
import {
  createStore,
  isJpeg,
  parseCapturedAt,
  parseClientId,
  parseQuantity,
  summarize,
} from './store.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 8 },
});

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createApp({ dataDir, staffPin = '', adminToken, locations, people }) {
  if (!adminToken) {
    throw new Error('adminToken is required');
  }
  const pinRequired = Boolean(staffPin);

  const store = createStore(dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const failures = new Map();

  function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  function rateLimited(ip) {
    const row = failures.get(ip);
    return Boolean(row && row.until > Date.now());
  }

  function recordFailure(ip) {
    const row = failures.get(ip) || { count: 0, until: 0 };
    if (row.until && row.until <= Date.now()) {
      row.count = 0;
      row.until = 0;
    }
    row.count += 1;
    if (row.count >= 8) {
      row.until = Date.now() + 15_000;
      row.count = 0;
    }
    failures.set(ip, row);
  }

  function clearFailures(ip) {
    failures.delete(ip);
  }

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '32kb' }));

  app.get(
    '/health',
    asyncRoute(async (req, res) => {
      const probe = path.join(dataDir, `.healthcheck-${process.pid}`);
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(probe, 'ok');
        res.json({ ok: true });
      } catch (error) {
        console.error(JSON.stringify({ event: 'health_failed', message: error.message }));
        res.status(503).json({ ok: false });
      } finally {
        await fs.rm(probe, { force: true }).catch(() => {});
      }
    }),
  );

  function requireStaff(req, res, next) {
    if (!pinRequired) return next();
    if (!verifyStaffCookie(staffPin, readCookie(req))) {
      return res.status(401).json({ error: 'Sign in required' });
    }
    return next();
  }

  function requireAdmin(req, res, next) {
    const token = bearerToken(req);
    if (!token || !safeEqual(token, adminToken)) {
      return res.status(401).json({ error: 'Admin token required' });
    }
    return next();
  }

  app.post('/api/login', (req, res) => {
    if (!pinRequired) {
      return res.json({ ok: true, pinRequired: false });
    }
    const ip = clientIp(req);
    if (rateLimited(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Wait a moment and try again.' });
    }
    const pin = req.body && typeof req.body.pin === 'string' ? req.body.pin : '';
    if (!safeEqual(pin, staffPin)) {
      recordFailure(ip);
      return res.status(401).json({ error: 'That PIN is not recognised' });
    }
    clearFailures(ip);
    const token = signStaffCookie(staffPin);
    res.setHeader('Set-Cookie', staffCookieHeader(token, { secure: requestIsSecure(req) }));
    return res.json({ ok: true, pinRequired: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader(
      'Set-Cookie',
      staffCookieHeader('', { secure: requestIsSecure(req), maxAge: 0 }),
    );
    res.json({ ok: true });
  });

  app.get('/api/me', requireStaff, (req, res) => {
    res.json({ ok: true, pinRequired });
  });

  app.get('/api/config', requireStaff, (req, res) => {
    res.json({ locations, people });
  });

  app.post(
    '/api/sessions',
    requireStaff,
    asyncRoute(async (req, res) => {
      const location = req.body && typeof req.body.location === 'string' ? req.body.location.trim() : '';
      const personRaw = req.body && typeof req.body.person === 'string' ? req.body.person.trim() : '';
      const staff = req.body && typeof req.body.staff === 'string'
        ? req.body.staff.replace(/[\u0000-\u001f]/g, '').trim()
        : '';

      if (!locations.includes(location)) {
        return res.status(400).json({ error: 'Choose a location' });
      }
      if (personRaw && !people.includes(personRaw)) {
        return res.status(400).json({ error: 'Choose a person from the list, or leave it blank' });
      }
      if (staff.length < 1 || staff.length > 80) {
        return res.status(400).json({ error: 'Enter your name' });
      }

      const session = await store.createSession({
        location,
        person: personRaw || null,
        staff,
      });
      console.log(JSON.stringify({ event: 'session_created', id: session.id, folder: session.folder }));
      return res.status(201).json(summarize(session, { includePhotos: true }));
    }),
  );

  app.get(
    '/api/sessions/:id',
    requireStaff,
    asyncRoute(async (req, res) => {
      const session = await store.read(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      return res.json(summarize(session, { includePhotos: true }));
    }),
  );

  app.post(
    '/api/sessions/:id/photos',
    requireStaff,
    (req, res, next) => {
      upload.single('photo')(req, res, (error) => {
        if (!error) return next();
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: 'Photo upload was rejected' });
      });
    },
    asyncRoute(async (req, res) => {
      const clientId = parseClientId(req.body?.client_id);
      const capturedAt = parseCapturedAt(req.body?.captured_at);
      const quantity = parseQuantity(req.body?.quantity);
      const sequenceRaw = Number(req.body?.sequence);
      const sequence = Number.isInteger(sequenceRaw) ? sequenceRaw : null;

      if (!clientId) return res.status(400).json({ error: 'Missing photo id' });
      if (!capturedAt) return res.status(400).json({ error: 'Missing capture time' });
      if (!quantity) return res.status(400).json({ error: 'Quantity must be 1, 2, 3, or 5' });
      if (!req.file || !isJpeg(req.file.buffer)) {
        return res.status(400).json({ error: 'Photo must be a JPEG' });
      }

      const saved = await store.addPhoto(req.params.id, {
        clientId,
        capturedAt,
        quantity,
        sequence,
        buffer: req.file.buffer,
      });
      if (!saved) return res.status(404).json({ error: 'Session not found' });

      if (!saved.duplicate) {
        console.log(
          JSON.stringify({
            event: 'photo_saved',
            session: req.params.id,
            filename: saved.photo.filename,
            quantity,
          }),
        );
      }

      return res.status(saved.duplicate ? 200 : 201).json({
        ...saved.photo,
        duplicate: saved.duplicate,
      });
    }),
  );

  app.post(
    '/api/sessions/:id/finish',
    requireStaff,
    asyncRoute(async (req, res) => {
      const session = await store.finish(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      console.log(JSON.stringify({ event: 'session_finished', id: session.id }));
      return res.json(summarize(session, { includePhotos: true }));
    }),
  );

  app.get(
    '/api/admin/sessions',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const processed = req.query.processed;
      if (processed !== undefined && processed !== 'true' && processed !== 'false') {
        return res.status(400).json({ error: 'processed must be true or false' });
      }
      let sessions = await store.list();
      if (processed === 'true') sessions = sessions.filter((session) => session.processed);
      if (processed === 'false') sessions = sessions.filter((session) => !session.processed);
      return res.json({ sessions: sessions.map((session) => summarize(session)) });
    }),
  );

  app.get(
    '/api/admin/sessions/:id',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const session = await store.read(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      return res.json(summarize(session, { includePhotos: true }));
    }),
  );

  app.get(
    '/api/admin/sessions/:id/zip',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const session = await store.read(req.params.id);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      const dir = await store.directoryFor(session.id);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${session.folder}.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (error) => {
        console.error(JSON.stringify({ event: 'zip_failed', message: error.message }));
        if (!res.headersSent) {
          res.status(500).json({ error: 'Could not build the zip' });
        } else {
          res.destroy(error);
        }
      });
      archive.pipe(res);
      archive.file(path.join(dir, 'session.json'), { name: 'session.json' });
      for (const photo of session.photos) {
        archive.file(path.join(dir, photo.filename), { name: photo.filename });
      }
      await archive.finalize();
    }),
  );

  app.get(
    '/api/admin/sessions/:id/photos/:filename',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const found = await store.photoPath(req.params.id, req.params.filename);
      if (!found) return res.status(404).json({ error: 'Photo not found' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Content-Disposition', `inline; filename="${found.photo.filename}"`);
      res.sendFile(found.full);
    }),
  );

  app.post(
    '/api/admin/sessions/:id/processed',
    requireAdmin,
    asyncRoute(async (req, res) => {
      const processed = req.body && Object.prototype.hasOwnProperty.call(req.body, 'processed')
        ? req.body.processed
        : true;
      if (typeof processed !== 'boolean') {
        return res.status(400).json({ error: 'processed must be true or false' });
      }
      const session = await store.setProcessed(req.params.id, processed);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      console.log(JSON.stringify({ event: 'session_processed', id: session.id, processed }));
      return res.json(summarize(session, { includePhotos: true }));
    }),
  );

  app.use(
    express.static(publicDir, {
      etag: true,
      index: 'index.html',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.webmanifest')) {
          res.setHeader('Content-Type', 'application/manifest+json');
        }
        if (
          filePath.endsWith(`${path.sep}sw.js`) ||
          filePath.endsWith(`${path.sep}index.html`) ||
          filePath.endsWith('.webmanifest')
        ) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    console.error(JSON.stringify({ event: 'request_failed', message: error?.message || 'error' }));
    return res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
