require('dotenv').config();
console.log('Starting server.js...');
try {
  const express = require('express');
  console.log('express loaded');
  const path = require('path');
  console.log('path loaded');
  const cors = require('cors');
  console.log('cors loaded');
  const database = require('./models/database');
  console.log('database loaded');
  const apiRoutes = require('./routes/api');
  console.log('apiRoutes loaded');

  // Initialize database (creates tables, seeds, imports CSV)
  database.getDb();
  console.log('Database initialized');

  // CSV is the single source of truth — sync it to DB in real-time
  database.startCsvSync();

  // Periodic booking auto-expiry check (runs every 60 seconds)
  setInterval(() => {
    database.expireOverdueBookings();
  }, 60000);

  console.log('Initializing app...');
  const app = express();
  const PORT = process.env.PORT || 3000;

  console.log('Setting up middleware...');
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // API Routes
  app.use('/api', apiRoutes);

  // Fallback
  app.get('*', (req, res) => {
    if (req.accepts('html')) {
      res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });

  app.listen(PORT, () => {
    console.log(`
      🚀 Server running on http://localhost:${PORT}
      - Landing: http://localhost:${PORT}/index.html
      - Dashboard: http://localhost:${PORT}/dashboard.html
      - Admin: http://localhost:${PORT}/admin.html

      📦 Database: parking.db
      🔄 CSV Sync: active (real-time file watch + 5s poll)
      `);
  });
} catch (err) {
  console.error('CRITICAL ERROR:', err);
}