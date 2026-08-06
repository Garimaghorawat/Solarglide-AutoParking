// ====================================
// Thynk Parking — Dashboard JS
// ====================================

const API = '';
let myCarNumber = '';
let currentOrder = null;
let myEntryTimeRaw = null;
let timerInterval = null;

const BASE_RATE = 20;
const HOURLY_RATE = 10;

// ====== Init ======
function init() {
    myCarNumber = localStorage.getItem('carNumber') || '';
    if (!myCarNumber) { window.location.href = 'login.html'; return; }

    document.getElementById('headerCarNum').textContent = myCarNumber;
    document.getElementById('userAvatar').textContent = myCarNumber.charAt(0);

    loadDashboard();
    setInterval(loadDashboard, 5000);
}

// ====== Load Dashboard ======
async function loadDashboard() {
    try {
        const [slots, mySlotRes] = await Promise.all([
            fetch(API + '/api/slots').then(r => r.json()),
            fetch(API + '/api/my-slot?carNumber=' + myCarNumber).then(r => r.json())
        ]);

        renderSlotGrid(slots, mySlotRes);
        renderMySlotBanner(mySlotRes);
        renderStats(slots);
    } catch (err) {
        console.error('Load error:', err);
    }
}

// ====== Render Stats ======
function renderStats(slots) {
    const available = slots.filter(s => s.status === 'available').length;
    const occupied = slots.filter(s => s.status === 'booked').length;

    const totalEl = document.getElementById('totalSlots');
    const availEl = document.getElementById('availableSlots');
    const occEl = document.getElementById('occupiedSlots');

    if (totalEl) totalEl.textContent = slots.length;
    if (availEl) availEl.textContent = available;
    if (occEl) occEl.textContent = occupied;
}

// ====== Duration Helper ======
function calcDurationStr(entryTimeStr) {
    if (!entryTimeStr) return '—';
    const entry = new Date(entryTimeStr);
    if (isNaN(entry.getTime())) return '—';
    const diff = Date.now() - entry.getTime();
    if (diff < 0) return '—';
    const hrs = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    if (hrs > 0) return hrs + 'h ' + mins + 'm';
    return mins + 'm';
}

// ====== Render Slot Grid ======
function renderSlotGrid(slots, mySlot) {
    const grid = document.getElementById('slotGrid');
    const mySlotId = mySlot.success ? mySlot.slot.Slot : null;

    grid.innerHTML = slots.map(slot => {
        const isMine = slot.id === mySlotId;
        const isBooked = slot.status === 'booked';

        let cls = 'slot-card';
        let badgeHtml = '';
        let carNumberHtml = '';
        let entryTimeHtml = '';
        let durationHtml = '';

        if (isMine) {
            cls += ' my-slot';
            badgeHtml = '<span class="slot-badge my-badge">YOURS</span>';
            carNumberHtml = `<div class="slot-car-number">${myCarNumber}</div>`;
            if (mySlot.slot && mySlot.slot['Entry Time']) {
                entryTimeHtml = `<div class="slot-entry-time" style="font-size:0.65rem;color:#666;margin-top:2px;">🕐 ${mySlot.slot['Entry Time']}</div>`;
                durationHtml = `<div class="slot-duration" style="font-size:0.6rem;color:var(--primary);font-weight:600;margin-top:2px;">⏱️ ${calcDurationStr(mySlot.slot['Entry Time'])}</div>`;
            }
        } else if (isBooked) {
            cls += ' booked';
            badgeHtml = '<span class="slot-badge booked-badge">OCCUPIED</span>';
            carNumberHtml = slot.entry ? `<div class="slot-car-number">${slot.entry['Number Plate']}</div>` : '';
            if (slot.entry && slot.entry['Entry Time']) {
                entryTimeHtml = `<div class="slot-entry-time" style="font-size:0.65rem;color:#666;margin-top:2px;">🕐 ${slot.entry['Entry Time']}</div>`;
                durationHtml = `<div class="slot-duration" style="font-size:0.6rem;color:#e67e22;font-weight:600;margin-top:2px;">⏱️ ${calcDurationStr(slot.entry['Entry Time'])}</div>`;
            }
        } else {
            cls += ' available';
            badgeHtml = '<span class="slot-badge available-badge">FREE</span>';
        }

        return `
            <div class="${cls}">
                ${badgeHtml}
                <div class="slot-id">${slot.id}</div>
                <div class="car-icon">${isBooked || isMine ? '🚗' : '🅿️'}</div>
                ${carNumberHtml}
                ${entryTimeHtml}
                ${durationHtml}
            </div>
        `;
    }).join('');
}

