// --- SESSION GUARD: Prevent direct URL access without login ---
(function checkRiderAuth() {
  const session = JSON.parse(localStorage.getItem('fairride_session') || 'null');
  if (!session || session.role !== 'rider') {
    window.location.href = '../login.html';
  }
})();

let map;
let pickupMarker = null;
let dropoffMarker = null;
let routeLine = null;
let debounceTimer;

let pickupCoords = null;
let dropoffCoords = null;
let calculatedFare = 0;
let rawRouteCoords = [];

// Listen for driver acceptance via localStorage event
window.addEventListener('storage', (event) => {
  if (event.key === 'fairride_driver_response' && event.newValue) {
    try {
      const data = JSON.parse(event.newValue);
      if (data.type === 'RIDE_ACCEPTED') {
        const reqBtn = document.getElementById('request-btn');
        reqBtn.style.background = '#3b82f6';
        reqBtn.style.color = '#fff';
        reqBtn.innerText = `Driver Found: ${data.driverName} (ETA ${data.eta})`;
        alert(`A driver accepted your ride!\n\nDriver: ${data.driverName}\nArriving in: ${data.eta}`);
      }
    } catch (e) {}
  }
});

// Toll checkpoints
const TOLL_CHECKPOINTS = [
  {
    name: "Verrazzano Bridge",
    toll: 7.00,
    box: { minLat: 40.598, maxLat: 40.615, minLon: -74.055, maxLon: -74.032 },
    checkDirection: (entryLon, exitLon) => entryLon > exitLon
  },
  {
    name: "GW Bridge",
    toll: 14.75,
    box: { minLat: 40.845, maxLat: 40.858, minLon: -73.965, maxLon: -73.940 },
    checkDirection: (entryLon, exitLon) => entryLon < exitLon
  },
  {
    name: "Lincoln Tunnel",
    toll: 14.75,
    box: { minLat: 40.755, maxLat: 40.770, minLon: -74.025, maxLon: -73.995 },
    checkDirection: (entryLon, exitLon) => entryLon < exitLon
  },
  {
    name: "Holland Tunnel",
    toll: 14.75,
    box: { minLat: 40.720, maxLat: 40.735, minLon: -74.035, maxLon: -74.005 },
    checkDirection: (entryLon, exitLon) => entryLon < exitLon
  },
  {
    name: "Queens Midtown Tunnel",
    toll: 6.94,
    box: { minLat: 40.742, maxLat: 40.752, minLon: -73.972, maxLon: -73.950 },
    checkDirection: () => true
  },
  {
    name: "Hugh L. Carey Tunnel",
    toll: 6.94,
    box: { minLat: 40.695, maxLat: 40.708, minLon: -74.020, maxLon: -74.005 },
    checkDirection: () => true
  },
  {
    name: "RFK Bridge",
    toll: 6.94,
    box: { minLat: 40.772, maxLat: 40.805, minLon: -73.935, maxLon: -73.910 },
    checkDirection: () => true
  }
];

function logout() {
  try {
    localStorage.removeItem('fairride_session');
  } catch (e) {}
  window.location.href = '../login.html';
}

function initMap() {
  if (map) {
    map.invalidateSize();
    return;
  }

  const defaultCoords = [40.7128, -74.0060];
  map = L.map('map', { zoomControl: false }).setView(defaultCoords, 12);

  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri'
  }).addTo(map);

  useCurrentLocation();
}

