require('dotenv').config();
const mysql = require('mysql2/promise');

// ─── Connection target resolution ────────────────────────────────────────────
//
// Two rules, both fail-closed:
//
//  1. NO SILENT DEFAULTS. The previous version fell back to
//     localhost/varsitylax/'' when env vars were missing, which meant a typo'd
//     or absent variable produced a *working* connection to the wrong database
//     instead of an error. Missing config is now a startup failure.
//
//  2. STAGING MUST BE EXPLICIT AND DISTINCT. A process started with
//     --target=staging (or DB_TARGET=staging) requires STAGING_DATABASE_URL and
//     refuses to start if that URL resolves to the same host as DB_HOST. The
//     2-hour cron and the API never pass the flag, so they can only ever reach
//     prod.
//
// Every process prints its resolved target on startup — no process writes to a
// database it did not announce.

const target =
  process.argv.includes('--target=staging') || process.env.DB_TARGET === 'staging'
    ? 'staging'
    : 'prod';

function fail(msg) {
  console.error(`[db] FATAL: ${msg}`);
  process.exit(1);
}

function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === '') fail(`${name} is not set (no default is applied)`);
  return v;
}

// mysql://user:pass@host:port/database
function parseUrl(raw, varName) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`${varName} is not a valid URL`);
  }
  if (!u.hostname) fail(`${varName} has no host`);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) fail(`${varName} has no database path segment`);
  return {
    host: u.hostname,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    port: parseInt(u.port || '3306'),
  };
}

let config;

if (target === 'staging') {
  const raw = process.env.STAGING_DATABASE_URL;
  if (!raw) {
    fail('--target=staging requires STAGING_DATABASE_URL to be set. ' +
         'Refusing to fall back to the prod DB_* variables.');
  }
  config = parseUrl(raw, 'STAGING_DATABASE_URL');

  // The guard that matters: staging must not BE prod.
  const prodHost = process.env.DB_HOST;
  if (prodHost && config.host === prodHost) {
    fail(`STAGING_DATABASE_URL host (${config.host}) equals DB_HOST (${prodHost}). ` +
         'This would write staging traffic to production. Refusing to start.');
  }
} else {
  config = {
    host:     requireEnv('DB_HOST'),
    user:     requireEnv('DB_USER'),
    password: requireEnv('DB_PASSWORD'),
    database: requireEnv('DB_NAME'),
    port:     parseInt(process.env.DB_PORT || '3306'),
  };
}

console.log(
  `[db] target=${target.toUpperCase()} host=${config.host} db=${config.database} user=${config.user}`
);

const pool = mysql.createPool({
  ...config,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0,
});

// Exposed so scripts can assert/report their target without re-deriving it.
pool.targetLabel = target;
pool.targetDescription = `${target}:${config.host}/${config.database}`;

module.exports = pool;
