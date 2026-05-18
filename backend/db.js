const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

// Keep the DB in a subdirectory so it can live in its own Docker volume
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'employees.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
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

// Migrate existing installs
try { db.exec(`ALTER TABLE employees ADD COLUMN employee_name TEXT`); } catch {}
try { db.exec(`ALTER TABLE employees ADD COLUMN company TEXT NOT NULL DEFAULT ''`); } catch {}

module.exports = db;
