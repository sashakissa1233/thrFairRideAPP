// --- SESSION GUARD ---
(function checkDriverAuth() {
  const session = JSON.parse(localStorage.getItem('fairride_session') || 'null');
  if (!session || session.role !== 'driver') {
    window.location.href = '../login.html';
  }
})();

// --- REAL-TIME INTERNET RELAY ---
const pieSocket = new PieSocket.default({
  clusterId: 'demo',
  apiKey: 'VC3mXZalsjhgfpnjvucxR4RydWuDYnxkoG0rLZ5m'
});

let channel;
let map;
let driverMarker = null;
let routeLine = null;
let currentOffer = null;
let watchId = null;

pieSocket.subscribe('fairride_global_channel').then(ch => {
  channel = ch;

  channel.listen('NEW_RIDE_REQUEST', (data) => {
    handleIncomingRequest(data);
  });
});

function driverLogout() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  try {
    localStorage.removeItem('fairride_session');
  } catch (e) {}
  window.location.href = '../login.html';
}

function initDriverMap() {
  const defaultCoords = [40.7128, -74.0060];
  map = L.map('map', { zoomControl: false }).setView(defaultCoords, 13);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  }).addTo(map);

  driverMarker = L.marker(defaultCoords).addTo(map).bindPopup("You (Driver)").openPopup();

  locateDriver();
}

// IP fallback matching Rider logic
async function fallbackToIP() {
  try {
    const res = await fetch('https://ipapi.co/json/');
    const data = await res.json();
    if (data.latitude && data.longitude) {
      updateDriverPosition(data.latitude, data.longitude, 13);
      return;
    }
  } catch (e) {}
}

function updateDriverPosition(lat, lon, zoom = null) {
  const coords = [lat, lon];
  if (driverMarker) {
    driverMarker.setLatLng(coords);
  } else {
    driverMarker = L.marker(coords).addTo(map).bindPopup("You (Driver)").openPopup();
  }
  if (zoom) {
    map.setView(coords, zoom);
  } else {
    map.panTo(coords);
  }
}

function locateDriver() {
  if (!navigator.geolocation) {
    fallbackToIP();
    return;
  }

  // First fetch position immediately with fallback
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      updateDriverPosition(pos.coords.latitude, pos.coords.longitude, 15);
      startLiveTracking();
    },
    () => {
      fallbackToIP();
      startLiveTracking();
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
  );
}

// Continuously update driver location as the car moves
function startLiveTracking() {
  if (!navigator.geolocation) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      updateDriverPosition(pos.coords.latitude, pos.coords.longitude);
    },
    (err) => console.warn('Live tracking update failed:', err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
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

function acceptRide() {
  if (!currentOffer) return;

  const session = JSON.parse(localStorage.getItem('fairride_session') || '{}');
  const dName = session.name ? `${session.name} (Partner)` : 'Driver (Fair Partner)';

  const responsePayload = {
    driverName: dName,
    eta: '5 mins',
    timestamp: Date.now()
  };

  if (channel) {
    channel.publish('RIDE_ACCEPTED', responsePayload);
  }

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
  currentOffer = null;
}

window.onload = function() {
  const session = JSON.parse(localStorage.getItem('fairride_session') || 'null');
  if (session && session.name) {
    document.getElementById('driver-display-name').innerText = session.name;
  }
  initDriverMap();
};
