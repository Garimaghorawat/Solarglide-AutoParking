import os
import csv
import time
import cv2
import requests
import qrcode
import matplotlib.pyplot as plt
from datetime import datetime
from flask import Flask, request, jsonify

# ================= CONFIG =================
API_TOKEN = "f48a7bca893b1c9c95452ac6d3d595716ae0a02e"
API_URL = "https://api.platerecognizer.com/v1/plate-reader/"

UPI_ID = "8017606494@superyes"
RATE_PER_SECOND = 1

CSV_FILE = "parking_log.csv"
TOTAL_SLOTS = 6
BACKEND_API_URL = os.environ.get("BACKEND_API_URL", "http://localhost:3000/api")

ENTRY_CAMERA_INDEX = 1
EXIT_CAMERA_INDEX = 2
# ==========================================

app = Flask(__name__)

slots = {i: False for i in range(1, TOTAL_SLOTS + 1)}
active_sessions = {}

# ---------- CREATE CSV IF NOT EXISTS ----------
if not os.path.exists(CSV_FILE):
    with open(CSV_FILE, mode="w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["Number Plate", "Entry Time", "Exit Time", "Slot", "Duration", "Fee"])

# ---------- LOAD ACTIVE ENTRIES ----------
with open(CSV_FILE, newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        if row["Exit Time"] == "":
            slots[int(row["Slot"])] = True
            active_sessions[row["Number Plate"]] = {
                "entry_time": datetime.strptime(row["Entry Time"], "%Y-%m-%d %H:%M:%S"),
                "slot": int(row["Slot"])
            }

# ---------- CAMERA ----------
def capture_image(camera_index):
    cam = cv2.VideoCapture(camera_index)
    time.sleep(1)
    ret, frame = cam.read()
    if not ret:
        print("❌ Camera error")
        return None

    image_path = f"capture_{camera_index}.jpg"
    cv2.imwrite(image_path, frame)
    cam.release()
    return image_path

# ---------- PLATE RECOGNITION ----------
def recognize_plate(image_path):
    try:
        with open(image_path, "rb") as img:
            response = requests.post(
                API_URL,
                headers={"Authorization": f"Token {API_TOKEN}"},
                files={"upload": img},
                data={"regions": "in"}
            )

        data = response.json()

        if not data.get("results"):
            print("❌ No plate detected")
            return None

        plate = data["results"][0]["plate"].upper()
        confidence = data["results"][0]["score"]

        print(f"Detected Plate: {plate}")
        print(f"Confidence: {confidence:.3f}")

        return plate

    except Exception as e:
        print("API Error:", e)
        return None

# ---------- SLOT ASSIGN ----------
def assign_slot():
    for slot, occupied in slots.items():
        if not occupied:
            slots[slot] = True
            return slot
    return None

# ---------- QR GENERATION ----------
def generate_qr(amount):
    upi_link = f"upi://pay?pa={UPI_ID}&pn=SmartParking&am={amount}&cu=INR"
    qr = qrcode.make(upi_link)
    return qr

def show_qr_temporarily(qr_image, seconds=20):
    plt.figure(figsize=(6,6))
    plt.imshow(qr_image)
    plt.axis("off")
    plt.title(f"Scan to Pay\n₹{RATE_PER_SECOND} per second", fontsize=14)
    plt.show(block=False)
    plt.pause(seconds)
    plt.close()

# ---------- ENTRY LOGIC ----------
def handle_entry_auto():
    print("📸 Capturing ENTRY camera...")
    image = capture_image(ENTRY_CAMERA_INDEX)
    if not image:
        return

    plate = recognize_plate(image)
    if not plate:
        return

    if plate in active_sessions:
        print(f"⚠ Car {plate} already inside.")
        return

    # Check with Node.js backend for pre-booking verification & smart slot allocation
    slot = None
    booking_id = None
    is_prebooked = False

    try:
        res = requests.post(
            f"{BACKEND_API_URL}/anpr/check-entry",
            json={"carNumber": plate},
            timeout=3
        )
        if res.status_code == 200:
            data = res.json()
            if not data.get("validWindow", False):
                print(f"❌ ENTRY DENIED for {plate}: {data.get('message', 'Not allowed to enter')}")
                return

            slot = data.get("slotId")
            is_prebooked = data.get("isPreBooked", False)
            if is_prebooked and data.get("booking"):
                booking_id = data["booking"]["id"]
                print(f"🌟 PRE-BOOKED VEHICLE: {plate} -> Slot {slot} (Booking: {data['booking']['booking_code']})")
            else:
                print(f"🚗 WALK-IN VEHICLE: {plate} -> Allocated Slot {slot}")
        else:
            err_msg = res.json().get("message", "Entry check failed")
            print(f"❌ ENTRY REJECTED BY BACKEND: {err_msg}")
            return
    except Exception as e:
        print(f"⚠️ Backend offline or unreachable ({e}) — SAFE FALLBACK ENGAGED")
        print("⛔ Auto-allocation halted to protect reservations. Please contact parking operator.")
        return

    if slot is None:
        print("❌ Parking Full (all remaining slots reserved or occupied)")
        return

    slot_int = int(slot)
    slots[slot_int] = True
    entry_time = datetime.now()
    active_sessions[plate] = {"entry_time": entry_time, "slot": slot_int}

    with open(CSV_FILE, mode="a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([plate, entry_time.strftime("%Y-%m-%d %H:%M:%S"), "", slot, "", ""])

    # Confirm entry with backend so pre-booking is officially marked checked_in and linked
    try:
        requests.post(
            f"{BACKEND_API_URL}/anpr/confirm-entry",
            json={"carNumber": plate, "slotId": slot, "bookingId": booking_id},
            timeout=3
        )
    except Exception:
        pass  # CSV watcher also links it on file sync

    print(f"✅ ENTRY SUCCESS | Plate: {plate} | Slot: {slot} | Pre-booked: {is_prebooked}")

# ---------- EXIT LOGIC ----------
def handle_exit_auto():
    print("📸 Capturing EXIT camera...")
    image = capture_image(EXIT_CAMERA_INDEX)
    if not image:
        return

    plate = recognize_plate(image)
    if not plate:
        return

    if plate not in active_sessions:
        print("⚠ Plate not found.")
        return

    entry_time = active_sessions[plate]["entry_time"]
    slot = active_sessions[plate]["slot"]
    exit_time = datetime.now()

    duration = int((exit_time - entry_time).total_seconds())
    fee = duration * RATE_PER_SECOND

    # Update CSV
    rows = []
    with open(CSV_FILE, newline="") as f:
        reader = csv.reader(f)
        rows = list(reader)

    for row in rows:
        if row[0] == plate and row[2] == "":
            row[2] = exit_time.strftime("%Y-%m-%d %H:%M:%S")
            row[4] = duration
            row[5] = fee
            break

    with open(CSV_FILE, mode="w", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    slots[slot] = False
    del active_sessions[plate]

    print(f"🚗 EXIT SUCCESS | Plate: {plate}")
    print(f"⏱ Duration: {duration} sec")
    print(f"💰 Fee: ₹{fee}")

    qr_image = generate_qr(fee)
    show_qr_temporarily(qr_image, 30)

# ---------- FLASK ROUTE ----------
@app.route('/trigger', methods=['POST'])
def trigger():
    data = request.get_json()
    trigger_type = data.get("type")

    if trigger_type == "ENTRY":
        print("\n🔔 ENTRY Triggered by ESP")
        handle_entry_auto()

    elif trigger_type == "EXIT":
        print("\n🔔 EXIT Triggered by ESP")
        handle_exit_auto()

    return jsonify({"status": "success"})

# ---------- START SERVER ----------
if __name__ == "__main__":
    print("🚀 Smart Parking Auto System Started")
    print("Waiting for ESP trigger...")
    app.run(host="0.0.0.0", port=5000)