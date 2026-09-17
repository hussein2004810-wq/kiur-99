const fs = require('fs');
const py = fs.readFileSync('app/models.py', 'utf8');
const ts = fs.readFileSync('src/db/schema.ts', 'utf8');
const sql = fs.readFileSync('migrations/0000_initial_schema.sql', 'utf8');

const pyTables = [...py.matchAll(/__tablename__\s*=\s*['"]([^'"]+)['"]/g)].map(m => m[1]).sort();
const tsTables = [...ts.matchAll(/sqliteTable\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]).sort();
const sqlTables = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_]+)/gi)].map(m => m[1]).sort();

console.log('Python table count:', pyTables.length);
console.log('TS table count:', tsTables.length);
console.log('SQL DDL table count:', sqlTables.length);

const missingInTs = pyTables.filter(t => !tsTables.includes(t));
const extraInTs = tsTables.filter(t => !pyTables.includes(t));
console.log('Missing in TS:', missingInTs);
console.log('Extra in TS:', extraInTs);

const missingInSql = pyTables.filter(t => !sqlTables.includes(t));
const extraInSql = sqlTables.filter(t => !pyTables.includes(t));
console.log('Missing in SQL:', missingInSql);
console.log('Extra in SQL:', extraInSql);
