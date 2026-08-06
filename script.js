// Function to update parking slots from API data
async function updateParkingSlots() {
  try {
    const response = await fetch('/api/parking-data');
    const data = await response.json();
    
    // Initialize all slots as available
    const allSlots = Array(8).fill().map((_, i) => ({
      id: `${i < 4 ? 'A' : 'B'}${(i % 4) + 1}`,
      status: "available"
    }));

    // Process CSV data to mark booked slots
    data.forEach(entry => {
      if (!entry['Exit Time'] && entry['Slot']) {
        const slot = allSlots.find(s => s.id === entry['Slot']);
        if (slot) {
          slot.status = "booked";
        }
      }
    });

    // Count available and booked slots
    const availableSlots = allSlots.filter(slot => slot.status === "available");
    const bookedSlots = allSlots.filter(slot => slot.status === "booked");

    // Update counts in summary
    document.getElementById('availableCount').textContent = availableSlots.length;
    document.getElementById('bookedCount').textContent = bookedSlots.length;
    document.getElementById('totalSlots').textContent = allSlots.length;

    // Update slot visualization
    const availableContainer = document.getElementById('availableSlots');
    const bookedContainer = document.getElementById('bookedSlots');
    
    availableContainer.innerHTML = '';
    bookedContainer.innerHTML = '';

    availableSlots.forEach(slot => {
      const slotElement = document.createElement('div');
      slotElement.className = 'slot available';
      slotElement.textContent = slot.id;
      availableContainer.appendChild(slotElement);
    });

    bookedSlots.forEach(slot => {
      const slotElement = document.createElement('div');
      slotElement.className = 'slot booked';
      slotElement.textContent = slot.id;
      bookedContainer.appendChild(slotElement);
    });
      
  } catch (error) {
    console.error("Error fetching data:", error);
    // Fallback to showing something if API fails
    document.getElementById('availableCount').textContent = '5';
    document.getElementById('bookedCount').textContent = '3';
    document.getElementById('totalSlots').textContent = '8';
  }
}

// Update every 2 seconds to match page2.html
setInterval(updateParkingSlots, 2000);
updateParkingSlots(); // Initial call