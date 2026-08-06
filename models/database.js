/**
 * SQLite Database — Single source of truth for the web app
 * 
 * Architecture:
 *   Sensors → parking_log.csv → csvSync() → SQLite DB → Web App
 * 
 * The CSV file remains the hardware input.  
 * This module watches it and imports new entries into SQLite.
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');

const DB_PATH = path.join(__dirname, '..', process.env.DB_PATH || 'parking.db');
const CSV_PATH = path.join(__dirname, '..', 'parking_log.csv');

let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL'); // Better concurrent performance
        db.pragma('foreign_keys = ON');
        initTables();
        seedDefaults();
    }
    return db;
}

// ==========================================
// Schema
// ==========================================
function initTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            email TEXT,
            role TEXT NOT NULL DEFAULT 'user',
            car_number TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS slots (
            id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'available',
            current_car TEXT,
            current_entry_time TEXT
        );

        CREATE TABLE IF NOT EXISTS parking_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            car_number TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            entry_time TEXT NOT NULL,
            exit_time TEXT,
            duration_mins REAL,
            fee REAL,
            source TEXT DEFAULT 'sensor',
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (slot_id) REFERENCES slots(id)
        );

        CREATE TABLE IF NOT EXISTS payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id TEXT UNIQUE,
            razorpay_order_id TEXT,
            payment_id TEXT,
            car_number TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT DEFAULT 'INR',
            method TEXT,
            status TEXT DEFAULT 'created',
            signature TEXT,
            entry_time TEXT,
            hours INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS gate_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            car_number TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            fee REAL,
            payment_id TEXT,
            gate_status TEXT DEFAULT 'open',
            timestamp TEXT DEFAULT (datetime('now'))
        );
    `);

    console.log('✅ Database tables initialized');
}

// ==========================================
// Seed Defaults (runs once)
// ==========================================
function seedDefaults() {
    // Seed 6 slots (1-6)
    const slotCount = db.prepare('SELECT COUNT(*) as count FROM slots').get().count;
    if (slotCount === 0) {
        const insert = db.prepare('INSERT INTO slots (id, status) VALUES (?, ?)');
        const slotIds = ['1', '2', '3', '4', '5', '6'];
        const tx = db.transaction(() => {
            slotIds.forEach(id => insert.run(id, 'available'));
        });
        tx();
        console.log('✅ Seeded 6 parking slots');
    }

    // Seed admin user
    const adminExists = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('admin').count;
    if (adminExists === 0) {
        const hashedPass = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run('admin', hashedPass, 'admin');
        console.log('✅ Seeded admin user (admin / admin123)');
    }

    // Import existing CSV data on first run
    const sessionCount = db.prepare('SELECT COUNT(*) as count FROM parking_sessions').get().count;
    if (sessionCount === 0) {
        importCsv();
    }
}

// ==========================================
// Fee Calculation
// ==========================================
const RATE_BASE = 20;   // ₹20 base charge
const RATE_PER_HOUR = 10; // ₹10 per hour
const MIN_CHARGE = 30;   // minimum ₹30

/**
 * Calculate duration (minutes) and fee from entry/exit timestamps.
 * Returns { durationMins, fee } or { durationMins: null, fee: null } if exit is missing.
 */
function calcDurationAndFee(entryTime, exitTime) {
    if (!exitTime) return { durationMins: null, fee: null };

    const entry = new Date(entryTime);
    const exit = new Date(exitTime);
    if (isNaN(entry) || isNaN(exit)) return { durationMins: null, fee: null };

    const durationMins = Math.round((exit - entry) / 60000);
    const hours = Math.ceil(durationMins / 60);
    const fee = Math.max(RATE_BASE + hours * RATE_PER_HOUR, MIN_CHARGE);

    return { durationMins, fee };
}

