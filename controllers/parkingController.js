const database = require('../models/database');
const moment = require('moment');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const QRCode = require('qrcode');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_placeholder',
    key_secret: process.env.RAZORPAY_KEY_SECRET || 'rzp_secret_placeholder'
});

const HOURLY_RATE = 10;
const BASE_RATE = 20;

// Fetch Real-time Slots from DB
exports.getSlots = async (req, res) => {
    try {
        database.refreshSlotStatus();
        const slots = database.getAllSlots();

        // Format for frontend compatibility
        const formatted = slots.map(slot => ({
            id: slot.id,
            status: slot.status,
            physical_status: slot.physical_status,
            is_reserved: slot.is_reserved,
            entry: slot.current_car ? {
                'Number Plate': slot.current_car,
                'Entry Time': slot.current_entry_time
            } : null,
            reservation: slot.reserved_car ? {
                'Number Plate': slot.reserved_car,
                'Start Time': slot.reserved_start,
                'End Time': slot.reserved_end,
                'Booking Code': slot.reserved_booking_code
            } : null
        }));

        res.json(formatted);
    } catch (err) {
        console.error('Error fetching slots:', err);
        res.status(500).json({ error: 'Failed to fetch slots' });
    }
};

// Get specific user's slot
exports.getMySlot = async (req, res) => {
    const { carNumber } = req.query;
    try {
        const session = database.getActiveSession(carNumber);

        if (session) {
            // Format for frontend compatibility
            res.json({
                success: true,
                slot: {
                    'Number Plate': session.car_number,
                    'Entry Time': session.entry_time,
                    'Slot': session.slot_id
                }
            });
        } else {
            res.json({ success: false, message: 'No active parking found for this car.' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Error fetching user slot' });
    }
};

// Step 1: Calculate fee & create Razorpay order
exports.exitSlot = async (req, res) => {
    const { carNumber, slotId } = req.body;

    try {
        const session = database.getActiveSessionBySlot(carNumber, slotId);

        if (!session) {
            return res.status(400).json({ success: false, message: 'Entry not found or already exited.' });
        }

        const entryTime = moment(session.entry_time);
        const exitTime = moment();
        const duration = moment.duration(exitTime.diff(entryTime));
        const hours = Math.max(1, Math.ceil(duration.asHours()));
        const mins = Math.floor(duration.asMinutes());

        const totalFee = BASE_RATE + (hours * HOURLY_RATE);

        // Create Razorpay Order
        const razorpayOrder = await razorpay.orders.create({
            amount: totalFee * 100,
            currency: 'INR',
            receipt: `parking_${slotId}_${Date.now()}`,
            notes: {
                carNumber,
                slotId,
                hours: hours.toString(),
                entryTime: session.entry_time
            }
        });

        console.log('Razorpay Order created:', razorpayOrder.id);

        // Save payment order in DB
        database.savePaymentOrder({
            orderId: razorpayOrder.id,
            razorpayOrderId: razorpayOrder.id,
            carNumber,
            slotId,
            fee: totalFee,
            hours,
            entryTime: session.entry_time
        });

        res.json({
            success: true,
            orderId: razorpayOrder.id,
            fee: totalFee,
            hours,
            mins,
            sessionId: session.id,
            entryTime: session.entry_time,
            exitTime: exitTime.format('YYYY-MM-DD HH:mm:ss'),
            razorpayKeyId: process.env.RAZORPAY_KEY_ID
        });

    } catch (err) {
        console.error('Exit calc error:', err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// Step 2: Verify Razorpay payment signature & finalize exit
exports.verifyPayment = async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, slotId, carNumber, fee } = req.body;

    try {
        // 1. Verify signature
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + '|' + razorpay_payment_id)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            console.error('Signature mismatch!');
            return res.status(400).json({
                success: false,
                message: 'Payment verification failed — signature mismatch',
                gateOpen: false
            });
        }

        console.log('✅ Razorpay signature verified:', razorpay_payment_id);

        // 2. Update payment status in DB
        database.updatePaymentStatus(razorpay_order_id, razorpay_payment_id, 'paid');

        // 3. Update parking session with exit time + fee
        const session = database.getActiveSessionBySlot(carNumber, slotId);
        if (session) {
            const exitTime = moment();
            const entryTime = moment(session.entry_time);
            const durationMins = Math.floor(moment.duration(exitTime.diff(entryTime)).asMinutes());

            database.updateSessionExit(
                session.id,
                exitTime.format('YYYY-MM-DD HH:mm:ss'),
                durationMins,
                fee
            );
            console.log('📝 Session updated in DB for', carNumber);
        }

        // 4. Record gate event in DB
        const gateEvent = database.addGateEvent(carNumber, slotId, fee, razorpay_payment_id);

        res.json({
            success: true,
            message: 'Payment verified by Razorpay! Gate is now open.',
            gateOpen: true,
            gateEvent
        });

    } catch (err) {
        console.error('Verification error:', err);
        res.status(500).json({ success: false, message: 'Verification error', gateOpen: false });
    }
};

// Legacy endpoints
exports.confirmPayment = async (req, res) => {
    res.json({ success: false, message: 'Please use the Razorpay payment flow' });
};

exports.processPayment = async (req, res) => {
    res.json({ success: false, message: 'Payment is now handled by Razorpay checkout' });
};

// Get gate events
exports.getGateEvents = async (req, res) => {
    const events = database.getGateEvents();
    res.json(events);
};

// Get all logs
exports.getLogs = async (req, res) => {
    try {
        const sessions = database.getAllSessions();

        // Format for frontend compatibility
        const formatted = sessions.map(s => ({
            'Name': s.name,
            'Number Plate': s.car_number,
            'Entry Time': s.entry_time,
            'Exit Time': s.exit_time || '',
            'Slot': s.slot_id,
            'Duration (mins)': s.duration_mins,
            'Fee (INR)': s.fee
        }));

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
};

// ==========================================
// ESP32 Sensor Direct API (no CSV)
// ==========================================

/**
 * POST /api/sensor/entry
 * Body: { carNumber: "RJ14CV0001", slotId: "3" }
 * Called by ESP32 when a car is detected parking in a slot.
 */
exports.sensorEntry = async (req, res) => {
    const { carNumber, slotId } = req.body;

    if (!carNumber || !slotId) {
        return res.status(400).json({ success: false, message: 'carNumber and slotId are required' });
    }

    try {
        // Check if slot is already booked
        const slots = database.getAllSlots();
        const targetSlot = slots.find(s => s.id === String(slotId));

        if (!targetSlot) {
            return res.status(400).json({ success: false, message: `Slot ${slotId} does not exist` });
        }

        if (targetSlot.status === 'booked') {
            return res.status(409).json({ 
                success: false, 
                message: `Slot ${slotId} is already booked by ${targetSlot.current_car}` 
            });
        }

        // Check if this car already has an active session
        const existing = database.getActiveSession(carNumber);
        if (existing) {
            return res.status(409).json({ 
                success: false, 
                message: `Car ${carNumber} already parked in slot ${existing.slot_id}` 
            });
        }

        const entryTime = moment().format('YYYY-MM-DD HH:mm:ss');
        const session = database.createSessionDirect(carNumber, String(slotId), entryTime);

        console.log(`📡 ESP32 Entry: ${carNumber} → Slot ${slotId} at ${entryTime}`);

        res.json({
            success: true,
            message: `Car ${carNumber} parked in slot ${slotId}`,
            session
        });
    } catch (err) {
        console.error('Sensor entry error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * POST /api/sensor/exit
 * Body: { carNumber: "RJ14CV0001", slotId: "3" }
 * Called by ESP32 when a car leaves a slot.
 */
exports.sensorExit = async (req, res) => {
    const { carNumber, slotId } = req.body;

    if (!carNumber || !slotId) {
        return res.status(400).json({ success: false, message: 'carNumber and slotId are required' });
    }

    try {
        const session = database.getActiveSessionBySlot(carNumber, String(slotId));

        if (!session) {
            return res.status(404).json({ 
                success: false, 
                message: `No active session found for ${carNumber} in slot ${slotId}` 
            });
        }

        const exitTime = moment();
        const entryTime = moment(session.entry_time);
        const durationMins = Math.floor(moment.duration(exitTime.diff(entryTime)).asMinutes());
        const hours = Math.max(1, Math.ceil(moment.duration(exitTime.diff(entryTime)).asHours()));
        const fee = BASE_RATE + (hours * HOURLY_RATE);

        database.updateSessionExit(
            session.id,
            exitTime.format('YYYY-MM-DD HH:mm:ss'),
            durationMins,
            fee
        );

        console.log(`📡 ESP32 Exit: ${carNumber} ← Slot ${slotId} | ${durationMins}min | ₹${fee}`);

        res.json({
            success: true,
            message: `Car ${carNumber} exited slot ${slotId}`,
            duration: durationMins,
            fee
        });
    } catch (err) {
        console.error('Sensor exit error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// ==========================================
// Pre-Booking Controller Endpoints
// ==========================================

/**
 * POST /api/pre-booking/create
 * Body: { arrivalDate, arrivalTime, durationHours }
 * (carNumber is extracted securely from req.user or fallback body)
 */
exports.createPreBooking = async (req, res) => {
    try {
        const carNumber = req.user?.carNumber || req.body.carNumber;
        const { arrivalDate, arrivalTime, durationHours } = req.body;

        if (!carNumber) {
            return res.status(400).json({ success: false, message: 'Car number is required' });
        }
        if (!arrivalDate || !arrivalTime || !durationHours) {
            return res.status(400).json({ success: false, message: 'Arrival date, time, and duration are required' });
        }

        const duration = parseInt(durationHours, 10);
        if (isNaN(duration) || duration < 1 || duration > 24) {
            return res.status(400).json({ success: false, message: 'Duration must be between 1 and 24 hours' });
        }

        // Validate datetime format
        const startMoment = moment(`${arrivalDate} ${arrivalTime}`, 'YYYY-MM-DD HH:mm', true);
        if (!startMoment.isValid()) {
            return res.status(400).json({ success: false, message: 'Invalid arrival date or time format' });
        }

        const nowMoment = moment();
        // Must be at least 5 minutes in the future
        if (startMoment.diff(nowMoment, 'minutes') < 5) {
            return res.status(400).json({ success: false, message: 'Arrival time must be at least 5 minutes in the future' });
        }

        // Max horizon: 7 days
        if (startMoment.diff(nowMoment, 'days') > 7) {
            return res.status(400).json({ success: false, message: 'Bookings can only be made up to 7 days in advance' });
        }

        const startTime = startMoment.format('YYYY-MM-DD HH:mm:ss');
        const endTime = startMoment.clone().add(duration, 'hours').format('YYYY-MM-DD HH:mm:ss');
        const estimatedFee = BASE_RATE + (duration * HOURLY_RATE);

        // Atomic allocation in SQLite
        const result = database.createPreBookingAtomic({
            carNumber: carNumber.toUpperCase().trim(),
            startTime,
            endTime,
            durationHours: duration,
            estimatedFee
        });

        if (!result.success) {
            return res.status(409).json({ success: false, message: result.message });
        }

        // Generate QR code data URL
        const qrPayload = JSON.stringify({
            code: result.booking.booking_code,
            plate: result.booking.car_number,
            slot: result.booking.slot_id,
            start: result.booking.start_time,
            end: result.booking.end_time
        });

        let qrDataUrl = '';
        try {
            qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 250, margin: 2 });
            const db = database.getDb();
            db.prepare('UPDATE pre_bookings SET qr_data = ? WHERE id = ?').run(qrDataUrl, result.booking.id);
            result.booking.qr_data = qrDataUrl;
        } catch (qrErr) {
            console.error('QR generation error:', qrErr.message);
        }

        res.json({
            success: true,
            message: `Slot ${result.booking.slot_id} automatically allocated for ${result.booking.booking_code}!`,
            booking: result.booking
        });

    } catch (err) {
        console.error('Pre-booking error:', err);
        res.status(500).json({ success: false, message: 'Server error creating pre-booking' });
    }
};

/**
 * GET /api/pre-booking/my-bookings
 * Query: ?carNumber=... (or from authenticated user token)
 */
exports.getMyPreBookings = async (req, res) => {
    try {
        const carNumber = req.user?.carNumber || req.query.carNumber;

        if (!carNumber) {
            return res.status(400).json({ success: false, message: 'Car number is required' });
        }

        const bookings = database.getPreBookingsByUser(carNumber.toUpperCase().trim());
        res.json({ success: true, bookings });
    } catch (err) {
        console.error('Fetch pre-bookings error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch pre-bookings' });
    }
};

/**
 * POST /api/pre-booking/cancel
 * Body: { bookingId }
 * Strictly validates that the cancelling user owns the booking
 */
exports.cancelPreBooking = async (req, res) => {
    try {
        const { bookingId } = req.body;
        const carNumber = req.user?.carNumber;

        if (!bookingId) {
            return res.status(400).json({ success: false, message: 'Booking ID is required' });
        }
        if (!carNumber) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const result = database.cancelPreBooking(parseInt(bookingId, 10), carNumber);

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);
    } catch (err) {
        console.error('Cancel booking error:', err);
        res.status(500).json({ success: false, message: 'Server error cancelling booking' });
    }
};

/**
 * GET /api/pre-booking/availability
 * Query: ?date=YYYY-MM-DD&time=HH:mm&duration=X
 */
exports.getAvailability = async (req, res) => {
    try {
        const { date, time, duration } = req.query;

        if (!date || !time) {
            return res.status(400).json({ success: false, message: 'Date and time are required' });
        }

        const dur = parseInt(duration || 1, 10);
        const startMoment = moment(`${date} ${time}`, 'YYYY-MM-DD HH:mm', true);

        if (!startMoment.isValid()) {
            return res.status(400).json({ success: false, message: 'Invalid date/time' });
        }

        const startTime = startMoment.format('YYYY-MM-DD HH:mm:ss');
        const endTime = startMoment.clone().add(dur, 'hours').format('YYYY-MM-DD HH:mm:ss');

        const availability = database.getSlotAvailabilityCount(startTime, endTime);

        res.json({
            success: true,
            startTime,
            endTime,
            ...availability
        });
    } catch (err) {
        console.error('Availability error:', err);
        res.status(500).json({ success: false, message: 'Error checking availability' });
    }
};

/**
 * GET /api/pre-booking/admin/all
 * Protected by admin auth
 */
exports.adminGetAllPreBookings = async (req, res) => {
    try {
        const { status } = req.query;
        const bookings = database.getAllPreBookings(status || 'all');
        res.json({ success: true, bookings });
    } catch (err) {
        console.error('Admin get bookings error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch pre-bookings' });
    }
};

/**
 * POST /api/pre-booking/admin/cancel
 * Protected by admin auth
 */
exports.adminCancelPreBooking = async (req, res) => {
    try {
        const { bookingId } = req.body;

        if (!bookingId) {
            return res.status(400).json({ success: false, message: 'Booking ID is required' });
        }

        const result = database.adminCancelPreBooking(parseInt(bookingId, 10));

        if (!result.success) {
            return res.status(400).json(result);
        }

        res.json(result);
    } catch (err) {
        console.error('Admin cancel booking error:', err);
        res.status(500).json({ success: false, message: 'Server error cancelling booking' });
    }
};

/**
 * POST /api/anpr/check-entry
 * Body: { carNumber }
 * Called by ANPR/Python or barrier IoT sensor on arrival
 */
exports.anprCheckEntry = async (req, res) => {
    try {
        const { carNumber } = req.body;

        if (!carNumber) {
            return res.status(400).json({ success: false, message: 'Car number is required' });
        }

        const cleanPlate = carNumber.toUpperCase().trim();
        const result = database.checkAnprEntry(cleanPlate);

        console.log(`📷 ANPR Entry Check: ${cleanPlate} -> isPreBooked=${result.isPreBooked}, slot=${result.slotId}`);

        res.json({
            success: result.validWindow,
            ...result
        });
    } catch (err) {
        console.error('ANPR check error:', err);
        res.status(500).json({ success: false, message: 'Server error during ANPR entry check' });
    }
};

/**
 * POST /api/anpr/confirm-entry
 * Body: { carNumber, slotId, bookingId }
 * Confirms vehicle has passed the barrier and marks booking as checked_in
 */
exports.anprConfirmEntry = async (req, res) => {
    try {
        const { carNumber, slotId, bookingId } = req.body;

        if (!carNumber || !slotId) {
            return res.status(400).json({ success: false, message: 'carNumber and slotId are required' });
        }

        const cleanPlate = carNumber.toUpperCase().trim();
        const entryTime = moment().format('YYYY-MM-DD HH:mm:ss');

        // Check if car already parked
        const existingSession = database.getActiveSession(cleanPlate);
        if (existingSession) {
            return res.status(409).json({ success: false, message: `Vehicle ${cleanPlate} already parked in slot ${existingSession.slot_id}` });
        }

        // Create direct parking session
        const session = database.createSessionDirect(cleanPlate, String(slotId), entryTime);

        // If this entry matches a pre-booking, link and mark checked_in
        if (bookingId) {
            database.confirmPreBookingCheckIn(bookingId, session.id);
            console.log(`✅ Pre-booking ${bookingId} linked to session ${session.id} (checked_in)`);
        } else {
            // Check if there's an active booking to link automatically
            const db = database.getDb();
            const b = db.prepare("SELECT id FROM pre_bookings WHERE car_number = ? AND status = 'confirmed' LIMIT 1").get(cleanPlate);
            if (b) {
                database.confirmPreBookingCheckIn(b.id, session.id);
            }
        }

        res.json({
            success: true,
            message: `Vehicle ${cleanPlate} checked in to Slot ${slotId}`,
            session
        });
    } catch (err) {
        console.error('ANPR confirm error:', err);
        res.status(500).json({ success: false, message: 'Server error confirming entry' });
    }
};

