// Runbook A1 — production backup.
// Tries mysqldump first; falls back to a pure-JS dump (SHOW CREATE TABLE + INSERTs).
// Run from varsitylax-scraper/:  node db/migrate/a1-backup.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mysql = require('mysql2/promise');

const OUT_DIR = path.join(__dirname, 'backups');
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const OUT_FILE = path.join(OUT_DIR, `varsitylax_preflight_${STAMP}.sql`);

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Attempt mysqldump
  const args = [
    `--host=${process.env.DB_HOST}`, `--port=${process.env.DB_PORT || 3306}`,
    `--user=${process.env.DB_USER}`, '--single-transaction', '--routines',
    '--triggers', '--databases', process.env.DB_NAME,
  ];
  const dump = spawnSync('mysqldump', args, {
    env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD },
    maxBuffer: 1024 * 1024 * 512,
  });
  if (!dump.error && dump.status === 0) {
    fs.writeFileSync(OUT_FILE, dump.stdout);
    return report('mysqldump');
  }
  console.log(`mysqldump unavailable (${dump.error ? dump.error.code : 'exit ' + dump.status}) — using JS dumper`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: parseInt(process.env.DB_PORT || '3306'),
  });
  const out = fs.createWriteStream(OUT_FILE);
  out.write(`-- VarsityLax JS dump ${new Date().toISOString()}\n`);
  out.write(`SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS=0;\n\n`);

  const [tables] = await conn.query('SHOW TABLES');
  const tableNames = tables.map(r => Object.values(r)[0]);
  const counts = {};
  for (const t of tableNames) {
    const [[{ 'Create Table': ddl }]] = await conn.query(`SHOW CREATE TABLE \`${t}\``);
    out.write(`DROP TABLE IF EXISTS \`${t}\`;\n${ddl};\n\n`);
    const [rows] = await conn.query(`SELECT * FROM \`${t}\``);
    counts[t] = rows.length;
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const cols = Object.keys(batch[0]).map(c => `\`${c}\``).join(', ');
      const vals = batch.map(r =>
        '(' + Object.values(r).map(v => conn.escape(v)).join(', ') + ')'
      ).join(',\n');
      out.write(`INSERT INTO \`${t}\` (${cols}) VALUES\n${vals};\n`);
    }
    out.write('\n');
  }
  out.write('SET FOREIGN_KEY_CHECKS=1;\n');
  await new Promise(r => out.end(r));
  await conn.end();
  console.log('Row counts:', JSON.stringify(counts));
  report('JS dumper');
}

function report(method) {
  const size = fs.statSync(OUT_FILE).size;
  const lines = fs.readFileSync(OUT_FILE, 'utf8').split('\n').length;
  console.log(`\nBackup written via ${method}: ${OUT_FILE}`);
  console.log(`Size: ${(size / 1024).toFixed(1)} KB, lines: ${lines}`);
  console.log(size > 50 * 1024 && lines > 500 ? 'A1 size check: GO' : 'A1 size check: REVIEW (expected >50KB / >500 lines)');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
