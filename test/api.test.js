import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';

const execFileAsync = promisify(execFile);

const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x08, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x7f, 0x00, 0xff, 0xd9,
]);

const PIN = '2468';
const ADMIN = 'test-admin-token';

async function withServer(fn, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'stocktake-'));
  const app = createApp({
    dataDir,
    staffPin: PIN,
    adminToken: ADMIN,
    locations: overrides.locations || [
      '32 LRV',
      'Via Borgonuovo',
      'Maison Senato Capsule',
      'St Moritz',
      '20 Greene NYC',
      'Travel Pack',
    ],
    people: overrides.people || ['Eli', 'Anna', 'Shared'],
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn({ base, dataDir });
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await rm(dataDir, { recursive: true, force: true });
  }
}

function staffCookie(response) {
  const cookies = response.headers.getSetCookie?.() || [];
  const pair = cookies.map((item) => item.split(';')[0]).find((item) => item.startsWith('stocktake='));
  assert.ok(pair, 'expected a staff cookie');
  return pair;
}

async function login(base, pin = PIN) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  return { response, cookie: response.ok ? staffCookie(response) : '' };
}

async function createSession(base, cookie, body) {
  const response = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  return { response, json };
}

function photoForm({ clientId, quantity = 1, sequence = 1, capturedAt = '2026-11-03T10:15:00.000Z', bytes = JPEG } = {}) {
  const body = new FormData();
  body.set('client_id', clientId);
  body.set('captured_at', capturedAt);
  body.set('quantity', String(quantity));
  body.set('sequence', String(sequence));
  body.set('photo', new Blob([bytes], { type: 'image/jpeg' }), 'unit.jpg');
  return body;
}

async function upload(base, cookie, id, fields) {
  const response = await fetch(`${base}/api/sessions/${id}/photos`, {
    method: 'POST',
    headers: { cookie },
    body: photoForm(fields),
  });
  const json = await response.json();
  return { response, json };
}

