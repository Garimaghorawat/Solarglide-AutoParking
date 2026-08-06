const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '../db.json');

// Initialize DB
function init() {
  if (!fs.existsSync(dbPath)) {
    const defaults = {
      slots: Array(8).fill().map((_, i) => ({
        id: `${i < 4 ? 'A' : 'B'}${(i % 4) + 1}`,
        status: 'available',
        user: null,
        entryTime: null
      })),
      bookings: []
    };
    fs.writeFileSync(dbPath, JSON.stringify(defaults, null, 2));
  }
}

function read() {
  init(); // Ensure exists
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

function write(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

module.exports = { read, write };
