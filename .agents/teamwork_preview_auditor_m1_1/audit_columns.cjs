const fs = require('fs');

const py = fs.readFileSync('app/models.py', 'utf8');
const ts = fs.readFileSync('src/db/schema.ts', 'utf8');
const sql = fs.readFileSync('migrations/0000_initial_schema.sql', 'utf8');

// Parse Python models
// Classes with __tablename__ = "name"
const pyClasses = py.split(/class\s+(\w+)\(Base\):/);
const pyTableColumns = {};
for (let i = 1; i < pyClasses.length; i += 2) {
  const className = pyClasses[i];
  const body = pyClasses[i+1];
  const tableMatch = body.match(/__tablename__\s*=\s*['"]([^'"]+)['"]/);
  if (!tableMatch) continue;
  const tableName = tableMatch[1];
  const colMatches = [...body.matchAll(/^\s+([a-zA-Z0-9_]+)\s*=\s*Column\(/gm)];
  pyTableColumns[tableName] = colMatches.map(m => m[1]);
}

// Parse TypeScript schema tables
// export const varName = sqliteTable('name', { ... }, (table) => ...);
const tsTableMatches = [...ts.matchAll(/export const (\w+) = sqliteTable\(\s*['"]([^'"]+)['"],\s*\{([\s\S]*?)\n\}(?:\s*,\s*\([\s\S]*?\)\s*=>\s*[\s\S]*?\)\;|\s*\);)/g)];
const tsTableColumns = {};
for (const match of tsTableMatches) {
  const tableName = match[2];
  const body = match[3];
  const colMatches = [...body.matchAll(/^\s+([a-zA-Z0-9_]+):\s*(?:text|integer|real|blob)\(/gm)];
  tsTableColumns[tableName] = colMatches.map(m => m[1]);
}


// Parse SQL CREATE TABLE
const sqlTableMatches = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\n\);/gi)];
const sqlTableColumns = {};
for (const match of sqlTableMatches) {
  const tableName = match[1];
  const body = match[2];
  const lines = body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('--') && !l.startsWith('FOREIGN KEY') && !l.startsWith('PRIMARY KEY') && !l.startsWith('UNIQUE') && !l.startsWith('CHECK'));
  const cols = lines.map(l => l.split(/\s+/)[0].replace(/['"`]/g, ''));
  sqlTableColumns[tableName] = cols;
}

console.log('--- TABLE COLUMN COMPARISON ---');
let allMatch = true;
for (const tableName of Object.keys(pyTableColumns).sort()) {
  const pyCols = pyTableColumns[tableName] || [];
  const tsCols = tsTableColumns[tableName] || [];
  const sqlCols = sqlTableColumns[tableName] || [];

  const missingInTs = pyCols.filter(c => !tsCols.includes(c));
  const extraInTs = tsCols.filter(c => !pyCols.includes(c));

  const missingInSql = pyCols.filter(c => !sqlCols.includes(c));
  const extraInSql = sqlCols.filter(c => !pyCols.includes(c));

  console.log(`Table ${tableName}: Py=${pyCols.length}, TS=${tsCols.length}, SQL=${sqlCols.length}`);
  if (missingInTs.length > 0 || extraInTs.length > 0) {
    allMatch = false;
    console.log(`  [TS Diff] Missing in TS: ${missingInTs.join(', ')} | Extra in TS: ${extraInTs.join(', ')}`);
  }
  if (missingInSql.length > 0 || extraInSql.length > 0) {
    allMatch = false;
    console.log(`  [SQL Diff] Missing in SQL: ${missingInSql.join(', ')} | Extra in SQL: ${extraInSql.join(', ')}`);
  }
}

if (allMatch) {
  console.log('PERFECT MATCH: All columns match 100% across Python, TypeScript schema, and SQL DDL!');
}
