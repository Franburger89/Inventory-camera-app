import { enqueuePhoto, maxSequence, resumeQueue, retryFailed, startQueue, statsFor } from './queue.js';

const ACTIVE_KEY = 'stocktake.active';
const STAFF_KEY = 'stocktake.staff';
const FINISH_KEY = 'stocktake.pendingFinishes';
const PIN_KEY = 'stocktake.pinRequired';
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

const emptyStats = () => ({ captured: 0, quantity: 0, queued: 0, uploaded: 0, failed: 0 });

// Bumps when the user signs in or out, so a slow boot cannot
// overwrite the screen they just opened.
let sessionEpoch = 0;

const state = {
  locations: [],
  people: [],
  location: '',
  person: '',
  session: null,
  quantity: 1,
  nextSequence: 1,
  stats: emptyStats(),
  global: emptyStats(),
  stream: null,
  pinRequired: false,
  cameraState: 'starting',
  torchOn: false,
  torchSupported: false,
  wakeLock: null,
};

const $ = (selector) => document.querySelector(selector);

function readJson(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeActive(session) {
  localStorage.setItem(ACTIVE_KEY, JSON.stringify({
    id: session.id,
    location: session.location,
    person: session.person || null,
    staff: session.staff,
    started_at: session.started_at,
    finished: Boolean(session.finished),
  }));
}

function readActive() {
  const value = readJson(ACTIVE_KEY, null);
  if (!value || !value.id) return null;
  return value;
}

function readFinishes() {
  const value = readJson(FINISH_KEY, []);
  return Array.isArray(value) ? value : [];
}

function writeFinishes(ids) {
  localStorage.setItem(FINISH_KEY, JSON.stringify([...new Set(ids)]));
}

function setPinRequired(required) {
  state.pinRequired = Boolean(required);
  localStorage.setItem(PIN_KEY, state.pinRequired ? '1' : '0');
  $('#sign-out').hidden = !state.pinRequired;
}

function rememberedPinRequired() {
  const value = localStorage.getItem(PIN_KEY);
  if (value === '1') return true;
  if (value === '0') return false;
  return null;
}

function show(view) {
  state.view = view;
  document.body.hidden = false;
  document.body.dataset.screen = view;
  for (const el of document.querySelectorAll('section[data-view]')) {
    el.hidden = el.dataset.view !== view;
  }
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute('content', view === 'capture' ? '#0c0b0a' : '#1b4332');
}

let toastTimer = 0;
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3400);
}

function fittedSize(width, height) {
  const longest = Math.max(width, height);
  if (!longest || longest <= MAX_EDGE) return { width: Math.max(1, width), height: Math.max(1, height) };
  const scale = MAX_EDGE / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not save that photo'));
    }, 'image/jpeg', JPEG_QUALITY);
  });
}

function drawToJpeg(source, width, height) {
  const size = fittedSize(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');
  context.drawImage(source, 0, 0, size.width, size.height);
  return canvasToJpeg(canvas);
}

function grabFrame(video) {
  if (!video.videoWidth || !video.videoHeight) throw new Error('Camera is not ready yet');
  return drawToJpeg(video, video.videoWidth, video.videoHeight);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that photo'));
    };
    image.src = url;
  });
}

async function fileToJpeg(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      let bitmap;
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        bitmap = await createImageBitmap(file);
      }
      try {
        return await drawToJpeg(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close?.();
      }
    } catch {
      // Fall through to an Image element, which decodes HEIC on iOS.
    }
  }
  const image = await loadImage(file);
  return drawToJpeg(image, image.naturalWidth, image.naturalHeight);
}

