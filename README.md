# Stock take

A phone web app for household staff to photograph medications, supplements, and toiletries during a stock take. One photo is one unit of one item. The app stores the photos and a session manifest. It does not identify products. An assistant downloads a session later, reads the labels, and updates the counts in Notion.

Built for iOS Safari and Android Chrome. No app-store install. Staff can add it to the home screen.

## How a stock take works

1. Staff open the site and choose a location. There is no PIN unless `STAFF_PIN` is set. Person is optional (Eli, Anna, or Shared). Their name is remembered on that phone.
2. **Start stock take** creates a session.
3. Each tap of the shutter takes one photo with the rear camera. If the camera is blocked, **Take photo** uses the phone camera via the file picker. **Upload from camera roll** accepts many photos at once.
4. Photos are resized on the phone (longest side about 1600px, JPEG quality 0.85), saved in IndexedDB, and uploaded in the background. A bad connection does not drop a photo. The screen shows queued, uploaded, and failed counts.
5. **×2 / ×3 / ×5** sets the quantity for the next shutter photo when several identical units are in one shot. The default is 1. Camera-roll photos stay at 1 each.
6. **Finish stock take** closes the session and shows the photo count and total quantity. Uploads already queued keep going.

## Storage

Photos live under `DATA_DIR` (default `./data`, or `RAILWAY_VOLUME_MOUNT_PATH` when that is set and `DATA_DIR` is not):

```
DATA_DIR/sessions/<date>_<location-slug>_<sessionid>/
  0001.jpg
  0002.jpg
  session.json
```

`<date>` is the session start date in UTC (`YYYY-MM-DD`). The location slug is lowercase, with spaces turned into hyphens (`Via Borgonuovo` becomes `via-borgonuovo`).

`session.json`:

```json
{
  "id": "ab12cd34ef",
  "location": "Via Borgonuovo",
  "location_slug": "via-borgonuovo",
  "person": "Anna",
  "staff": "Giulia",
  "started_at": "2026-11-03T10:00:00.000Z",
  "ended_at": "2026-11-03T10:40:00.000Z",
  "processed": false,
  "processed_at": null,
  "folder": "2026-11-03_via-borgonuovo_ab12cd34ef",
  "photos": [
    {
      "filename": "0001.jpg",
      "captured_at": "2026-11-03T10:15:00.000Z",
      "quantity": 1,
      "status": "uploaded",
      "client_id": "6f1c2a48-1b5e-4a1e-9c0d-0a0b0c0d0e0f"
    }
  ]
}
```

`person` is `null` when staff skip it. `client_id` makes retries idempotent so a retried upload does not create a second photo. `processed` stays `false` until the assistant marks the session done.

Default locations: 32 LRV, Via Borgonuovo, Maison Senato Capsule, St Moritz, 20 Greene NYC, Travel Pack.

Default people: Eli, Anna, Shared.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `STAFF_PIN` | no | Leave unset or empty and staff are not asked for a PIN. Set it (at least 4 characters) to require the shared PIN again. |
| `ADMIN_TOKEN` | yes | Bearer token for the admin API. At least 8 characters. Use a long random value (`openssl rand -hex 24`). |
| `DATA_DIR` | yes on Railway | Absolute directory for session folders. Use `/data` and mount the volume there. Locally it defaults to `./data`. |
| `PORT` | set by Railway | HTTP port. Defaults to `3000` when unset. |
| `LOCATIONS` | no | Comma-separated location names. Replaces the default list. Names cannot contain commas. |
| `PEOPLE` | no | Comma-separated people. Replaces Eli, Anna, and Shared. |

Copy `.env.example` to `.env` for local `npm start`. Existing environment variables win over the file. Do not commit `.env`.

The camera needs a secure page. Railway domains are HTTPS. `http://localhost` is also treated as secure by phones on the same machine. A raw `http://` IP address will not open the camera on iOS; the file-picker fallback still works.

## Run locally

```bash
npm install
ADMIN_TOKEN=local-admin-token npm start
```

To require a PIN as well, add `STAFF_PIN=2468` to that command.

Open `http://localhost:3000`.

API tests and the mobile browser test:

```bash
npm test
npx playwright install --with-deps chromium
npm run test:e2e
```

## Docker

The container listens on `PORT`, writes to `DATA_DIR` (default `/data` in the image), and exposes `GET /health`.

