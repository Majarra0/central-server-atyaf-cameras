const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

// Keep the DB in a subdirectory so it can live in its own Docker volume
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'employees.db'));

// Upload-tracking table — only populated when a photo is actually uploaded
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    employee_id TEXT PRIMARY KEY,
    branch      TEXT NOT NULL DEFAULT '',
    company     TEXT NOT NULL DEFAULT ''
  )
`);

// Frappe HR data — populated by sync, used for UI dropdowns only
db.exec(`
  CREATE TABLE IF NOT EXISTS hr_employees (
    employee_id   TEXT PRIMARY KEY,
    employee_name TEXT,
    branch        TEXT NOT NULL DEFAULT '',
    company       TEXT NOT NULL DEFAULT ''
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    name TEXT PRIMARY KEY
  )
`);

db.exec(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)`);

// Migrate existing installs
try { db.exec(`ALTER TABLE employees ADD COLUMN company TEXT NOT NULL DEFAULT ''`); } catch {}

// One-time: clear employees rows that were incorrectly written by sync (not uploads)
if (!db.prepare("SELECT 1 FROM migrations WHERE name = 'clear_sync_employees'").get()) {
  db.exec('DELETE FROM employees');
  db.prepare("INSERT INTO migrations (name) VALUES ('clear_sync_employees')").run();
}

module.exports = db;