describe('stock take API', { concurrency: 1 }, () => {
  test('health does not require a PIN', async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
    });
  });

  test('rejects a bad PIN, a missing session cookie, and a bad admin token', async () => {
    await withServer(async ({ base }) => {
      const wrong = await login(base, 'nope');
      assert.equal(wrong.response.status, 401);

      const unauthenticated = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location: '32 LRV', staff: 'Giulia' }),
      });
      assert.equal(unauthenticated.status, 401);

      const { cookie } = await login(base);
      const staffOnAdmin = await fetch(`${base}/api/admin/sessions`, { headers: { cookie } });
      assert.equal(staffOnAdmin.status, 401);

      const missingAdmin = await fetch(`${base}/api/admin/sessions`);
      assert.equal(missingAdmin.status, 401);

      const badAdmin = await fetch(`${base}/api/admin/sessions`, {
        headers: { authorization: 'Bearer not-the-token' },
      });
      assert.equal(badAdmin.status, 401);

      const bearerIsNotStaff = await fetch(`${base}/api/config`, {
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      assert.equal(bearerIsNotStaff.status, 401);
    });
  });

  test('uploads photos, writes the manifest, and downloads a zip', async () => {
    await withServer(async ({ base, dataDir }) => {
      const { cookie } = await login(base);
      const config = await fetch(`${base}/api/config`, { headers: { cookie } });
      assert.equal(config.status, 200);
      const configJson = await config.json();
      assert.ok(configJson.locations.includes('Via Borgonuovo'));

      const created = await createSession(base, cookie, {
        location: 'Via Borgonuovo',
        person: 'Anna',
        staff: 'Giulia',
      });
      assert.equal(created.response.status, 201);
      const session = created.json;
      assert.match(session.id, /^[a-f0-9]{10}$/);
      assert.equal(session.location, 'Via Borgonuovo');
      assert.equal(session.person, 'Anna');
      assert.equal(session.staff, 'Giulia');
      assert.equal(session.processed, false);
      assert.equal(session.ended_at, null);
      assert.match(session.folder, new RegExp(`^${new Date().toISOString().slice(0, 10)}_via-borgonuovo_${session.id}$`));

      const first = await upload(base, cookie, session.id, {
        clientId: 'client-photo-1',
        quantity: 3,
        sequence: 1,
        capturedAt: '2026-11-03T10:15:00.000Z',
      });
      assert.equal(first.response.status, 201);
      assert.equal(first.json.filename, '0001.jpg');
      assert.equal(first.json.quantity, 3);
      assert.equal(first.json.status, 'uploaded');
      assert.equal(first.json.captured_at, '2026-11-03T10:15:00.000Z');

      const replay = await upload(base, cookie, session.id, {
        clientId: 'client-photo-1',
        quantity: 3,
        sequence: 1,
      });
      assert.equal(replay.response.status, 200);
      assert.equal(replay.json.duplicate, true);
      assert.equal(replay.json.filename, '0001.jpg');

      const uploads = await Promise.all(
        [2, 3, 4, 5].map((sequence) => upload(base, cookie, session.id, {
          clientId: `client-photo-${sequence}`,
          quantity: sequence === 2 ? 2 : 1,
          sequence,
          capturedAt: `2026-11-03T10:15:0${sequence}.000Z`,
        })),
      );
      assert.ok(uploads.every((item) => item.response.status === 201));

      const rejected = await upload(base, cookie, session.id, {
        clientId: 'client-photo-bad',
        quantity: 4,
        sequence: 6,
      });
      assert.equal(rejected.response.status, 400);

      const notJpeg = await upload(base, cookie, session.id, {
        clientId: 'client-photo-text',
        quantity: 1,
        sequence: 6,
        bytes: Buffer.from('not a photo'),
      });
      assert.equal(notJpeg.response.status, 400);

      const folder = path.join(dataDir, 'sessions', session.folder);
      const onDisk = JSON.parse(await readFile(path.join(folder, 'session.json'), 'utf8'));
      assert.equal(onDisk.photos.length, 5);
      assert.equal(onDisk.photos[0].filename, '0001.jpg');
      assert.equal(onDisk.photos[0].quantity, 3);
      assert.equal(onDisk.photos[0].status, 'uploaded');
      assert.deepEqual(await readFile(path.join(folder, '0001.jpg')), JPEG);

      const finished = await fetch(`${base}/api/sessions/${session.id}/finish`, {
        method: 'POST',
        headers: { cookie },
      });
      assert.equal(finished.status, 200);
      const finishedJson = await finished.json();
      assert.ok(finishedJson.ended_at);
      assert.equal(finishedJson.photo_count, 5);
      assert.equal(finishedJson.total_quantity, 3 + 2 + 1 + 1 + 1);

      const adminHeaders = { authorization: `Bearer ${ADMIN}` };
      const listed = await fetch(`${base}/api/admin/sessions?processed=false`, { headers: adminHeaders });
      assert.equal(listed.status, 200);
      const listedJson = await listed.json();
      assert.equal(listedJson.sessions.length, 1);
      assert.equal(listedJson.sessions[0].id, session.id);
      assert.equal(listedJson.sessions[0].photo_count, 5);

      const manifest = await fetch(`${base}/api/admin/sessions/${session.id}`, { headers: adminHeaders });
      assert.equal(manifest.status, 200);
      const manifestJson = await manifest.json();
      assert.equal(manifestJson.photos.length, 5);
      assert.equal(manifestJson.photos[0].client_id, 'client-photo-1');

      const photo = await fetch(`${base}/api/admin/sessions/${session.id}/photos/0001.jpg`, { headers: adminHeaders });
      assert.equal(photo.status, 200);
      assert.equal(photo.headers.get('content-type'), 'image/jpeg');
      assert.deepEqual(Buffer.from(await photo.arrayBuffer()), JPEG);

      const missingPhoto = await fetch(`${base}/api/admin/sessions/${session.id}/photos/0009.jpg`, {
        headers: adminHeaders,
      });
      assert.equal(missingPhoto.status, 404);
      const traversal = await fetch(`${base}/api/admin/sessions/${session.id}/photos/..%2F..%2Fpackage.json`, {
        headers: adminHeaders,
      });
      assert.equal(traversal.status, 404);

      const zip = await fetch(`${base}/api/admin/sessions/${session.id}/zip`, { headers: adminHeaders });
      assert.equal(zip.status, 200);
      assert.match(zip.headers.get('content-type'), /zip/);
      const zipDir = await mkdtemp(path.join(os.tmpdir(), 'stocktake-zip-'));
      const zipPath = path.join(zipDir, 'session.zip');
      await writeFile(zipPath, Buffer.from(await zip.arrayBuffer()));
      const { stdout } = await execFileAsync('python3', ['-c', `
import json, zipfile, base64, sys
archive = zipfile.ZipFile(sys.argv[1])
print(json.dumps({
  "names": archive.namelist(),
  "photo": base64.b64encode(archive.read("0001.jpg")).decode(),
  "manifest": archive.read("session.json").decode(),
}))
`, zipPath]);
      const packed = JSON.parse(stdout);
      assert.deepEqual(packed.names.sort(), ['0001.jpg', '0002.jpg', '0003.jpg', '0004.jpg', '0005.jpg', 'session.json']);
      assert.deepEqual(Buffer.from(packed.photo, 'base64'), JPEG);
      const zippedManifest = JSON.parse(packed.manifest);
      assert.equal(zippedManifest.photos.length, 5);
      await rm(zipDir, { recursive: true, force: true });

      const marked = await fetch(`${base}/api/admin/sessions/${session.id}/processed`, {
        method: 'POST',
        headers: { ...adminHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ processed: true }),
      });
      assert.equal(marked.status, 200);
      assert.equal((await marked.json()).processed, true);

      const open = await fetch(`${base}/api/admin/sessions?processed=false`, { headers: adminHeaders });
      assert.deepEqual(await open.json(), { sessions: [] });
      const done = await fetch(`${base}/api/admin/sessions?processed=true`, { headers: adminHeaders });
      const doneJson = await done.json();
      assert.equal(doneJson.sessions.length, 1);
      assert.equal(doneJson.sessions[0].processed, true);

      const unauthenticatedZip = await fetch(`${base}/api/admin/sessions/${session.id}/zip`);
      assert.equal(unauthenticatedZip.status, 401);
    });
  });

  test('rejects an unknown location and a missing name', async () => {
    await withServer(async ({ base }) => {
      const { cookie } = await login(base);
      const badLocation = await createSession(base, cookie, { location: 'Somewhere else', staff: 'Giulia' });
      assert.equal(badLocation.response.status, 400);
      const badName = await createSession(base, cookie, { location: '32 LRV', staff: '   ' });
      assert.equal(badName.response.status, 400);
    });
  });
});
