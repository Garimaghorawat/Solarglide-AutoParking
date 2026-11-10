const express = require('express');
const router = express.Router();
const parkingController = require('../controllers/parkingController');
const authController = require('../controllers/authController');

// Auth Routes
router.post('/login', authController.login);

// Parking Routes
router.get('/slots', parkingController.getSlots);
router.get('/my-slot', parkingController.getMySlot);
router.get('/logs', parkingController.getLogs);

// Pre-Booking Routes (User)
router.post('/pre-booking/create', authController.authenticateUser, parkingController.createPreBooking);
router.get('/pre-booking/my-bookings', authController.authenticateUser, parkingController.getMyPreBookings);
router.post('/pre-booking/cancel', authController.authenticateUser, parkingController.cancelPreBooking);
router.get('/pre-booking/availability', parkingController.getAvailability);

// Pre-Booking Routes (Admin)
router.get('/pre-booking/admin/all', authController.authenticateAdmin, parkingController.adminGetAllPreBookings);
router.post('/pre-booking/admin/cancel', authController.authenticateAdmin, parkingController.adminCancelPreBooking);

// ANPR & Gate Integration (Python / IoT)
router.post('/anpr/check-entry', parkingController.anprCheckEntry);
router.post('/anpr/confirm-entry', parkingController.anprConfirmEntry);

// Direct ESP32 Sensor Routes
router.post('/sensor/entry', parkingController.sensorEntry);
router.post('/sensor/exit', parkingController.sensorExit);

// Payment Flow (3-step like Razorpay)
router.post('/exit-calc', parkingController.exitSlot);           // Step 1: Calculate fee & create order
router.post('/process-payment', parkingController.processPayment); // Step 2: Process payment & get signature
router.post('/verify-payment', parkingController.verifyPayment);   // Step 3: Verify signature & open gate

// Gate Monitoring (Admin)
router.get('/gate-events', parkingController.getGateEvents);

// Legacy (redirects to new flow)
router.post('/exit-confirm', parkingController.confirmPayment);

// Data comes from parking_log.csv (synced automatically)

module.exports = router;
