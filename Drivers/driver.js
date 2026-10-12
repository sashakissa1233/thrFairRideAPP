// --- SESSION GUARD ---
(function checkDriverAuth() {
  const session = JSON.parse(localStorage.getItem('fairride_session') || 'null');
  if (!session || session.role !== 'driver') {
    window.location.href = '../login.html';
  }
})();

// --- PEERJS DIRECT WEBRTC DISPATCH HUB ---
const DRIVER_ROOM_ID = 'fairride-driver-hub-prod-99';
let peer = null;
let currentRiderConn = null;

let map;
let driverMarker = null;
let routeLine = null;
let currentOffer = null;
let watchId = null;

function initDriverPeer() {
  peer = new Peer(DRIVER_ROOM_ID);

  peer.on('open', (id) => {
    console.log('Driver dispatch hub is LIVE. ID:', id);
    const statusEl = document.getElementById('gps-status-text');
    if (statusEl) statusEl.innerText = 'Online • Waiting for rider requests...';
  });

  peer.on('connection', (conn) => {
    currentRiderConn = conn;

    conn.on('data', (data) => {
      if (data && data.type === 'NEW_RIDE_REQUEST') {
        handleIncomingRequest(data);
      }
    });
  });

  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      const statusEl = document.getElementById('gps-status-text');
      if (statusEl) statusEl.innerText = 'Online (Reconnected)';
    } else {
      console.warn('Peer error:', err);
    }
  });
}

function driverLogout() {
  if (watchId) navigator.geolocation.clearWatch(watchId);
  if (peer) peer.destroy();
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

  driverMarker = L.marker(defaultCoords).addTo(map).bindPopup("Driver Location").openPopup();

  setTimeout(() => {
    map.invalidateSize();
    locateDriver();
  }, 200);

  initDriverPeer();
}

function updateDriverPosition(lat, lon, zoom = 14, sourceLabel = "GPS") {
  const coords = [lat, lon];
  if (driverMarker) {
    driverMarker.setLatLng(coords);
    driverMarker.setPopupContent(`Driver (${sourceLabel})`).openPopup();
  } else {
    driverMarker = L.marker(coords).addTo(map).bindPopup(`Driver (${sourceLabel})`).openPopup();
  }

  if (zoom) {
    map.setView(coords, zoom);
  } else {
    map.panTo(coords);
  }
}

async function fallbackToIP() {
  try {
    const res = await fetch('https://ipapi.co/json/');
    const data = await res.json();
    if (data.latitude && data.longitude) {
      updateDriverPosition(data.latitude, data.longitude, 13, "Network/IP");
      return;
    }
  } catch (e) {}

  try {
    const res2 = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client');
    const data2 = await res2.json();
    if (data2.latitude && data2.longitude) {
      updateDriverPosition(data2.latitude, data2.longitude, 13, "Network");
      return;
    }
  } catch (e) {}
}

function locateDriver() {
  const gpsBtn = document.getElementById('driver-gps-btn');
  if (gpsBtn) gpsBtn.innerText = '...';

  if (!navigator.geolocation) {
    fallbackToIP();
    if (gpsBtn) gpsBtn.innerText = 'GPS';
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      updateDriverPosition(pos.coords.latitude, pos.coords.longitude, 15, "Device Sensor");
      if (gpsBtn) gpsBtn.innerText = 'GPS';
      startLiveTracking();
    },
    (err) => {
      console.warn("Device GPS error, switching to IP:", err.message);
      fallbackToIP();
      if (gpsBtn) gpsBtn.innerText = 'GPS';
    },
    { enableHighAccuracy: true, timeout: 6000, maximumAge: 30000 }
  );
}

function startLiveTracking() {
  if (!navigator.geolocation || watchId !== null) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      updateDriverPosition(pos.coords.latitude, pos.coords.longitude, null, "Live Sensor");
    },
    (err) => console.warn('Background tracking update error:', err.message),
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
  if (!currentOffer || !currentRiderConn) return;

  const session = JSON.parse(localStorage.getItem('fairride_session') || '{}');
  const dName = session.name ? `${session.name} (Partner)` : 'Driver (Fair Partner)';

  const responsePayload = {
    type: 'RIDE_ACCEPTED',
    driverName: dName,
    eta: '5 mins',
    timestamp: Date.now()
  };

  currentRiderConn.send(responsePayload);

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
