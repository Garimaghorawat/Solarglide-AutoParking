# SolarGlide - Smart Parking System

An IoT-based Smart Parking System that automates vehicle entry and exit using **ESP8266, Arduino, Automatic Number Plate Recognition (ANPR), QR-based Payment, and a Node.js backend**. The system provides real-time parking slot monitoring, automatic slot allocation, parking fee calculation, and an admin dashboard for efficient parking management.

---

## Features

- 🚗 Automatic Vehicle Entry & Exit Detection
- 📷 Automatic Number Plate Recognition (ANPR)
- 🅿️ Automatic Parking Slot Allocation
- 📊 Real-Time Parking Slot Monitoring
- 👤 User Registration & Login
- 👨‍💼 Admin Dashboard
- 🔐 Role-Based Authentication
- 💳 QR Code-Based Payment
- 💰 Automatic Parking Fee Calculation
- 📁 CSV & SQLite Data Synchronization
- 🔄 REST API using Express.js
- 📱 Responsive User Interface

---

## Tech Stack

### Frontend
- HTML5
- CSS3
- JavaScript

### Backend
- Node.js
- Express.js

### Database
- SQLite
- CSV Storage

### IoT & Hardware
- ESP8266 NodeMCU
- Arduino
- USB Camera

### Python Libraries
- Flask
- OpenCV
- Plate Recognizer API
- QRCode
- Matplotlib

---

## Project Structure

```
SolarGlide-AutoParking
│
├── controllers/
│   ├── authController.js
│   └── parkingController.js
│
├── models/
│   ├── database.js
│   ├── db.js
│   ├── csvService.js
│   └── paymentService.js
│
├── public/
│   ├── css/
│   ├── js/
│   ├── admin.html
│   ├── dashboard.html
│   ├── index.html
│   └── login.html
│
├── routes/
│   └── api.js
│
├── server.js
├── parking.py
├── parking_log.csv
├── package.json
└── README.md
```

---

## Working

1. User registers or logs into the system.
2. ESP8266 triggers the parking process during vehicle entry.
3. The camera captures the vehicle image.
4. Automatic Number Plate Recognition identifies the vehicle number.
5. The system allocates the first available parking slot.
6. Parking information is stored in CSV and synchronized with the SQLite database.
7. The dashboard updates parking slot availability in real time.
8. During exit, parking duration is calculated automatically.
9. Parking fee is generated based on the parking duration.
10. A QR code is generated for seamless digital payment.

---

## Installation

### Clone the Repository

```bash
git clone https://github.com/Garimaghorawat/Solarglide-AutoParking.git
```

### Install Dependencies

```bash
npm install
```

### Start the Node.js Server

```bash
npm start
```

### Run the Python Service

```bash
python parking.py
```

### Open in Browser

```
http://localhost:3000
```

---

## Technologies Used

- ESP8266
- Arduino
- Node.js
- Express.js
- SQLite
- Python
- OpenCV
- Plate Recognizer API
- QRCode
- HTML
- CSS
- JavaScript

---

## Future Enhancements

- Mobile Application Support
- Cloud Database Integration
- AI-Based Parking Prediction
- Online Slot Reservation
- Email & SMS Notifications
- Multi-Level Parking Management

---

## Team

Developed as an academic IoT project for Smart Parking Management.

---

## License

This project is developed for educational and academic purposes.