// ==========================================
// CSV Import & Sync
// ==========================================
function importCsv() {
    if (!fs.existsSync(CSV_PATH)) {
        console.log('No CSV file found, skipping import');
        return;
    }

    const rows = [];
    fs.createReadStream(CSV_PATH)
        .pipe(csv())
        .on('data', (row) => {
            if (row.Slot && row['Number Plate']) {
                rows.push(row);
            }
        })
        .on('end', () => {
            if (rows.length === 0) return;

            const insert = db.prepare(`
                INSERT OR IGNORE INTO parking_sessions 
                (name, car_number, slot_id, entry_time, exit_time, duration_mins, fee, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'csv_import')
            `);

            const tx = db.transaction(() => {
                rows.forEach(row => {
                    const { durationMins, fee } = calcDurationAndFee(row['Entry Time'], row['Exit Time']);
                    insert.run(
                        row.Name || '',
                        row['Number Plate'],
                        row.Slot,
                        row['Entry Time'],
                        row['Exit Time'] || null,
                        durationMins,
                        fee
                    );
                });
            });
            tx();

            console.log(`✅ Imported ${rows.length} entries from CSV`);
            refreshSlotStatus();
        })
        .on('error', (err) => {
            console.error('CSV import error:', err);
        });
}

/**
 * Sync CSV → DB (real-time)
 * Imports NEW rows and UPDATES existing rows (e.g., exit time added).
 * The CSV file is the single source of truth.
 */
function syncCsvToDb() {
    if (!fs.existsSync(CSV_PATH)) return;

    const rows = [];
    fs.createReadStream(CSV_PATH)
        .pipe(csv())
        .on('data', (row) => {
            if (row.Slot && row['Number Plate']) {
                rows.push(row);
            }
        })
        .on('end', () => {
            const database = getDb();

            // Get all existing sessions keyed by car_number|entry_time
            const existing = database.prepare(
                "SELECT id, car_number, entry_time, exit_time, duration_mins, fee FROM parking_sessions"
            ).all();

            const existingMap = new Map(
                existing.map(e => [`${e.car_number}|${e.entry_time}`, e])
            );

            const insert = database.prepare(`
                INSERT INTO parking_sessions 
                (name, car_number, slot_id, entry_time, exit_time, duration_mins, fee, source)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'csv')
            `);

            const update = database.prepare(`
                UPDATE parking_sessions 
                SET exit_time = ?, duration_mins = ?, fee = ?
                WHERE id = ?
            `);

            let newCount = 0;
            let updateCount = 0;

            const tx = database.transaction(() => {
                rows.forEach(row => {
                    const carNumber = row['Number Plate'];
                    const entryTime = row['Entry Time'];
                    const exitTime = row['Exit Time'] || null;
                    const { durationMins, fee } = calcDurationAndFee(entryTime, exitTime);

                    const key = `${carNumber}|${entryTime}`;
                    const existingRow = existingMap.get(key);

                    if (!existingRow) {
                        // New row — insert it
                        insert.run(
                            row.Name || '',
                            carNumber,
                            row.Slot,
                            entryTime,
                            exitTime,
                            durationMins,
                            fee
                        );
                        newCount++;
                    } else {
                        // Existing row — check if exit_time changed
                        const dbExit = existingRow.exit_time || null;
                        if (exitTime && exitTime !== dbExit) {
                            update.run(exitTime, durationMins, fee, existingRow.id);
                            updateCount++;
                        }
                    }
                });
            });
            tx();

            if (newCount > 0 || updateCount > 0) {
                console.log(`🔄 CSV Sync: ${newCount} new, ${updateCount} updated`);
                refreshSlotStatus();
            }
        })
        .on('error', (err) => {
            console.error('CSV sync error:', err);
        });
}

/**
 * Update slot statuses based on active parking sessions
 */
function refreshSlotStatus() {
    const database = getDb();

    // Reset all slots
    database.prepare('UPDATE slots SET status = ?, current_car = NULL, current_entry_time = NULL').run('available');

    // Find active sessions (no exit time)
    const active = database.prepare(
        "SELECT car_number, slot_id, entry_time FROM parking_sessions WHERE exit_time IS NULL OR exit_time = ''"
    ).all();

    const updateSlot = database.prepare(
        'UPDATE slots SET status = ?, current_car = ?, current_entry_time = ? WHERE id = ?'
    );

    active.forEach(session => {
        updateSlot.run('booked', session.car_number, session.entry_time, session.slot_id);
    });
}

