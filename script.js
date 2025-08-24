// ================ MAP & TILES =================
const map = L.map("map", { zoomControl: true }).setView([13.0827, 80.2707], 13);

// Light & Dark tiles
const lightTiles = L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  { attribution: "© OpenStreetMap" }
).addTo(map);
const darkTiles = L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  { attribution: "© OpenStreetMap, © CARTO" }
);

// ================ STATE =================
let routingControl = null;
let currentRoute = null; // { coordinates: LatLng[], instructions:[{index,text,latLng}], summary:{} }
let currentStepIdx = 0;
let followUser = true;
let voiceOn = true;
let userMarker = null;
let startMarker = null;
let destMarker = null;
let offRouteCounter = 0;

// ================ UI REFS =================
const fromInput = document.getElementById("from");
const toInput = document.getElementById("to");
const routeBtn = document.getElementById("routeBtn");
const stepsOl = document.getElementById("steps");
const sheet = document.getElementById("sheet");
const distEl = document.getElementById("dist");
const durEl = document.getElementById("dur");
const statusEl = document.getElementById("status");

document
  .querySelector("#sheet .handle")
  .addEventListener("click", () => sheet.classList.toggle("expanded"));
let touchStartY = 0;
sheet.addEventListener(
  "touchstart",
  (e) => (touchStartY = e.touches[0].clientY)
);
sheet.addEventListener("touchend", (e) => {
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (dy < -40) sheet.classList.add("expanded");
  else if (dy > 40) sheet.classList.remove("expanded");
});

// ================ HELPERS =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toLatLng = (lat, lon) => L.latLng(parseFloat(lat), parseFloat(lon));

function parseMaybeLatLon(s) {
  // Accept "lat,lon"
  if (!s) return null;
  const m = s.trim().match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (m) return [parseFloat(m[1]), parseFloat(m[3])];
  return null;
}

async function geocode(query) {
  // If lat,lon provided, use directly
  const asPair = parseMaybeLatLon(query);
  if (asPair) return asPair;

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
    query
  )}&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  if (data && data.length)
    return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
  return null;
}

function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat),
    dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat),
    lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function pointToSegmentDistance(p, v, w) {
  // p,v,w: L.LatLng
  const toXY = (ll) => [ll.lat, ll.lng];
  const [py, px] = toXY(p),
    [vy, vx] = toXY(v),
    [wy, wx] = toXY(w);
  const l2 = (vy - wy) ** 2 + (vx - wx) ** 2;
  if (l2 === 0) return haversine(p, v);
  let t = ((py - vy) * (wy - vy) + (px - vx) * (wx - vx)) / l2;
  t = Math.max(0, Math.min(1, t));
  const proj = L.latLng(vy + t * (wy - vy), vx + t * (wx - vx));
  return haversine(p, proj);
}

function minDistanceToPolyline(point, coords) {
  let min = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const d = pointToSegmentDistance(point, coords[i - 1], coords[i]);
    if (d < min) min = d;
  }
  return min;
}

function speak(text) {
  if (!voiceOn) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1;
    u.pitch = 1;
    speechSynthesis.cancel(); // replace previous
    speechSynthesis.speak(u);
  } catch {}
}

function formatDuration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60),
    mm = m % 60;
  return `${h} h ${mm} min`;
}

// ================ CUSTOM MARKERS =================
const StartIcon = L.divIcon({
  className: "start-icon",
  html: `<div style="background:#2ecc71;border:2px solid #fff;border-radius:12px;width:20px;height:20px;box-shadow:0 0 0 2px rgba(46,204,113,.35)"></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});
const DestIcon = L.divIcon({
  className: "dest-icon",
  html: `<div style="background:#e74c3c;border:2px solid #fff;border-radius:12px;width:20px;height:20px;box-shadow:0 0 0 2px rgba(231,76,60,.35)"></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});
