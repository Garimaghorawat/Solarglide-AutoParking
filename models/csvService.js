const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const moment = require('moment');

const csvPath = path.join(__dirname, '../parking_log.csv');

// Helper to determine status
const getSlotStatus = (entries) => {
    // Map of Slot -> Enry
    const slots = {};
    // Initialize defaults (A1-A4, B1-B4)
    Array(8).fill().forEach((_, i) => {
        const id = `${i < 4 ? 'A' : 'B'}${(i % 4) + 1}`;
        slots[id] = { id, status: 'available', entry: null };
    });

    entries.forEach(entry => {
        if (entry.Slot && slots[entry.Slot]) {
            // If No Exit Time, it's currently occupied
            if (!entry['Exit Time'] || entry['Exit Time'].trim() === '') {
                slots[entry.Slot].status = 'booked';
                slots[entry.Slot].entry = entry;
            }
        }
    });

    return Object.values(slots);
};

exports.readLog = () => {
    return new Promise((resolve, reject) => {
        const results = [];
        // Log reading attempt for debug visibility
        console.log('Reading CSV from:', csvPath);

        fs.createReadStream(csvPath)
            .pipe(csv({ skipLines: 0 }))
            .on('data', (data) => {
                // Intro robust check for empty lines
                if (data.Slot && data['Number Plate']) {
                    results.push(data);
                }
            })
            .on('end', () => {
                console.log(`Parsed ${results.length} valid entries.`);
                resolve(results);
            })
            .on('error', (err) => reject(err));
    });
};

exports.getRealTimeSlots = async () => {
    try {
        const logs = await exports.readLog();
        return getSlotStatus(logs);
    } catch (err) {
        console.error("Error reading CSV:", err);
        return [];
    }
};

exports.findUserSlot = async (carNumber) => {
    const logs = await exports.readLog();
    // Find entry with matching car number AND no exit time
    return logs.find(l =>
        l['Number Plate'] === carNumber &&
        (!l['Exit Time'] || l['Exit Time'].trim() === '')
    );
};

// Write Exit Time back to CSV
exports.updateExit = async (carNumber, slotId, fee, duration, logEntries) => {
    // We need to rewrite the entire CSV file because csv-writer appends or writes new
    // Detailed update logic: Read all -> Modify target row -> Write all back

    // 1. Identify index
    const targetIndex = logEntries.findIndex(l =>
        l['Number Plate'] === carNumber &&
        l['Slot'] === slotId &&
        (!l['Exit Time'] || l['Exit Time'].trim() === '')
    );

    if (targetIndex === -1) return false;

    // 2. Update Row
    logEntries[targetIndex]['Exit Time'] = moment().format('YYYY-MM-DD HH:mm:ss');
    logEntries[targetIndex]['Duration (mins)'] = duration;
    logEntries[targetIndex]['Fee (INR)'] = fee;

    // 3. Rewrite File
    const csvWriter = createCsvWriter({
        path: csvPath,
        header: [
            { id: 'Name', title: 'Name' },
            { id: 'Number Plate', title: 'Number Plate' },
            { id: 'Entry Time', title: 'Entry Time' },
            { id: 'Exit Time', title: 'Exit Time' },
            { id: 'Slot', title: 'Slot' },
            { id: 'Duration (mins)', title: 'Duration (mins)' },
            { id: 'Fee (INR)', title: 'Fee (INR)' }
        ]
    });

    try {
        await csvWriter.writeRecords(logEntries);
        return true;
    } catch (err) {
        console.error("CSV Write Error:", err);
        return false;
    }
};
