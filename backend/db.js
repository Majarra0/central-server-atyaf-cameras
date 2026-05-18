const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'employees.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    employee_id   TEXT PRIMARY KEY,
    employee_name TEXT,
    branch        TEXT NOT NULL,
    company       TEXT NOT NULL DEFAULT ''
  )
`);

// Migrate existing installs that only have employee_id + branch
try { db.exec(`ALTER TABLE employees ADD COLUMN employee_name TEXT`); } catch {}
try { db.exec(`ALTER TABLE employees ADD COLUMN company TEXT NOT NULL DEFAULT ''`); } catch {}

module.exports = db;