// Debounce helper to avoid duplicate syncs from rapid file changes
let syncTimeout = null;
function debouncedSync() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        syncCsvToDb();
        syncTimeout = null;
    }, 500); // Wait 500ms after last change before syncing
}

/**
 * Start real-time CSV sync:
 *  - fs.watch for instant detection when the file changes
 *  - 5s polling as a fallback (in case fs.watch misses events)
 */
function startCsvSync() {
    // Initial sync
    syncCsvToDb();

    // Real-time: watch the CSV file for changes
    if (fs.existsSync(CSV_PATH)) {
        try {
            fs.watch(CSV_PATH, (eventType) => {
                if (eventType === 'change') {
                    debouncedSync();
                }
            });
            console.log('👁️  Watching parking_log.csv for changes');
        } catch (err) {
            console.warn('⚠️  fs.watch not available, using polling only:', err.message);
        }
    }

    // Fallback: poll every 5 seconds
    setInterval(syncCsvToDb, 5000);
    console.log('🔄 CSV sync started (file watch + 5s poll fallback)');
}

// ==========================================
// Query Helpers
// ==========================================

function getAllSlots() {
    const database = getDb();
    return database.prepare('SELECT * FROM slots ORDER BY id').all();
}

function getActiveSession(carNumber) {
    const database = getDb();
    return database.prepare(
        "SELECT * FROM parking_sessions WHERE car_number = ? AND (exit_time IS NULL OR exit_time = '') ORDER BY entry_time DESC LIMIT 1"
    ).get(carNumber);
}

function getActiveSessionBySlot(carNumber, slotId) {
    const database = getDb();
    return database.prepare(
        "SELECT * FROM parking_sessions WHERE car_number = ? AND slot_id = ? AND (exit_time IS NULL OR exit_time = '') LIMIT 1"
    ).get(carNumber, slotId);
}

function updateSessionExit(id, exitTime, durationMins, fee) {
    const database = getDb();
    const result = database.prepare(
        'UPDATE parking_sessions SET exit_time = ?, duration_mins = ?, fee = ? WHERE id = ?'
    ).run(exitTime, durationMins, fee, id);
    console.log(`🔧 updateSessionExit: id=${id}, exitTime=${exitTime}, changes=${result.changes}`);

    // Verify the update persisted
    const check = database.prepare('SELECT id, car_number, slot_id, exit_time FROM parking_sessions WHERE id = ?').get(id);
    console.log('🔧 After update, session:', JSON.stringify(check));

    // Write exit time back to CSV so it stays in sync
    if (check) {
        updateCsvExitTime(check.car_number, check.slot_id, exitTime);
    }

    refreshSlotStatus();

    // Log active sessions count for debugging
    const activeCount = database.prepare("SELECT COUNT(*) as c FROM parking_sessions WHERE exit_time IS NULL OR exit_time = ''").get().c;
    console.log(`🔧 Active sessions remaining: ${activeCount}`);
}

/**
 * Write exit time back to CSV so the file stays in sync with the DB.
 * CSV only has: Number Plate, Entry Time, Exit Time, Slot
 * Duration and fee are calculated, not stored in the CSV.
 */
function updateCsvExitTime(carNumber, slotId, exitTime) {
    try {
        if (!fs.existsSync(CSV_PATH)) return;

        const content = fs.readFileSync(CSV_PATH, 'utf-8');
        const lines = content.split('\n');

        if (lines.length < 2) return;

        const header = lines[0].trim();
        const cols = header.split(',');

        // Find column indices
        const npIdx = cols.findIndex(c => c.trim() === 'Number Plate');
        const exitIdx = cols.findIndex(c => c.trim() === 'Exit Time');

        if (npIdx === -1 || exitIdx === -1) return;

        let updated = false;
        for (let i = 1; i < lines.length; i++) {
            const raw = lines[i].trim();
            if (!raw) continue;

            const fields = raw.split(',');
            // Match by car number AND empty exit time
            if (fields[npIdx]?.trim() === carNumber && (!fields[exitIdx] || fields[exitIdx].trim() === '')) {
                fields[exitIdx] = exitTime;
                lines[i] = fields.join(',');
                updated = true;
                console.log(`📝 CSV updated: exit time written for ${carNumber}`);
                break;
            }
        }

        if (updated) {
            fs.writeFileSync(CSV_PATH, lines.join('\n'), 'utf-8');
        }
    } catch (err) {
        console.error('CSV writeback error:', err.message);
    }
}

