/* Farmhouse Route Optimization — dashboard client. */

const ROUTE_COLORS = [
  "#ffb703",
  "#2dd4a7",
  "#4cc9f0",
  "#f72585",
  "#b5179e",
  "#90be6d",
];

let map;
let layerGroup;

function initMap() {
  map = L.map("map").setView([13.7563, 100.5018], 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  layerGroup = L.layerGroup().addTo(map);
}

function fmtTime(iso) {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function optimize() {
  const btn = document.getElementById("optimizeBtn");
  btn.disabled = true;
  btn.textContent = "Optimizing…";

  try {
    const res = await fetch("/api/plan/sample");
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const plan = await res.json();
    renderMetrics(plan.metrics);
    renderMap(plan);
    renderRoutes(plan);
  } catch (err) {
    document.getElementById("routes").innerHTML =
      `<p class="hint">Failed to load plan: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Re-optimize";
  }
}

function renderMetrics(m) {
  const cards = [
    { label: "Orders served", value: `${m.ordersServed}/${m.totalOrders}` },
    { label: "Vehicles used", value: `${m.vehiclesUsed}/${m.fleetSize}` },
    {
      label: "Total distance",
      value: `${m.optimizedDistanceKm} km`,
      sub: `−${m.distanceSavedKm} km (${m.distanceSavedPct}%) vs baseline`,
    },
    {
      label: "CO₂ emissions",
      value: `${m.optimizedCo2Kg} kg`,
      sub: `−${m.co2SavedKg} kg (${m.co2SavedPct}%) saved`,
    },
  ];

  document.getElementById("metrics").innerHTML = cards
    .map(
      (c) => `
      <div class="metric-card">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
        ${c.sub ? `<div class="sub">${c.sub}</div>` : ""}
      </div>`
    )
    .join("");
}

function renderMap(plan) {
  layerGroup.clearLayers();
  const bounds = [];

  // Depot marker.
  const depot = plan.depot;
  L.marker([depot.lat, depot.lng], { title: "Depot" })
    .bindPopup(`<b>Depot</b><br>${depot.name || depot.id || "Distribution Center"}`)
    .addTo(layerGroup);
  bounds.push([depot.lat, depot.lng]);

  plan.routes.forEach((route, idx) => {
    if (route.stops.length === 0) return;
    const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
    const line = [[depot.lat, depot.lng]];

    route.stops.forEach((stop) => {
      const { lat, lng } = stop.location;
      line.push([lat, lng]);
      bounds.push([lat, lng]);

      L.circleMarker([lat, lng], {
        radius: 8,
        color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 2,
      })
        .bindPopup(
          `<b>${stop.sequence}. ${stop.customer}</b><br>` +
            `${route.vehicleId} · ETA ${fmtTime(stop.eta)}<br>` +
            `Demand: ${stop.demand} units`
        )
        .addTo(layerGroup);
    });

    line.push([depot.lat, depot.lng]);
    L.polyline(line, { color, weight: 3, opacity: 0.8 }).addTo(layerGroup);
  });

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [40, 40] });
  }
}

function renderRoutes(plan) {
  const container = document.getElementById("routes");
  const active = plan.routes.filter((r) => r.stops.length > 0);

  let html = active
    .map((route, idx) => {
      const color = ROUTE_COLORS[idx % ROUTE_COLORS.length];
      const isEv = route.fuelType === "ev";
      const stops = route.stops
        .map(
          (s) => `
        <li>
          <span class="seq">${s.sequence}</span>
          <div class="stop-info">
            <div class="name">${s.customer}</div>
            <div class="eta">ETA ${fmtTime(s.eta)} · ${s.demand} units · ${s.cumulativeKm} km</div>
          </div>
        </li>`
        )
        .join("");

      return `
      <div class="route-card">
        <div class="route-head">
          <div class="veh">
            <span class="swatch" style="background:${color}"></span>
            ${route.vehicleId}
          </div>
          <span class="tag ${isEv ? "ev" : ""}">${route.fuelType}</span>
        </div>
        <div class="route-meta">
          ${route.stops.length} stops · ${route.distanceKm} km ·
          ${route.co2Kg} kg CO₂ · load ${route.load}/${route.capacity}
        </div>
        <ul class="stop-list">${stops}</ul>
      </div>`;
    })
    .join("");

  if (plan.unassignedOrders.length > 0) {
    html += `<p class="hint">Unassigned (over capacity): ${plan.unassignedOrders
      .map((o) => o.orderId)
      .join(", ")}</p>`;
  }

  container.innerHTML = html || `<p class="hint">No routes generated.</p>`;
}

initMap();
document.getElementById("optimizeBtn").addEventListener("click", optimize);
optimize();