async function useCurrentLocation() {
  const gpsBtn = document.getElementById('gps-btn');
  if (gpsBtn) gpsBtn.innerText = '...';

  const applyCoordinates = async (lat, lon, label = null) => {
    pickupCoords = [lat, lon];

    if (!pickupMarker) {
      pickupMarker = L.marker([lat, lon]).addTo(map);
    } else {
      pickupMarker.setLatLng([lat, lon]);
    }
    map.setView([lat, lon], 14);

    if (label) {
      document.getElementById('pickup-input').value = label;
      pickupMarker.bindPopup(`Pickup: ${label}`).openPopup();
    } else {
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}`);
        const data = await res.json();
        const addressParts = data.display_name.split(',').slice(0, 3).join(',');
        document.getElementById('pickup-input').value = addressParts;
        pickupMarker.bindPopup(`Pickup: ${addressParts}`).openPopup();
      } catch (e) {
        document.getElementById('pickup-input').value = 'Current Location';
        pickupMarker.bindPopup('Pickup: Current Location').openPopup();
      }
    }

    if (gpsBtn) gpsBtn.innerText = 'GPS';
    checkAndRecalculate();
  };

  const fallbackToIP = async () => {
    try {
      const res = await fetch('https://ipapi.co/json/');
      const data = await res.json();
      if (data.latitude && data.longitude) {
        applyCoordinates(data.latitude, data.longitude, `${data.city || 'Current Area'}, ${data.region_code || ''}`);
        return;
      }
    } catch (e) {}
    if (gpsBtn) gpsBtn.innerText = 'GPS';
    alert('Could not detect location. Please type your pickup address above.');
  };

  if (!navigator.geolocation) {
    fallbackToIP();
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => applyCoordinates(pos.coords.latitude, pos.coords.longitude),
    () => fallbackToIP(),
    { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
  );
}

function fetchSuggestions(type) {
  clearTimeout(debounceTimer);
  const inputEl = document.getElementById(type + '-input');
  const listEl = document.getElementById(type + '-suggestions');
  const query = inputEl.value.trim();

  if (query.length < 3) {
    listEl.style.display = 'none';
    listEl.innerHTML = '';
    return;
  }

  debounceTimer = setTimeout(() => {
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`;
    fetch(url)
      .then(res => res.json())
      .then(data => {
        listEl.innerHTML = '';
        if (!data.features || data.features.length === 0) {
          listEl.style.display = 'none';
          return;
        }

        data.features.forEach(place => {
          const p = place.properties;
          const nameParts = [p.name, p.street, p.city, p.state].filter(Boolean);
          const label = nameParts.join(', ');
          const [lon, lat] = place.geometry.coordinates;

          const li = document.createElement('li');
          li.innerText = label;
          li.onclick = () => selectAddress(type, label, lat, lon);
          listEl.appendChild(li);
        });

        listEl.style.display = 'block';
      })
      .catch(() => { listEl.style.display = 'none'; });
  }, 300);
}

function selectAddress(type, label, lat, lon) {
  document.getElementById(type + '-input').value = label;
  document.getElementById(type + '-suggestions').style.display = 'none';

  if (type === 'pickup') {
    pickupCoords = [lat, lon];
    if (!pickupMarker) pickupMarker = L.marker([lat, lon]).addTo(map);
    else pickupMarker.setLatLng([lat, lon]);
    pickupMarker.bindPopup('Pickup: ' + label).openPopup();
  } else {
    dropoffCoords = [lat, lon];
    if (!dropoffMarker) dropoffMarker = L.marker([lat, lon]).addTo(map);
    else dropoffMarker.setLatLng([lat, lon]);
    dropoffMarker.bindPopup('Drop-off: ' + label).openPopup();
  }

  checkAndRecalculate();
}

