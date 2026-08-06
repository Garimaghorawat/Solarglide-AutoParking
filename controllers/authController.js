const database = require('../models/database');

exports.login = async (req, res) => {
    const { type, identifier, password, email } = req.body;

    if (type === 'admin') {
        const admin = database.findUser(identifier);
        if (admin && admin.role === 'admin' && database.bcrypt.compareSync(password, admin.password)) {
            return res.json({ success: true, role: 'admin', token: 'admin-token' });
        }
        return res.json({ success: false, message: 'Invalid Admin Credentials' });
    }

    else if (type === 'user') {
        const carNumber = identifier;

        // Check if user exists, if not create them
        let user = database.findUserByCar(carNumber);
        if (!user) {
            database.createUser(carNumber, 'user123', email || '', 'user', carNumber);
        }

        // Check if car is currently parked
        const activeSession = database.getActiveSession(carNumber);

        return res.json({
            success: true,
            role: 'user',
            user: { carNumber, email, hasActiveSlot: !!activeSession }
        });
    }

    res.json({ success: false, message: 'Invalid Login Type' });
};