function timeFromFile(file) {
  const stamp = file.lastModified;
  if (typeof stamp === 'number' && stamp > Date.UTC(2000, 0, 1) && stamp <= Date.now() + 60_000) {
    return new Date(stamp).toISOString();
  }
  return new Date().toISOString();
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function uploadPhoto(job, blob) {
  const body = new FormData();
  body.set('client_id', job.id);
  body.set('captured_at', job.capturedAt);
  body.set('quantity', String(job.quantity));
  body.set('sequence', String(job.sequence));
  body.set('photo', blob, 'photo.jpg');
  let response;
  try {
    response = await fetch(`/api/sessions/${encodeURIComponent(job.sessionId)}/photos`, {
      method: 'POST',
      body,
      credentials: 'same-origin',
    });
  } catch {
    const error = new Error('No connection');
    error.status = 0;
    throw error;
  }
  if (!response.ok) {
    let message = 'Upload failed';
    try {
      const data = await response.json();
      if (data.error) message = data.error;
    } catch {
      // Keep the generic message.
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function flushFinishes() {
  const remaining = [];
  for (const id of readFinishes()) {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/finish`, { method: 'POST' });
      if (!response.ok && response.status !== 404) remaining.push(id);
    } catch {
      remaining.push(id);
    }
  }
  writeFinishes(remaining);
}

async function refreshStats() {
  if (state.session?.id) state.stats = await statsFor(state.session.id);
  else state.stats = emptyStats();
  state.global = await statsFor(null);
  renderStatus();
}

function renderStatus() {
  const stats = state.stats;
  $('#count').textContent = String(stats.captured);
  $('#queued').textContent = String(stats.queued);
  $('#uploaded').textContent = String(stats.uploaded);
  $('#failed').textContent = String(stats.failed);
  $('#retry-button').hidden = stats.failed === 0;
  $('#summary-photos').textContent = String(stats.captured);
  $('#summary-quantity').textContent = String(stats.quantity);
  $('#summary-status').textContent = `${stats.uploaded} uploaded · ${stats.queued} queued · ${stats.failed} failed`;
  $('#summary-retry').hidden = stats.failed === 0;
  const pending = state.global.queued + state.global.failed;
  const banner = $('#pending-banner');
  if (pending > 0 && state.view === 'start') {
    banner.hidden = false;
    banner.textContent = pending === 1
      ? '1 photo is still waiting to upload.'
      : `${pending} photos are still waiting to upload.`;
  } else {
    banner.hidden = true;
  }
  $('#offline').hidden = navigator.onLine;
}

function renderQuantity() {
  for (const button of document.querySelectorAll('[data-quantity]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.quantity) === state.quantity));
  }
}

function renderChoices() {
  const locations = $('#locations');
  locations.replaceChildren();
  for (const location of state.locations) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.dataset.location = location;
    button.textContent = location;
    button.setAttribute('aria-pressed', String(state.location === location));
    button.addEventListener('click', () => {
      state.location = location;
      renderChoices();
      updateStartButton();
    });
    locations.appendChild(button);
  }

  const people = $('#people');
  people.replaceChildren();
  for (const person of state.people) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.dataset.person = person;
    button.textContent = person;
    button.setAttribute('aria-pressed', String(state.person === person));
    button.addEventListener('click', () => {
      state.person = state.person === person ? '' : person;
      renderChoices();
    });
    people.appendChild(button);
  }
}

function canStart() {
  return Boolean(state.location && $('#staff-name').value.trim());
}

function updateStartButton() {
  $('#start-button').disabled = !canStart();
}

function renderResume() {
  const active = readActive();
  const card = $('#resume-card');
  if (!active || active.finished) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const who = [active.person, active.staff].filter(Boolean).join(' · ');
  $('#resume-copy').textContent = who ? `${active.location} — ${who}` : active.location;
}

function renderCaptureHeader() {
  const session = state.session;
  if (!session) return;
  $('#capture-place').textContent = session.location;
  $('#capture-meta').textContent = [session.person, session.staff].filter(Boolean).join(' · ');
  $('#summary-place').textContent = session.location;
  $('#summary-meta').textContent = [session.person, session.staff].filter(Boolean).join(' · ');
}

function renderCamera() {
  const ready = state.cameraState === 'ready';
  $('#camera-starting').hidden = state.cameraState !== 'starting';
  $('#camera-fallback').hidden = state.cameraState !== 'unavailable';
  $('#shutter').hidden = !ready;
  $('#torch-button').hidden = !state.torchSupported;
  $('#torch-button').setAttribute('aria-pressed', String(state.torchOn));
  if (state.cameraState === 'unavailable') {
    $('#camera-message').textContent = state.cameraMessage
      || 'The camera is not available. You can still take a photo or upload from the camera roll.';
  }
}

function stopCamera() {
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  state.stream = null;
  state.cameraState = 'unavailable';
  state.torchSupported = false;
  state.torchOn = false;
  const video = $('#preview');
  if (video) video.srcObject = null;
  if (state.wakeLock) {
    state.wakeLock.release?.().catch(() => {});
    state.wakeLock = null;
  }
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && state.view === 'capture') {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // The screen may still dim. Photos already queued are safe.
  }
}

async function startCamera() {
  stopCamera();
  state.cameraState = 'starting';
  state.cameraMessage = '';
  renderCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    state.cameraState = 'unavailable';
    state.cameraMessage = 'This browser cannot open the camera. Use the buttons below.';
    renderCamera();
    return;
  }
  let stream;
  let timedOut = false;
  const streamPromise = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
  try {
    stream = await Promise.race([
      streamPromise,
      new Promise((_, reject) => {
        setTimeout(() => {
          timedOut = true;
          reject(new Error('timeout'));
        }, 8000);
      }),
    ]);
  } catch {
    if (timedOut) {
      streamPromise.then((late) => {
        for (const track of late.getTracks()) track.stop();
      }).catch(() => {});
    }
    state.cameraState = 'unavailable';
    state.cameraMessage = 'The camera is not available. You can still take a photo or upload from the camera roll.';
    renderCamera();
    return;
  }
  if (state.view !== 'capture') {
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  state.stream = stream;
  const video = $('#preview');
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    state.cameraState = 'unavailable';
    state.cameraMessage = 'The camera is not available. You can still take a photo or upload from the camera roll.';
    stopCamera();
    renderCamera();
    return;
  }
  if (!video.videoWidth && video.readyState < 1) {
    await new Promise((resolve) => {
      const done = () => resolve();
      video.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 3000);
    });
  }
  if (!video.videoWidth) {
    state.cameraState = 'unavailable';
    state.cameraMessage = 'The camera is not available. You can still take a photo or upload from the camera roll.';
    stopCamera();
    renderCamera();
    return;
  }
  state.cameraState = 'ready';
  const track = stream.getVideoTracks()[0];
  state.torchSupported = Boolean(track?.getCapabilities?.().torch);
  renderCamera();
}

let thumbUrl = '';
function showThumb(blob) {
  if (thumbUrl) URL.revokeObjectURL(thumbUrl);
  thumbUrl = URL.createObjectURL(blob);
  const thumb = $('#thumb');
  thumb.src = thumbUrl;
  thumb.hidden = false;
  thumb.classList.remove('pop');
  void thumb.offsetWidth;
  clearTimeout(showThumb.timer);
  showThumb.timer = setTimeout(() => {
    thumb.hidden = true;
  }, 900);
}

function flash() {
  const el = $('#flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

let captureChain = Promise.resolve();

async function acceptPhoto({ blob, capturedAt, quantity, sequence }) {
  if (!state.session) throw new Error('No stock take in progress');
  await enqueuePhoto({
    id: newId(),
    sessionId: state.session.id,
    sequence,
    quantity,
    capturedAt,
  }, blob);
  showThumb(blob);
  await refreshStats();
}

function onShutter() {
  if (state.cameraState !== 'ready' || !state.session) return;
  const video = $('#preview');
  const quantity = state.quantity;
  const capturedAt = new Date().toISOString();
  const sequence = state.nextSequence;
  state.nextSequence += 1;
  state.quantity = 1;
  renderQuantity();
  flash();
  navigator.vibrate?.(12);
  captureChain = captureChain.then(async () => {
    const blob = await grabFrame(video);
    await acceptPhoto({ blob, capturedAt, quantity, sequence });
  }).catch((error) => {
    showToast(error.message || 'That photo did not save. Try again.');
  });
}

async function addFiles(files, { fromCamera }) {
  for (const file of files) {
    const sequence = state.nextSequence;
    state.nextSequence += 1;
    const quantity = fromCamera ? state.quantity : 1;
    if (fromCamera) {
      state.quantity = 1;
      renderQuantity();
    }
    try {
      const blob = await fileToJpeg(file);
      flash();
      await acceptPhoto({
        blob,
        capturedAt: timeFromFile(file),
        quantity,
        sequence,
      });
    } catch (error) {
      showToast(error.message || 'Could not add a photo');
    }
  }
}

async function enterCapture(session) {
  state.session = {
    id: session.id,
    location: session.location,
    person: session.person || null,
    staff: session.staff,
    started_at: session.started_at,
    finished: false,
  };
  writeActive(state.session);
  state.quantity = 1;
  state.cameraState = 'starting';
  state.nextSequence = (await maxSequence(session.id)) + 1;
  renderCamera();
  $('#confirm').hidden = true;
  $('#thumb').hidden = true;
  renderQuantity();
  renderCaptureHeader();
  show('capture');
  await refreshStats();
  await startCamera();
  await keepAwake();
}

async function showStart() {
  stopCamera();
  show('start');
  renderChoices();
  renderResume();
  updateStartButton();
  await refreshStats();
}

async function showSummary(session) {
  state.session = session;
  stopCamera();
  renderCaptureHeader();
  show('summary');
  await refreshStats();
}

async function loadConfig() {
  const response = await fetch('/api/config');
  if (response.status === 401) {
    show('login');
    return false;
  }
  if (!response.ok) throw new Error('Could not load locations');
  const data = await response.json();
  state.locations = data.locations || [];
  state.people = data.people || [];
  if (state.location && !state.locations.includes(state.location)) state.location = '';
  if (state.person && !state.people.includes(state.person)) state.person = '';
  renderChoices();
  return true;
}

async function boot() {
  const epoch = sessionEpoch;
  $('#staff-name').value = localStorage.getItem(STAFF_KEY) || '';
  startQueue({
    upload: uploadPhoto,
    onChange: () => {
      refreshStats().catch(() => {});
      flushFinishes().catch(() => {});
    },
    onAuthRequired: () => {
      if (!state.pinRequired) return;
      sessionEpoch += 1;
      showToast('Sign in again to finish uploading.');
      show('login');
    },
  });
  try {
    const response = await fetch('/api/me');
    if (epoch !== sessionEpoch) return;
    if (response.status === 401) {
      setPinRequired(true);
      show('login');
      $('#pin').focus();
      return;
    }
    if (!response.ok) throw new Error('unreachable');
    const me = await response.json().catch(() => ({}));
    setPinRequired(me.pinRequired === true);
    const ok = await loadConfig();
    if (epoch !== sessionEpoch) return;
    if (ok) await showStart();
  } catch {
    if (epoch !== sessionEpoch) return;
    const active = readActive();
    const pinRequired = rememberedPinRequired();
    if (pinRequired === false) setPinRequired(false);
    if (active && !active.finished) {
      showToast('No connection. Photos stay on this phone.');
      await enterCapture(active);
      return;
    }
    if (active?.finished) {
      showToast('No connection. Uploads will resume when it returns.');
      await showSummary(active);
      return;
    }
    if (pinRequired === false) {
      show('start');
      showToast('No connection yet. Photos you have already taken stay on this phone.');
      return;
    }
    show('login');
    showToast('No connection yet. Sign in when you have a signal.');
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const epoch = ++sessionEpoch;
  $('#login-error').textContent = '';
  const button = $('#login-button');
  button.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: $('#pin').value }),
    });
    if (epoch !== sessionEpoch) return;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      $('#login-error').textContent = data.error || 'Could not sign in';
      return;
    }
    $('#pin').value = '';
    setPinRequired(true);
    resumeQueue();
    const ok = await loadConfig();
    if (epoch !== sessionEpoch) return;
    if (ok) await showStart();
  } catch {
    if (epoch === sessionEpoch) {
      $('#login-error').textContent = 'No connection. Try again when you have a signal.';
    }
  } finally {
    button.disabled = false;
  }
});

$('#pin-toggle').addEventListener('click', () => {
  const input = $('#pin');
  const showPin = input.type === 'password';
  input.type = showPin ? 'text' : 'password';
  $('#pin-toggle').textContent = showPin ? 'Hide' : 'Show';
});

$('#staff-name').addEventListener('input', () => {
  localStorage.setItem(STAFF_KEY, $('#staff-name').value);
  updateStartButton();
});

$('#start-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const staff = $('#staff-name').value.trim();
  localStorage.setItem(STAFF_KEY, staff);
  $('#start-error').textContent = '';
  if (!state.location) {
    $('#start-error').textContent = 'Choose a location';
    return;
  }
  if (!staff) {
    $('#start-error').textContent = 'Enter your name';
    return;
  }
  const button = $('#start-button');
  button.disabled = true;
  try {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location: state.location, person: state.person, staff }),
    });
    if (response.status === 401) {
      show('login');
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      $('#start-error').textContent = data.error || 'Could not start';
      return;
    }
    const previous = readActive();
    if (previous && !previous.finished && previous.id && previous.id !== data.id) {
      writeFinishes([...readFinishes(), previous.id]);
      flushFinishes();
    }
    await enterCapture(data);
  } catch {
    $('#start-error').textContent = 'No connection. Try again when you have a signal.';
  } finally {
    updateStartButton();
  }
});

$('#resume-button').addEventListener('click', async () => {
  const active = readActive();
  if (active) await enterCapture(active);
});

$('#sign-out').addEventListener('click', async () => {
  sessionEpoch += 1;
  stopCamera();
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  show('login');
});

$('#shutter').addEventListener('click', onShutter);
$('#fallback-shutter').addEventListener('click', () => $('#capture-input').click());
$('#roll-button').addEventListener('click', () => $('#roll-input').click());

$('#capture-input').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  await addFiles(files, { fromCamera: true });
});

$('#roll-input').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  await addFiles(files, { fromCamera: false });
});

for (const button of document.querySelectorAll('[data-quantity]')) {
  button.addEventListener('click', () => {
    state.quantity = Number(button.dataset.quantity);
    renderQuantity();
  });
}

$('#torch-button').addEventListener('click', async () => {
  const track = state.stream?.getVideoTracks?.()[0];
  if (!track || !state.torchSupported) return;
  state.torchOn = !state.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: state.torchOn }] });
  } catch {
    state.torchOn = false;
    showToast('The light is not available on this camera.');
  }
  renderCamera();
});

$('#finish-button').addEventListener('click', () => {
  const stats = state.stats;
  const photos = stats.captured === 1 ? '1 photo' : `${stats.captured} photos`;
  const units = stats.quantity === 1 ? '1 unit' : `${stats.quantity} units`;
  $('#confirm-copy').textContent = `${photos}, ${units}. Photos still uploading will keep going.`;
  $('#confirm').hidden = false;
});

$('#confirm-cancel').addEventListener('click', () => {
  $('#confirm').hidden = true;
});

$('#confirm-finish').addEventListener('click', async () => {
  if (!state.session) return;
  $('#confirm').hidden = true;
  const session = { ...state.session, finished: true };
  writeActive(session);
  writeFinishes([...readFinishes(), session.id]);
  await showSummary(session);
  flushFinishes();
});

async function retryCurrent() {
  await retryFailed(state.session?.id || null);
  await refreshStats();
}

$('#retry-button').addEventListener('click', () => {
  retryCurrent().catch(() => showToast('Could not retry yet'));
});
$('#summary-retry').addEventListener('click', () => {
  retryCurrent().catch(() => showToast('Could not retry yet'));
});

$('#another-button').addEventListener('click', async () => {
  localStorage.removeItem(ACTIVE_KEY);
  state.session = null;
  state.location = '';
  state.person = '';
  try {
    await loadConfig();
  } catch {
    // Locations already on screen from the last visit.
  }
  await showStart();
});

window.addEventListener('online', () => {
  renderStatus();
  resumeQueue();
});
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.view === 'capture') keepAwake();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