/**
 * Create a parking session directly from ESP32 sensor data (no CSV).
 * Returns the new session row.
 */
function createSessionDirect(carNumber, slotId, entryTime) {
    const database = getDb();
    const result = database.prepare(`
        INSERT INTO parking_sessions 
        (name, car_number, slot_id, entry_time, source)
        VALUES ('', ?, ?, ?, 'sensor')
    `).run(carNumber, slotId, entryTime);

    // Mark slot as booked
    database.prepare(
        'UPDATE slots SET status = ?, current_car = ?, current_entry_time = ? WHERE id = ?'
    ).run('booked', carNumber, entryTime, slotId);

    console.log(`📡 Sensor entry: ${carNumber} → slot ${slotId}`);
    return { id: result.lastInsertRowid, carNumber, slotId, entryTime };
}

function getAllSessions() {
    const database = getDb();
    return database.prepare('SELECT * FROM parking_sessions ORDER BY entry_time DESC').all();
}

// Payment helpers
function savePaymentOrder(orderData) {
    const database = getDb();
    database.prepare(`
        INSERT INTO payments (order_id, razorpay_order_id, car_number, slot_id, amount, entry_time, hours, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'created')
    `).run(
        orderData.orderId,
        orderData.razorpayOrderId || orderData.orderId,
        orderData.carNumber,
        orderData.slotId,
        orderData.fee,
        orderData.entryTime,
        orderData.hours
    );
}

function getPaymentByOrderId(orderId) {
    const database = getDb();
    return database.prepare('SELECT * FROM payments WHERE order_id = ? OR razorpay_order_id = ?').get(orderId, orderId);
}

function updatePaymentStatus(orderId, paymentId, status) {
    const database = getDb();
    database.prepare(
        'UPDATE payments SET payment_id = ?, status = ? WHERE order_id = ? OR razorpay_order_id = ?'
    ).run(paymentId, status, orderId, orderId);
}

// Gate event helpers
function addGateEvent(carNumber, slotId, fee, paymentId) {
    const database = getDb();
    database.prepare(`
        INSERT INTO gate_events (car_number, slot_id, fee, payment_id, gate_status, timestamp)
        VALUES (?, ?, ?, ?, 'open', datetime('now'))
    `).run(carNumber, slotId, fee, paymentId);

    const event = database.prepare('SELECT * FROM gate_events ORDER BY id DESC LIMIT 1').get();

    // Auto-close gate after 30 seconds
    setTimeout(() => {
        database.prepare('UPDATE gate_events SET gate_status = ? WHERE id = ?').run('closed', event.id);
    }, 30000);

    return event;
}

function getGateEvents(limit = 50) {
    const database = getDb();
    return database.prepare('SELECT * FROM gate_events ORDER BY id DESC LIMIT ?').all(limit);
}

// User helpers
function findUser(username) {
    const database = getDb();
    return database.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function findUserByCar(carNumber) {
    const database = getDb();
    return database.prepare('SELECT * FROM users WHERE car_number = ?').get(carNumber);
}

function createUser(username, password, email, role, carNumber) {
    const database = getDb();
    const hashedPass = bcrypt.hashSync(password, 10);
    try {
        database.prepare(
            'INSERT INTO users (username, password, email, role, car_number) VALUES (?, ?, ?, ?, ?)'
        ).run(username, hashedPass, email, role, carNumber);
        return true;
    } catch (e) {
        return false; // duplicate username
    }
}

module.exports = {
    getDb,
    startCsvSync,
    refreshSlotStatus,
    calcDurationAndFee,
    // Slots
    getAllSlots,
    // Sessions
    getActiveSession,
    getActiveSessionBySlot,
    updateSessionExit,
    getAllSessions,
    createSessionDirect,
    // Payments
    savePaymentOrder,
    getPaymentByOrderId,
    updatePaymentStatus,
    // Gate Events
    addGateEvent,
    getGateEvents,
    // Users
    findUser,
    findUserByCar,
    createUser,
    bcrypt  // expose for auth controller
};
