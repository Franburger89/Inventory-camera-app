import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOCATIONS = [
  '32 LRV',
  'Via Borgonuovo',
  'Maison Senato Capsule',
  'St Moritz',
  '20 Greene NYC',
  'Travel Pack',
];

export const DEFAULT_PEOPLE = ['Eli', 'Anna', 'Shared'];

export function parseList(value, fallback) {
  if (value == null || String(value).trim() === '') return [...fallback];
  const items = String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : [...fallback];
}

// Loads a local .env without overriding variables already set in the environment.
export function loadEnvFile(file = path.resolve('.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function configFromEnv(env = process.env) {
  const staffPin = String(env.STAFF_PIN || '').trim();
  const adminToken = String(env.ADMIN_TOKEN || '').trim();
  const missing = [];
  if (staffPin.length < 4) missing.push('STAFF_PIN (at least 4 characters)');
  if (adminToken.length < 8) missing.push('ADMIN_TOKEN (at least 8 characters)');
  if (missing.length) {
    throw new Error(`Missing required environment: ${missing.join(', ')}`);
  }

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a TCP port between 1 and 65535');
  }

  const dataDir = path.resolve(env.DATA_DIR || env.RAILWAY_VOLUME_MOUNT_PATH || './data');

  return {
    port,
    dataDir,
    staffPin,
    adminToken,
    locations: parseList(env.LOCATIONS, DEFAULT_LOCATIONS),
    people: parseList(env.PEOPLE, DEFAULT_PEOPLE),
  };
}