const LiveIcon = L.divIcon({
  className: "live-icon",
  html: `<div class="pulse"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

// ================ ROUTING =================
function renderSteps(route) {
  stepsOl.innerHTML = "";
  route.instructions.forEach((inst, i) => {
    const li = document.createElement("li");
    li.textContent = inst.text;
    li.dataset.idx = i;
    stepsOl.appendChild(li);
    li.addEventListener("click", () => {
      currentStepIdx = i;
      map.flyTo(inst.latLng, 17, { duration: 0.6 });
      speak(inst.text);
      highlightStep();
    });
  });
  highlightStep();
}

function highlightStep() {
  [...stepsOl.children].forEach((li) => li.classList.remove("active"));
  const active = stepsOl.children[currentStepIdx];
  if (active) {
    active.classList.add("active");
    // auto-scroll into view
    const rect = active.getBoundingClientRect();
    const container = sheet;
    const cRect = container.getBoundingClientRect();
    if (rect.bottom > cRect.bottom || rect.top < cRect.top) {
      active.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }
}

function hookRoutesFound() {
  routingControl.on("routesfound", (e) => {
    const r = e.routes[0];
    // Build our lightweight route object
    currentRoute = {
      coordinates: r.coordinates,
      instructions: r.instructions.map((inst) => ({
        index: inst.index,
        text: inst.text,
        latLng: r.coordinates[inst.index],
      })),
      summary: r.summary,
    };
    currentStepIdx = 0;
    distEl.textContent = (r.summary.totalDistance / 1000).toFixed(2) + " km";
    durEl.textContent = formatDuration(r.summary.totalTime);
    statusEl.textContent = "Route ready";
    renderSteps(currentRoute);
    sheet.classList.add("expanded");
  });
}

// ================ BUILD ROUTE =================
async function buildRoute() {
  const fromQ = fromInput.value.trim();
  const toQ = toInput.value.trim();
  if (!fromQ || !toQ) {
    alert("Enter both start and destination");
    return;
  }

  const fromLL = await geocode(fromQ);
  const toLL = await geocode(toQ);
  if (!fromLL || !toLL) {
    alert("Could not geocode one of the inputs");
    return;
  }

  // Clear previous
  if (routingControl) map.removeControl(routingControl);
  if (startMarker) map.removeLayer(startMarker);
  if (destMarker) map.removeLayer(destMarker);

  startMarker = L.marker(toLatLng(...fromLL), { icon: StartIcon }).addTo(map);
  destMarker = L.marker(toLatLng(...toLL), { icon: DestIcon }).addTo(map);

  routingControl = L.Routing.control({
    waypoints: [toLatLng(...fromLL), toLatLng(...toLL)],
    router: L.Routing.osrmv1({
      serviceUrl: "https://router.project-osrm.org/route/v1",
    }),
    lineOptions: { styles: [{ color: "#2E7D32", weight: 5 }] },
    altLineOptions: { styles: [{ color: "#999", weight: 5, opacity: 0.5 }] },
    routeWhileDragging: false,
    addWaypoints: false,
    collapsible: true,
    show: false,
    createMarker: () => null,
  }).addTo(map);

  hookRoutesFound();
}

routeBtn.addEventListener("click", buildRoute);

// ================ LIVE LOCATION / FOLLOW / REROUTE =================
function ensureUserMarker(ll) {
  if (!userMarker) {
    userMarker = L.marker(ll, {
      icon: LiveIcon,
      keyboard: false,
      interactive: false,
    }).addTo(map);
  } else {
    userMarker.setLatLng(ll);
  }
}

function maybeCenter(ll) {
  if (!followUser) return;
  const cur = map.getCenter();
  const d = haversine(ll, cur);
  if (d > 120) map.flyTo(ll, Math.max(16, map.getZoom()), { duration: 0.6 });
}

function advanceStepIfClose(ll) {
  if (!currentRoute) return;
  const step = currentRoute.instructions[currentStepIdx];
  if (!step) return;
  const d = haversine(ll, step.latLng);
  if (d < 25) {
    // within 25m -> advance
    currentStepIdx = Math.min(
      currentStepIdx + 1,
      currentRoute.instructions.length - 1
    );
    highlightStep();
    const next = currentRoute.instructions[currentStepIdx];
    if (next) speak(next.text);
  }
}

async function rerouteIfOff(ll) {
  if (!currentRoute) return;
  const minD = minDistanceToPolyline(ll, currentRoute.coordinates);
  if (minD > 50) {
    // off route
    offRouteCounter++;
    statusEl.textContent = `Off route (${minD | 0}m) – recalculating…`;
    // debounce
    if (offRouteCounter % 2 === 0) {
      // Rebuild using current position as new start
      fromInput.value = `${ll.lat.toFixed(6)},${ll.lng.toFixed(6)}`;
      await buildRoute();
      speak("Rerouting");
    }
  } else {
    offRouteCounter = 0;
    statusEl.textContent = "On route";
  }
}

// Start watching GPS
if ("geolocation" in navigator) {
  navigator.geolocation.watchPosition(
    async (pos) => {
      const ll = L.latLng(pos.coords.latitude, pos.coords.longitude);
      ensureUserMarker(ll);
      maybeCenter(ll);
      advanceStepIfClose(ll);
      await rerouteIfOff(ll);
    },
    (err) => {
      console.warn("Geolocation error", err);
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 }
  );
}

// ================ FABs =================
document.getElementById("locateFAB").addEventListener("click", () => {
  if (userMarker) {
    map.flyTo(userMarker.getLatLng(), 17, { duration: 0.5 });
  }
});

document.getElementById("followFAB").addEventListener("click", (e) => {
  followUser = !followUser;
  e.currentTarget.textContent = followUser ? "🎯" : "🧭";
});

document.getElementById("muteFAB").addEventListener("click", (e) => {
  voiceOn = !voiceOn;
  if (!voiceOn) speechSynthesis.cancel();
  e.currentTarget.textContent = voiceOn ? "🔊" : "🔇";
});

// ================ THEME =================
document.getElementById("themeToggle").addEventListener("click", () => {
  document.body.classList.toggle("dark");
  const dark = document.body.classList.contains("dark");
  if (dark) {
    map.removeLayer(lightTiles);
    darkTiles.addTo(map);
  } else {
    map.removeLayer(darkTiles);
    lightTiles.addTo(map);
  }
  document.getElementById("themeToggle").textContent = dark ? "☀️" : "🌙";
});