```bash
docker build -t stock-take .
docker run --rm -p 3000:3000 \
  -e ADMIN_TOKEN=local-admin-token \
  -e DATA_DIR=/data \
  -v stocktake-data:/data \
  stock-take
```

The image starts as root, gives the `node` user ownership of the data directory, then drops privileges. Keep the default entrypoint. A custom start command that skips it will run as the wrong user and may not be able to write the volume.

`GET /health` returns `{"ok": true}` only when the data directory is writable.

## Deploy on Railway

One service, built from this GitHub repo with the Dockerfile. Photos must sit on a volume. The container disk is wiped on every deploy.

1. In Railway, create a project and choose **Deploy from GitHub repo**. Select this repository. Railway builds `Dockerfile` (`railway.json` also selects the Dockerfile builder and sets the health check to `/health`).
2. Open the service **Variables** and set:
   - `ADMIN_TOKEN` — the assistant's secret. This is always required.
   - `DATA_DIR` — `/data`
   - `LOCATIONS` and `PEOPLE` only if the defaults should change
   - Leave `STAFF_PIN` unset so staff are not asked for a PIN. Set it only if you want that screen back. If it is already set on a deployed service, delete the variable and redeploy.
   - Leave `PORT` unset. Railway injects it.
3. Add a volume and attach it to this service. Set the **mount path** to `/data`, the same value as `DATA_DIR`.
   - From the project canvas: right-click, or open the command palette, choose the volume, then the service, and set the mount path.
   - Railway mounts the volume when the container starts, not during the image build, and mounts it as `root`. The entrypoint hands `/data` to the `node` user before the server starts.
   - If `DATA_DIR` is omitted, the app uses `RAILWAY_VOLUME_MOUNT_PATH` (set automatically by Railway). Set `DATA_DIR=/data` anyway so the path is explicit. A relative `./data` is **not** the volume; inside this image the working directory is `/app`, so `./data` would be ephemeral disk at `/app/data`.
4. Deploy. The release is healthy when `/health` returns 200. If the log says `Missing required environment`, `ADMIN_TOKEN` is missing, or `STAFF_PIN` is set but shorter than 4 characters.
5. In the service **Networking** settings, generate a public domain. Open that HTTPS URL on a phone and use **Add to Home Screen** for the full-screen app.

Redeploys keep the photos only while the volume stays mounted at `DATA_DIR`. Volume backups are available from the volume settings in Railway.

## Admin API

These routes are how the assistant pulls a session. Send `Authorization: Bearer $ADMIN_TOKEN`. The staff PIN cookie is not accepted. Every admin route returns `401` without the token.

```bash
export BASE=https://your-app.up.railway.app
export ADMIN_TOKEN=your-admin-token
```

List sessions. `processed` is optional: `true`, `false`, or omit it for both.

```bash
curl -s "$BASE/api/admin/sessions?processed=false" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Each item includes `id`, `location`, `person`, `staff`, `started_at`, `ended_at`, `processed`, `photo_count`, and `total_quantity`. Photo filenames are not in the list.

Session manifest, including every photo's `filename`, `captured_at`, `quantity`, and `status`:

```bash
curl -s "$BASE/api/admin/sessions/SESSION_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Download the whole session (the JPEGs and `session.json`):

```bash
curl -fL "$BASE/api/admin/sessions/SESSION_ID/zip" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o session.zip
```

Download one photo:

```bash
curl -fL "$BASE/api/admin/sessions/SESSION_ID/photos/0001.jpg" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -o 0001.jpg
```

Mark it processed after the Notion counts are updated. Send `{"processed": false}` to undo that.

```bash
curl -s -X POST "$BASE/api/admin/sessions/SESSION_ID/processed" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"processed": true}'
```

Staff routes (not used by the assistant): `GET /api/me`, `GET /api/config`, `POST /api/sessions`, `POST /api/sessions/:id/photos` (multipart field `photo` plus `client_id`, `captured_at`, `quantity`, `sequence`), and `POST /api/sessions/:id/finish`. With no `STAFF_PIN`, these need no cookie. When `STAFF_PIN` is set, staff first `POST /api/login` with `{"pin":"..."}` and send the cookie. `GET /api/me` returns `{"ok": true, "pinRequired": false}` when the PIN is off.

Suggested assistant loop: list `processed=false`, download each zip, read the labels, update Notion, then mark the session processed.
