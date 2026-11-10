'use strict';

const database = require('../models/database');
const crypto   = require('crypto');

// ── Secret ────────────────────────────────────────────────────────────────────
// Fail-fast at startup: refuse to run with a missing or weak secret.
// Generate a suitable value with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// then set AUTH_SECRET in your .env file (minimum 32 characters).
const AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET || AUTH_SECRET.length < 32) {
    throw new Error(
        '[authController] AUTH_SECRET is missing or too short (minimum 32 characters). ' +
        'Set it in your .env file. Do not use a default or hardcoded value.'
    );
}

// ── Token helpers ─────────────────────────────────────────────────────────────

function generateToken(payload) {
    // Embeds an expiry timestamp so tokens are self-expiring (7 days).
    const data = JSON.stringify({ ...payload, exp: Date.now() + 7 * 24 * 3600 * 1000 });
    const b64  = Buffer.from(data).toString('base64url');
    const sig  = crypto.createHmac('sha256', AUTH_SECRET).update(b64).digest('base64url');
    return `${b64}.${sig}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;

    // No hardcoded bypass — every token must pass HMAC-SHA256 verification.
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [b64, sig] = parts;

    // Compute the expected signature
    const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(b64).digest('base64url');

    // Guard against length mismatch before timingSafeEqual:
    // crypto.timingSafeEqual() throws a TypeError if buffer lengths differ.
    // A malformed or truncated token must return null, not crash the server.
    const sigBuf      = Buffer.from(sig,         'base64url');
    const expectedBuf = Buffer.from(expectedSig, 'base64url');
    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    // Decode and validate payload
    try {
        const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf-8'));
        if (!payload.exp || payload.exp < Date.now()) return null; // reject expired tokens
        return payload;
    } catch {
        return null;
    }
}

// ── User auth middleware ───────────────────────────────────────────────────────
// Accepts: Authorization: Bearer <token>  |or|  x-auth-token: <token>
// No query-param tokens, no body/query carNumber fallback, no unauthenticated pass-through.
// ANPR, ESP32 sensor, payment and CSV routes do NOT use this middleware —
// they are intentionally unauthenticated machine-to-machine or IoT endpoints.
exports.authenticateUser = (req, res, next) => {
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7).trim();
    } else if (req.headers['x-auth-token']) {
        token = req.headers['x-auth-token'];
    }
    // No query-param fallback — tokens in URLs appear in server logs and browser history.
    // No body.carNumber fallback — allows arbitrary identity impersonation without credentials.

    const payload = verifyToken(token);

    // Require a valid token that explicitly carries a carNumber and user role.
    if (payload && payload.carNumber && payload.role === 'user') {
        req.user = payload;
        return next();
    }

    return res.status(401).json({ success: false, message: 'Authentication required. Please login.' });
};

// ── Admin auth middleware ──────────────────────────────────────────────────────
// Accepts only: Authorization: Bearer <token>
// Token must carry role === 'admin' with a valid, unexpired HMAC-SHA256 signature.
// No query params, no Basic Auth, no cookie fallback, no raw header token.
exports.authenticateAdmin = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).json({ success: false, message: 'Admin access required. Unauthorized.' });
    }

    const token   = authHeader.substring(7).trim();
    const payload = verifyToken(token);

    if (payload && payload.role === 'admin') {
        req.user = payload;
        return next();
    }

    return res.status(403).json({ success: false, message: 'Admin access required. Unauthorized.' });
};

// ── Login handler ─────────────────────────────────────────────────────────────
// Admin: verifies credentials against the SQLite bcrypt hash, then issues a signed token.
// User: creates a user record on first login, then issues a signed token.
exports.login = async (req, res) => {
    const { type, identifier, password, email } = req.body;

    if (type === 'admin') {
        const admin = database.findUser(identifier);
        if (admin && admin.role === 'admin' && database.bcrypt.compareSync(password, admin.password)) {
            const token = generateToken({ role: 'admin', identifier: admin.username });
            return res.json({ success: true, role: 'admin', token });
        }
        return res.json({ success: false, message: 'Invalid Admin Credentials' });
    }

    if (type === 'user') {
        const carNumber = identifier ? identifier.toUpperCase().trim() : '';
        if (!carNumber) {
            return res.status(400).json({ success: false, message: 'Car number is required' });
        }

        // Create user record on first login if not present
        if (!database.findUserByCar(carNumber)) {
            database.createUser(carNumber, 'user123', email || '', 'user', carNumber);
        }

        const activeSession = database.getActiveSession(carNumber);
        const token = generateToken({ carNumber, role: 'user' });

        return res.json({
            success: true,
            role: 'user',
            token,
            user: { carNumber, email, hasActiveSlot: !!activeSession }
        });
    }

    return res.json({ success: false, message: 'Invalid Login Type' });
};

exports.generateToken = generateToken;
exports.verifyToken   = verifyToken;