function checkAndRecalculate() {
  if (!pickupCoords || !dropoffCoords) return;

  const reqBtn = document.getElementById('request-btn');
  reqBtn.disabled = true;
  reqBtn.innerText = 'Calculating Route & Tolls...';

  const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${pickupCoords[1]},${pickupCoords[0]};${dropoffCoords[1]},${dropoffCoords[0]}?overview=full&geometries=geojson&steps=true`;

  fetch(osrmUrl)
    .then(res => res.json())
    .then(data => {
      if (!data.routes || data.routes.length === 0) {
        alert('No driving route found between these locations.');
        return;
      }

      const route = data.routes[0];
      const distanceMiles = (route.distance / 1609.34);
      const durationMins = Math.round(route.duration / 60);
      rawRouteCoords = route.geometry.coordinates.map(c => [c[1], c[0]]);

      if (routeLine) map.removeLayer(routeLine);
      routeLine = L.polyline(rawRouteCoords, { color: '#10b981', weight: 5 }).addTo(map);
      map.fitBounds(routeLine.getBounds(), { padding: [50, 50] });

      const tollDetails = calculateTolls(rawRouteCoords, route.legs[0]?.steps || []);

      const baseFare = 3.00;
      const distTimeFare = (distanceMiles * 1.45) + (durationMins * 0.25);
      calculatedFare = baseFare + distTimeFare + tollDetails.total;

      document.getElementById('route-stats').innerText = `${distanceMiles.toFixed(1)} mi • ${durationMins} min`;
      document.getElementById('total-fare').innerText = `$${calculatedFare.toFixed(2)}`;
      document.getElementById('dist-time-cost').innerText = `$${distTimeFare.toFixed(2)}`;
      
      if (tollDetails.total > 0) {
        document.getElementById('toll-label').innerText = `Tolls (${tollDetails.names.join(', ')})`;
        document.getElementById('toll-cost').innerText = `+$${tollDetails.total.toFixed(2)}`;
      } else {
        document.getElementById('toll-label').innerText = 'Tolls';
        document.getElementById('toll-cost').innerText = '$0.00';
      }

      document.getElementById('fare-breakdown').style.display = 'flex';
      reqBtn.disabled = false;
      reqBtn.innerText = `Request Ride • $${calculatedFare.toFixed(2)}`;
    })
    .catch(err => {
      console.error(err);
      reqBtn.disabled = false;
      reqBtn.innerText = 'Request Ride';
    });
}

function calculateTolls(routeCoords, steps) {
  let total = 0;
  const detectedNames = [];

  TOLL_CHECKPOINTS.forEach(chk => {
    const matchingIndices = [];
    for (let i = 0; i < routeCoords.length; i++) {
      const lat = routeCoords[i][0];
      const lon = routeCoords[i][1];
      if (lat >= chk.box.minLat && lat <= chk.box.maxLat &&
          lon >= chk.box.minLon && lon <= chk.box.maxLon) {
        matchingIndices.push(i);
      }
    }

    let crossed = false;
    if (matchingIndices.length > 0) {
      const entryPoint = routeCoords[matchingIndices[0]];
      const exitPoint = routeCoords[matchingIndices[matchingIndices.length - 1]];
      if (chk.checkDirection(entryPoint[1], exitPoint[1])) crossed = true;
    }

    if (!crossed) {
      const stepMatch = steps.some(s => s.name && s.name.toLowerCase().includes(chk.name.toLowerCase().split(' ')[0]));
      if (stepMatch) crossed = true;
    }

    if (crossed && !detectedNames.includes(chk.name)) {
      detectedNames.push(chk.name);
      total += chk.toll;
    }
  });

  return { total, names: detectedNames };
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.input-wrapper')) {
    document.getElementById('pickup-suggestions').style.display = 'none';
    document.getElementById('dropoff-suggestions').style.display = 'none';
  }
});

function requestRide() {
  const p = document.getElementById('pickup-input').value;
  const d = document.getElementById('dropoff-input').value;
  const stats = document.getElementById('route-stats').innerText;

  const reqBtn = document.getElementById('request-btn');
  reqBtn.disabled = true;
  reqBtn.innerText = 'Broadcasting to nearby drivers...';

  const payload = {
    type: 'NEW_RIDE_REQUEST',
    pickupText: p,
    dropoffText: d,
    fare: calculatedFare,
    stats: stats,
    routeCoords: rawRouteCoords,
    timestamp: Date.now()
  };

  localStorage.setItem('fairride_ride_request', JSON.stringify(payload));
}

window.onload = function() {
  const session = JSON.parse(localStorage.getItem('fairride_session') || 'null');
  if (session && session.name) {
    document.getElementById('display-user').innerText = 'Hi, ' + session.name;
  }
  initMap();
};