// ====== My Slot Banner ======
function renderMySlotBanner(mySlotRes) {
    const banner = document.getElementById('mySlotBanner');
    const emptyState = document.getElementById('emptyState');

    if (mySlotRes.success) {
        const slot = mySlotRes.slot;
        document.getElementById('mySlotVisual').textContent = slot.Slot;
        document.getElementById('myCarNum').textContent = slot['Number Plate'];
        document.getElementById('myEntryTime').textContent = 'Parked since ' + slot['Entry Time'];
        banner.style.display = 'flex';
        emptyState.style.display = 'none';

        // Start live timer
        myEntryTimeRaw = new Date(slot['Entry Time']);
        if (!timerInterval) {
            updateTimer();
            timerInterval = setInterval(updateTimer, 1000);
        }
    } else {
        banner.style.display = 'none';
        emptyState.style.display = 'block';
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }
}

// ====== Live Timer ======
function updateTimer() {
    if (!myEntryTimeRaw || isNaN(myEntryTimeRaw.getTime())) {
        const timerEl = document.getElementById('liveTimer');
        const durationEl = document.getElementById('liveDuration');
        const feeEl = document.getElementById('estimatedFee');
        if (timerEl) timerEl.textContent = '⏱️ —';
        if (durationEl) durationEl.textContent = '—';
        if (feeEl) feeEl.textContent = '—';
        return;
    }

    const now = new Date();
    const diff = Math.max(0, now - myEntryTimeRaw);
    const hours = Math.floor(diff / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);

    const timerEl = document.getElementById('liveTimer');
    const durationEl = document.getElementById('liveDuration');
    const feeEl = document.getElementById('estimatedFee');

    const timeStr = hours + 'h ' + mins + 'm';

    if (timerEl) timerEl.textContent = '⏱️ ' + timeStr;
    if (durationEl) durationEl.textContent = timeStr;

    // Estimated fee
    const chargeHours = Math.max(1, Math.ceil(diff / 3600000));
    const estFee = BASE_RATE + (chargeHours * HOURLY_RATE);
    if (feeEl) feeEl.textContent = '₹' + estFee;
}

// ====== Start Exit Flow ======
async function startExit() {
    const modal = document.getElementById('paymentModal');
    modal.style.display = 'flex';
    setStep(1);

    try {
        const res = await fetch(API + '/api/exit-calc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                carNumber: myCarNumber,
                slotId: document.getElementById('mySlotVisual').textContent
            })
        });

        const data = await res.json();
        if (!data.success) {
            alert(data.message || 'Error calculating fee');
            closeModal();
            return;
        }

        currentOrder = data;

        // Update fee display
        const h = data.hours || 0;
        const m = data.mins || 0;
        document.getElementById('feeDuration').textContent = h + 'h ' + m + 'm';
        document.getElementById('feeHourly').textContent = '₹' + (h * HOURLY_RATE);
        document.getElementById('feeTotal').textContent = '₹' + data.fee;

    } catch (err) {
        console.error('Exit calc error:', err);
        alert('Server error. Please try again.');
        closeModal();
    }
}

// ====== Razorpay Checkout ======
function openRazorpayCheckout() {
    if (!currentOrder) return;

    const options = {
        key: currentOrder.razorpayKeyId,
        amount: currentOrder.fee * 100,
        currency: 'INR',
        name: 'SolarGlide',
        description: 'Parking Fee for Slot ' + document.getElementById('mySlotVisual').textContent,
        order_id: currentOrder.orderId,
        handler: function (response) {
            setStep(2);
            verifyRazorpayPayment(response);
        },
        prefill: {
            contact: '9999999999',
            email: 'test@thynk.com'
        },
        theme: { color: '#00f2ff' },
        modal: {
            ondismiss: function () {
                console.log('Razorpay popup closed');
            }
        }
    };

    const rzp = new Razorpay(options);
    rzp.open();
}

// ====== Verify Payment ======
async function verifyRazorpayPayment(response) {
    try {
        const res = await fetch(API + '/api/verify-payment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
                slotId: document.getElementById('mySlotVisual').textContent,
                carNumber: myCarNumber,
                fee: currentOrder.fee
            })
        });

        const data = await res.json();

        if (data.success && data.gateOpen) {
            setStep(3);
            setTimeout(() => { loadDashboard(); }, 3000);
        } else {
            alert('Payment verification failed: ' + (data.message || 'Unknown error'));
            closeModal();
        }
    } catch (err) {
        console.error('Verify error:', err);
        alert('Verification error');
        closeModal();
    }
}

// ====== Payment Steps ======
function setStep(num) {
    document.querySelectorAll('.payment-step').forEach(el => el.classList.remove('active'));
    document.getElementById('step' + num).classList.add('active');

    ['step1indicator', 'step2indicator', 'step3indicator'].forEach((id, i) => {
        const el = document.getElementById(id);
        el.classList.remove('active', 'completed');
        if (i + 1 < num) el.classList.add('completed');
        else if (i + 1 === num) el.classList.add('active');
    });

    document.getElementById('line1').classList.toggle('active', num >= 2);
    document.getElementById('line2').classList.toggle('active', num >= 3);
}

function closeModal() {
    document.getElementById('paymentModal').style.display = 'none';
    currentOrder = null;
    setStep(1);
}

function logout() {
    localStorage.removeItem('carNumber');
    window.location.href = 'login.html';
}

// Boot
init();
