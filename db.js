// Simple JSON file database using lowdb
const low    = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path   = require('path');

const file    = path.join(__dirname, 'data.json');
const adapter = new FileSync(file);
const db      = low(adapter);

// seed defaults
db.defaults({ users: [], newsletter: [] }).write();

module.exports = db;