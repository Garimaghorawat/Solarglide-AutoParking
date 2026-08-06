const database = require('../models/database');
const moment = require('moment');
const crypto = require('crypto');
const Razorpay = require('razorpay');

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
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
            entry: slot.current_car ? {
                'Number Plate': slot.current_car,
                'Entry Time': slot.current_entry_time
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

