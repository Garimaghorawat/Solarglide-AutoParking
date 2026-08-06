/**
 * Payment Service — Simulated Payment Gateway
 * 
 * Replicates the architecture of Razorpay/Cashfree:
 * 1. Create Order → returns order_id + amount
 * 2. Process Payment → generates payment_id + signature
 * 3. Verify Payment → validates signature cryptographically
 * 
 * To swap with real Razorpay, replace createOrder() and verifyPayment()
 * with Razorpay SDK calls. Everything else stays the same.
 */

const crypto = require('crypto');

// Secret key for signing payments (in production, this would be Razorpay's key_secret)
const PAYMENT_SECRET = 'thynk_parking_secret_key_2026';

// In-memory store for orders and payments
const orders = new Map();
const payments = new Map();
const gateEvents = [];

/**
 * Create a payment order (like Razorpay's orders.create)
 */
function createOrder({ carNumber, slotId, fee, hours, entryTime }) {
    const orderId = 'order_' + crypto.randomBytes(8).toString('hex');

    const order = {
        id: orderId,
        amount: fee * 100, // Store in paise (like Razorpay)
        amountInr: fee,
        currency: 'INR',
        carNumber,
        slotId,
        hours,
        entryTime,
        status: 'created',
        createdAt: new Date().toISOString()
    };

    orders.set(orderId, order);
    return order;
}

/**
 * Simulate processing a payment (called when user "pays" in the checkout)
 * In real Razorpay, this happens on their servers
 */
function processPayment(orderId, paymentMethod) {
    const order = orders.get(orderId);
    if (!order) return { success: false, message: 'Order not found' };
    if (order.status === 'paid') return { success: false, message: 'Order already paid' };

    const paymentId = 'pay_' + crypto.randomBytes(8).toString('hex');

    // Generate signature (HMAC SHA256 — same as Razorpay)
    const signaturePayload = orderId + '|' + paymentId;
    const signature = crypto
        .createHmac('sha256', PAYMENT_SECRET)
        .update(signaturePayload)
        .digest('hex');

    const payment = {
        id: paymentId,
        orderId,
        amount: order.amount,
        amountInr: order.amountInr,
        currency: 'INR',
        method: paymentMethod || 'upi',
        status: 'captured',
        carNumber: order.carNumber,
        slotId: order.slotId,
        signature,
        createdAt: new Date().toISOString()
    };

    payments.set(paymentId, payment);
    order.status = 'paid';
    order.paymentId = paymentId;

    return {
        success: true,
        paymentId,
        orderId,
        signature
    };
}

/**
 * Verify payment signature (same crypto verification as Razorpay)
 * This proves the payment wasn't tampered with
 */
function verifyPayment(orderId, paymentId, receivedSignature) {
    const expectedPayload = orderId + '|' + paymentId;
    const expectedSignature = crypto
        .createHmac('sha256', PAYMENT_SECRET)
        .update(expectedPayload)
        .digest('hex');

    return expectedSignature === receivedSignature;
}

/**
 * Record a gate event
 */
function addGateEvent({ carNumber, slotId, fee, paymentId }) {
    const event = {
        carNumber,
        slotId,
        fee,
        paymentId,
        gateStatus: 'open',
        timestamp: new Date().toISOString()
    };
    gateEvents.unshift(event); // newest first

    // Keep only last 50 events
    if (gateEvents.length > 50) gateEvents.pop();

    // Auto-close gate after 30 seconds
    setTimeout(() => {
        event.gateStatus = 'closed';
    }, 30000);

    return event;
}

/**
 * Get recent gate events for admin panel
 */
function getGateEvents() {
    return gateEvents;
}

/**
 * Get order by ID
 */
function getOrder(orderId) {
    return orders.get(orderId);
}

module.exports = {
    createOrder,
    processPayment,
    verifyPayment,
    addGateEvent,
    getGateEvents,
    getOrder
};
