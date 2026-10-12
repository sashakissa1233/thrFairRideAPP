// --- SESSION GUARD: Prevent direct URL access without login ---
(function checkDriverAuth() {
  const session = JSON.parse(localStorage.getItem('fairride_session') || 'null');
  if (!session || session.role !== 'driver') {
    window.location.href = '../login.html';
  }
})();

let map;
let driverMarker = null;
let routeLine = null;
let currentOffer = null;

function driverLogout() {
  try {
    localStorage.removeItem('fairride_session');
  } catch (e) {}
  window.location.href = '../login.html';
}

function initDriverMap() {
  const defaultCoords = [40.7128, -74.0060];
  map = L.map('map', { zoomControl: false }).setView(defaultCoords, 12);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  }).addTo(map);

  driverMarker = L.marker(defaultCoords).addTo(map).bindPopup("You (Driver)").openPopup();

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        map.setView([lat, lon], 13);
        driverMarker.setLatLng([lat, lon]);
      },
      () => {},
      { enableHighAccuracy: false, timeout: 5000 }
    );
  }

  checkExistingRequest();
}

function handleIncomingRequest(data) {
  currentOffer = data;

  document.getElementById('waiting-status').style.display = 'none';
  const card = document.getElementById('incoming-request-card');
  card.style.display = 'block';

  document.getElementById('offer-pickup').innerText = data.pickupText;
  document.getElementById('offer-dropoff').innerText = data.dropoffText;
  document.getElementById('offer-payout').innerText = `$${Number(data.fare).toFixed(2)}`;
  document.getElementById('offer-stats').innerText = `${data.stats}`;

  if (data.routeCoords && data.routeCoords.length > 0) {
    if (routeLine) map.removeLayer(routeLine);
    routeLine = L.polyline(data.routeCoords, { color: '#3b82f6', weight: 5 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });
  }
}

// Listen for ride requests broadcast via storage
window.addEventListener('storage', (event) => {
  if (event.key === 'fairride_ride_request' && event.newValue) {
    try {
      const data = JSON.parse(event.newValue);
      if (data.type === 'NEW_RIDE_REQUEST') {
        handleIncomingRequest(data);
      }
    } catch (e) {}
  }
});

function checkExistingRequest() {
  try {
    const raw = localStorage.getItem('fairride_ride_request');
    if (raw) {
      const data = JSON.parse(raw);
      if (data && (Date.now() - data.timestamp < 60000)) {
        handleIncomingRequest(data);
      }
    }
  } catch (e) {}
}

function acceptRide() {
  if (!currentOffer) return;

  const session = JSON.parse(localStorage.getItem('fairride_session') || '{}');
  const dName = session.name ? `${session.name} (Partner)` : 'Driver (Fair Partner)';

  const responsePayload = {
    type: 'RIDE_ACCEPTED',
    driverName: dName,
    eta: '5 mins',
    timestamp: Date.now()
  };

  localStorage.setItem('fairride_driver_response', JSON.stringify(responsePayload));

  document.getElementById('incoming-request-card').innerHTML = `
    <div style="color: #10b981; font-weight: 700; margin-bottom: 6px;">Ride Accepted!</div>
    <div style="font-size: 13px; color: #ddd;">Head to pickup: <strong>${currentOffer.pickupText}</strong></div>
    <div style="font-size: 16px; font-weight: 800; margin-top: 8px; color: #fff;">Payout: $${Number(currentOffer.fare).toFixed(2)} (Direct to you)</div>
    <button class="btn-decline" style="margin-top: 10px;" onclick="declineRide()">Complete Trip</button>
  `;
}

function declineRide() {
  document.getElementById('incoming-request-card').style.display = 'none';
  document.getElementById('waiting-status').style.display = 'block';
  if (routeLine) map.removeLayer(routeLine);
  localStorage.removeItem('fairride_ride_request');
  currentOffer = null;
}

window.onload = function() {
  const session = JSON.parse(localStorage.getItem('fairride_session') || 'null');
  if (session && session.name) {
    document.getElementById('driver-display-name').innerText = session.name;
  }
  initDriverMap();
};