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
const moment = require('moment');

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

        CREATE TABLE IF NOT EXISTS pre_bookings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            booking_code TEXT UNIQUE NOT NULL,
            car_number TEXT NOT NULL,
            slot_id TEXT NOT NULL,
            start_time TEXT NOT NULL,
            end_time TEXT NOT NULL,
            duration_hours INTEGER NOT NULL,
            estimated_fee REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'confirmed',
            qr_data TEXT,
            session_id INTEGER,
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            FOREIGN KEY (slot_id) REFERENCES slots(id),
            FOREIGN KEY (session_id) REFERENCES parking_sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_pre_bookings_car ON pre_bookings(car_number);
        CREATE INDEX IF NOT EXISTS idx_pre_bookings_status ON pre_bookings(status);
        CREATE INDEX IF NOT EXISTS idx_pre_bookings_slot_window ON pre_bookings(slot_id, start_time, end_time);
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
                        const insertResult = insert.run(
                            row.Name || '',
                            carNumber,
                            row.Slot,
                            entryTime,
                            exitTime,
                            durationMins,
                            fee
                        );
                        newCount++;

                        // Link matching pre-booking if exists
                        try {
                            const newSessionId = insertResult.lastInsertRowid;
                            const preBooking = database.prepare(`
                                SELECT id FROM pre_bookings
                                WHERE car_number = ?
                                  AND status IN ('confirmed', 'checked_in')
                                  AND datetime(start_time, '-45 minutes') <= datetime(?)
                                  AND datetime(end_time, '+60 minutes') >= datetime(?)
                                ORDER BY start_time ASC LIMIT 1
                            `).get(carNumber, entryTime, entryTime);

                            if (preBooking) {
                                database.prepare(`
                                    UPDATE pre_bookings
                                    SET status = 'checked_in', session_id = ?
                                    WHERE id = ?
                                `).run(newSessionId, preBooking.id);
                            }
                        } catch (e) {
                            // Non-blocking
                        }
                    } else {
                        // Existing row — check if exit_time changed
                        const dbExit = existingRow.exit_time || null;
                        if (exitTime && exitTime !== dbExit) {
                            update.run(exitTime, durationMins, fee, existingRow.id);
                            updateCount++;

                            // Complete matching pre-booking if linked
                            try {
                                database.prepare(`
                                    UPDATE pre_bookings
                                    SET status = 'completed'
                                    WHERE session_id = ? AND status = 'checked_in'
                                `).run(existingRow.id);
                            } catch (e) {
                                // Non-blocking
                            }
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
    expireOverdueBookings();

    const slots = database.prepare('SELECT * FROM slots ORDER BY CAST(id AS INTEGER) ASC').all();
    const now = moment().format('YYYY-MM-DD HH:mm:ss');

    return slots.map(slot => {
        if (slot.status === 'booked') {
            return {
                ...slot,
                physical_status: 'occupied',
                is_reserved: false
            };
        }

        // Check if there is an active/imminent confirmed pre-booking (within next 45 minutes or currently active)
        const booking = database.prepare(`
            SELECT booking_code, car_number, start_time, end_time FROM pre_bookings
            WHERE slot_id = ?
              AND status = 'confirmed'
              AND datetime(start_time, '-45 minutes') <= datetime(?)
              AND datetime(end_time) >= datetime(?)
            ORDER BY start_time ASC LIMIT 1
        `).get(slot.id, now, now);

        if (booking) {
            return {
                id: slot.id,
                status: 'reserved',
                physical_status: 'empty',
                is_reserved: true,
                current_car: null,
                current_entry_time: null,
                reserved_car: booking.car_number,
                reserved_start: booking.start_time,
                reserved_end: booking.end_time,
                reserved_booking_code: booking.booking_code
            };
        }

        return {
            ...slot,
            status: 'available',
            physical_status: 'empty',
            is_reserved: false
        };
    });
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

    // Complete linked pre-booking if present
    try {
        database.prepare(`
            UPDATE pre_bookings
            SET status = 'completed'
            WHERE session_id = ? AND status = 'checked_in'
        `).run(id);
    } catch (e) {
        // Non-blocking
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

// ==========================================
// Pre-Booking & Automatic Slot Allocation
// ==========================================

/**
 * Automatically expire bookings where user didn't arrive within 15-minute grace period
 */
function expireOverdueBookings() {
    const database = getDb();
    try {
        const result = database.prepare(`
            UPDATE pre_bookings
            SET status = 'expired'
            WHERE status = 'confirmed'
              AND datetime('now', 'localtime') > datetime(start_time, '+15 minutes')
        `).run();

        if (result.changes > 0) {
            console.log(`⏰ Auto-expired ${result.changes} overdue pre-booking(s) past 15-min grace period`);
        }
        return result.changes;
    } catch (e) {
        console.error('Error in expireOverdueBookings:', e.message);
        return 0;
    }
}

/**
 * Atomically create pre-booking with automatic slot allocation (Slots 1-6)
 */
function createPreBookingAtomic({ carNumber, startTime, endTime, durationHours, estimatedFee }) {
    const database = getDb();

    // Run in a synchronous SQLite transaction (immediate lock prevents race conditions)
    const tx = database.transaction(() => {
        // 1. Expire any overdue bookings first
        expireOverdueBookings();

        // 2. Prevent same vehicle from double booking in overlapping window
        const vehicleConflict = database.prepare(`
            SELECT booking_code, start_time, end_time FROM pre_bookings
            WHERE car_number = ?
              AND status IN ('confirmed', 'checked_in')
              AND datetime(start_time, '-15 minutes') < datetime(?)
              AND datetime(end_time, '+15 minutes') > datetime(?)
            LIMIT 1
        `).get(carNumber, endTime, startTime);

        if (vehicleConflict) {
            return {
                success: false,
                message: `Vehicle ${carNumber} already has active booking ${vehicleConflict.booking_code} (${vehicleConflict.start_time} to ${vehicleConflict.end_time}).`
            };
        }

        // 3. Scan slots 1 to 6 in priority order (1 is closest to gate)
        const slots = database.prepare('SELECT id FROM slots ORDER BY CAST(id AS INTEGER) ASC').all();
        let allocatedSlot = null;

        const now = moment().format('YYYY-MM-DD HH:mm:ss');
        const isImmediate = moment(startTime).diff(moment(now), 'minutes') < 30;

        for (const slot of slots) {
            // Check if slot has conflicting pre-bookings in this window (with 15-min buffer)
            const slotConflict = database.prepare(`
                SELECT id FROM pre_bookings
                WHERE slot_id = ?
                  AND status IN ('confirmed', 'checked_in')
                  AND datetime(start_time, '-15 minutes') < datetime(?)
                  AND datetime(end_time, '+15 minutes') > datetime(?)
                LIMIT 1
            `).get(slot.id, endTime, startTime);

            if (slotConflict) continue;

            // If the booking starts soon (<30 mins from now), check if physically occupied
            if (isImmediate) {
                const physicallyOccupied = database.prepare(`
                    SELECT id FROM parking_sessions
                    WHERE slot_id = ? AND (exit_time IS NULL OR exit_time = '')
                    LIMIT 1
                `).get(slot.id);

                if (physicallyOccupied) continue;
            }

            // Slot is available!
            allocatedSlot = slot.id;
            break;
        }

        if (!allocatedSlot) {
            return {
                success: false,
                message: 'All parking slots are fully booked for the requested time window. Please try another time.'
            };
        }

        // Generate unique 5-digit booking code
        let bookingCode;
        while (true) {
            const rand = Math.floor(10000 + Math.random() * 90000);
            bookingCode = `SG-${rand}`;
            const exists = database.prepare('SELECT id FROM pre_bookings WHERE booking_code = ?').get(bookingCode);
            if (!exists) break;
        }

        const insert = database.prepare(`
            INSERT INTO pre_bookings (booking_code, car_number, slot_id, start_time, end_time, duration_hours, estimated_fee, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')
        `).run(bookingCode, carNumber, allocatedSlot, startTime, endTime, durationHours, estimatedFee);

        const newBooking = database.prepare('SELECT * FROM pre_bookings WHERE id = ?').get(insert.lastInsertRowid);

        return {
            success: true,
            booking: newBooking
        };
    });

    return tx();
}

/**
 * Walk-in slot allocation: assigns a free slot that does NOT have an upcoming booking starting within 60 minutes
 */
function findAvailableSlotForWalkIn(currentTime) {
    const database = getDb();
    expireOverdueBookings();

    const nowStr = currentTime || moment().format('YYYY-MM-DD HH:mm:ss');
    const protectionWindowEnd = moment(nowStr).add(60, 'minutes').format('YYYY-MM-DD HH:mm:ss');

    const slots = database.prepare('SELECT id FROM slots ORDER BY CAST(id AS INTEGER) ASC').all();

    for (const slot of slots) {
        // 1. Must not be currently occupied physically
        const isOccupied = database.prepare(`
            SELECT id FROM parking_sessions
            WHERE slot_id = ? AND (exit_time IS NULL OR exit_time = '')
            LIMIT 1
        `).get(slot.id);

        if (isOccupied) continue;

        // 2. Must not be reserved for a booking starting within the next 60 minutes
        const upcomingReservation = database.prepare(`
            SELECT id FROM pre_bookings
            WHERE slot_id = ?
              AND status = 'confirmed'
              AND datetime(start_time) >= datetime(?)
              AND datetime(start_time) <= datetime(?)
            LIMIT 1
        `).get(slot.id, nowStr, protectionWindowEnd);

        if (upcomingReservation) continue; // protected for pre-booking!

        return slot.id; // Eligible slot found
    }

    return null; // All slots either occupied or reserved
}

/**
 * Check ANPR vehicle entry at barrier
 * Verifies plate AND valid arrival window [start_time - 30m, start_time + 15m]
 */
function checkAnprEntry(carNumber, currentTime) {
    const database = getDb();
    expireOverdueBookings();

    const nowStr = currentTime || moment().format('YYYY-MM-DD HH:mm:ss');

    // 1. Look for confirmed pre-booking for this car
    const booking = database.prepare(`
        SELECT * FROM pre_bookings
        WHERE car_number = ?
          AND status = 'confirmed'
        ORDER BY start_time ASC
        LIMIT 1
    `).get(carNumber);

    if (booking) {
        const start = moment(booking.start_time);
        const now = moment(nowStr);
        const diffMinutes = now.diff(start, 'minutes'); // negative if early, positive if after start

        // Early: arriving more than 30 minutes before scheduled start time
        if (diffMinutes < -30) {
            return {
                isPreBooked: true,
                validWindow: false,
                reason: 'early',
                booking,
                slotId: booking.slot_id,
                message: `Arrival too early for booking ${booking.booking_code}. Scheduled for ${booking.start_time}. Check-in opens at ${start.clone().subtract(30, 'minutes').format('HH:mm')}.`
            };
        }

        // Late: arrived past 15-minute grace period
        if (diffMinutes > 15) {
            // Mark expired
            database.prepare("UPDATE pre_bookings SET status = 'expired' WHERE id = ?").run(booking.id);
            return {
                isPreBooked: true,
                validWindow: false,
                reason: 'expired',
                booking,
                slotId: null,
                message: `Booking ${booking.booking_code} expired. Grace period (15 mins) exceeded.`
            };
        }

        // Within valid arrival window [-30 mins, +15 mins]
        return {
            isPreBooked: true,
            validWindow: true,
            booking,
            slotId: booking.slot_id,
            message: `Welcome! Confirmed booking ${booking.booking_code}. Proceed to assigned Slot ${booking.slot_id}.`
        };
    }

    // 2. No pre-booking found -> Treat as Walk-In vehicle
    const walkInSlot = findAvailableSlotForWalkIn(nowStr);

    if (walkInSlot) {
        return {
            isPreBooked: false,
            validWindow: true,
            slotId: walkInSlot,
            message: `Walk-in entry granted. Allocated Slot ${walkInSlot}.`
        };
    }

    return {
        isPreBooked: false,
        validWindow: false,
        slotId: null,
        message: 'Parking full. All remaining slots are reserved for advance bookings.'
    };
}

/**
 * Link an active session to a pre-booking and mark it checked_in
 */
function confirmPreBookingCheckIn(bookingId, sessionId) {
    const database = getDb();
    database.prepare(`
        UPDATE pre_bookings
        SET status = 'checked_in', session_id = ?
        WHERE id = ?
    `).run(sessionId, bookingId);
}

/**
 * Get user pre-bookings
 */
function getPreBookingsByUser(carNumber) {
    const database = getDb();
    expireOverdueBookings();

    return database.prepare(`
        SELECT * FROM pre_bookings
        WHERE car_number = ?
        ORDER BY start_time DESC
    `).all(carNumber);
}

/**
 * Get pre-booking by code
 */
function getPreBookingByCode(bookingCode) {
    const database = getDb();
    return database.prepare('SELECT * FROM pre_bookings WHERE booking_code = ?').get(bookingCode);
}

/**
 * Get pre-booking by ID
 */
function getPreBookingById(bookingId) {
    const database = getDb();
    return database.prepare('SELECT * FROM pre_bookings WHERE id = ?').get(bookingId);
}

/**
 * Cancel pre-booking by user (strictly validates ownership)
 */
function cancelPreBooking(bookingId, carNumber) {
    const database = getDb();
    expireOverdueBookings();

    const booking = database.prepare(
        'SELECT * FROM pre_bookings WHERE id = ? AND car_number = ?'
    ).get(bookingId, carNumber);

    if (!booking) {
        return { success: false, message: 'Booking not found or not owned by your vehicle' };
    }

    if (booking.status !== 'confirmed') {
        return { success: false, message: `Cannot cancel booking with status: ${booking.status}` };
    }

    database.prepare("UPDATE pre_bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);

    return { success: true, message: `Booking ${booking.booking_code} cancelled successfully` };
}

/**
 * Admin cancel pre-booking
 */
function adminCancelPreBooking(bookingId) {
    const database = getDb();
    const booking = database.prepare('SELECT * FROM pre_bookings WHERE id = ?').get(bookingId);

    if (!booking) {
        return { success: false, message: 'Booking not found' };
    }

    if (booking.status !== 'confirmed') {
        return { success: false, message: `Cannot cancel booking with status: ${booking.status}` };
    }

    database.prepare("UPDATE pre_bookings SET status = 'cancelled' WHERE id = ?").run(bookingId);

    return { success: true, message: `Booking ${booking.booking_code} cancelled by administrator` };
}

/**
 * Get all pre-bookings (for admin)
 */
function getAllPreBookings(filterStatus = 'all') {
    const database = getDb();
    expireOverdueBookings();

    if (filterStatus && filterStatus !== 'all') {
        return database.prepare(
            'SELECT * FROM pre_bookings WHERE status = ? ORDER BY start_time DESC'
        ).all(filterStatus);
    }

    return database.prepare('SELECT * FROM pre_bookings ORDER BY start_time DESC').all();
}

/**
 * Get number of available slots for a given time window
 */
function getSlotAvailabilityCount(startTime, endTime) {
    const database = getDb();
    expireOverdueBookings();

    const slots = database.prepare('SELECT id FROM slots ORDER BY CAST(id AS INTEGER) ASC').all();
    let availableCount = 0;

    const now = moment().format('YYYY-MM-DD HH:mm:ss');
    const isImmediate = moment(startTime).diff(moment(now), 'minutes') < 30;

    for (const slot of slots) {
        const conflict = database.prepare(`
            SELECT id FROM pre_bookings
            WHERE slot_id = ?
              AND status IN ('confirmed', 'checked_in')
              AND datetime(start_time, '-15 minutes') < datetime(?)
              AND datetime(end_time, '+15 minutes') > datetime(?)
            LIMIT 1
        `).get(slot.id, endTime, startTime);

        if (conflict) continue;

        if (isImmediate) {
            const occupied = database.prepare(`
                SELECT id FROM parking_sessions
                WHERE slot_id = ? AND (exit_time IS NULL OR exit_time = '')
                LIMIT 1
            `).get(slot.id);

            if (occupied) continue;
        }

        availableCount++;
    }

    return {
        availableCount,
        totalSlots: slots.length
    };
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
    bcrypt,  // expose for auth controller
    // Pre-Booking
    expireOverdueBookings,
    createPreBookingAtomic,
    findAvailableSlotForWalkIn,
    checkAnprEntry,
    confirmPreBookingCheckIn,
    getPreBookingsByUser,
    getPreBookingByCode,
    getPreBookingById,
    cancelPreBooking,
    adminCancelPreBooking,
    getAllPreBookings,
    getSlotAvailabilityCount
};
