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
