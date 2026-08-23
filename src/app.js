// Miles & Medals — Testlabor. Alles lokal: Barcode-Dekodierung (ZXing WASM),
// BCBP-Parsing, Speicherung (localStorage). Kein Server, kein Tracking.
import { parseBCBP, julianToDate, greatCircleKm } from "./bcbp.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "mm_trips_v1";

let AIRPORTS = null;
async function airports() {
  if (!AIRPORTS) AIRPORTS = await (await fetch("data/airports.json")).json();
  return AIRPORTS;
}

// ---------- Storage ----------
const loadTrips = () => JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
const saveTrips = (t) => localStorage.setItem(STORE_KEY, JSON.stringify(t));
const NIGHTS_KEY = "mm_nights_v1";           // manuell nachgetragene Hotelnächte (ISO-Daten)
const loadNights = () => JSON.parse(localStorage.getItem(NIGHTS_KEY) || "[]");
const saveNights = (n) => localStorage.setItem(NIGHTS_KEY, JSON.stringify(n));
const SEG_GOAL = 30;                          // Vielflieger-Segment-Ziel (später konfigurierbar)

// ---------- Barcode → Inbox ----------
ZXingWASM.prepareZXingModule({
  overrides: { locateFile: (path) => path.endsWith(".wasm") ? "vendor/zxing_full.wasm" : path },
});

async function handleFiles(files) {
  const dz = $("dropzone");
  dz.classList.add("busy");
  for (const file of files) {
    try {
      const results = await ZXingWASM.readBarcodesFromImageFile(file, {
        formats: ["PDF417", "Aztec", "QRCode", "DataMatrix"],
        tryHarder: true,
      });
      const hit = results.find((r) => r.text && r.text[0] === "M" && parseBCBP(r.text));
      if (!hit) { showError(file.name, results.length ? "Barcode gefunden, aber kein Boardingpass-Format (BCBP)." : "Kein Barcode erkennbar — näher/gerader fotografieren hilft."); continue; }
      const pass = parseBCBP(hit.text);
      const db = await airports();
      for (const leg of pass.legs) {
        const a = db[leg.from], b = db[leg.to];
        addInboxCard({
          from: leg.from, to: leg.to,
          fromCity: a ? a[2] : leg.from, toCity: b ? b[2] : leg.to,
          toCountry: b ? b[3] : null,
          km: a && b ? greatCircleKm(a, b) : null,
          carrier: leg.carrier, flightNo: leg.flightNo, seat: leg.seat,
          date: isoDate(julianToDate(leg.julianDay) ?? fileDate(file)),
          name: pass.name, barcodeFormat: hit.format,
        });
      }
    } catch (e) {
      showError(file.name, "Konnte die Datei nicht lesen (" + e.message + ").");
    }
  }
  dz.classList.remove("busy");
  render();
}

const isoDate = (d) => d ? d.toISOString().slice(0, 10) : "";
const fileDate = (f) => f.lastModified ? new Date(f.lastModified) : null;

function showError(fileName, msg) {
  const el = document.createElement("div");
  el.className = "error-card";
  el.textContent = `${fileName}: ${msg}`;
  $("inboxCards").prepend(el);
  $("inbox").hidden = false;
  setTimeout(() => el.remove(), 12000);
}

// ---------- Inbox mit 1-Tap-Bestätigung ----------
function addInboxCard(flight) {
  const card = document.createElement("div");
  card.className = "inbox-card";
  card.innerHTML = `
    <div class="route"><span>${flight.from}</span><span class="plane">✈</span><span>${flight.to}</span></div>
    <div class="meta"><b>${esc(flight.fromCity)} → ${esc(flight.toCity)}</b>
      · ${flight.carrier} ${flight.flightNo}${flight.seat ? " · Sitz " + flight.seat : ""}
      ${flight.km ? " · <b>" + flight.km.toLocaleString("de-DE") + " km</b>" : ""}</div>
    <div class="actions">
      <input type="date" value="${flight.date}" aria-label="Flugdatum">
      <button class="confirm">In die Sammlung</button>
      <button class="dismiss">Verwerfen</button>
    </div>`;
  card.querySelector(".confirm").addEventListener("click", () => {
    flight.date = card.querySelector("input").value || flight.date;
    const trips = loadTrips();
    trips.push(flight);
    trips.sort((x, y) => (x.date < y.date ? 1 : -1));
    saveTrips(trips);
    card.remove();
    render();
  });
  card.querySelector(".dismiss").addEventListener("click", () => { card.remove(); render(); });
  $("inboxCards").appendChild(card);
  $("inbox").hidden = false;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- Karte (Instrument-Register, Leaflet + CARTO dark wie Passjäger) ----------
let map = null, mapLayer = null;
function ensureMap() {
  if (map) return map;
  map = L.map("map", { worldCopyJump: true, attributionControl: true, zoomControl: true });
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd", maxZoom: 12,
  }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
  return map;
}

// Großkreis-Bogen als Punktfolge (Slerp zwischen zwei Koordinaten)
function greatCircleArc(a, b, n = 48) {
  const r = Math.PI / 180, d = 180 / Math.PI;
  const [la1, lo1, la2, lo2] = [a[0] * r, a[1] * r, b[0] * r, b[1] * r];
  const v1 = [Math.cos(la1) * Math.cos(lo1), Math.cos(la1) * Math.sin(lo1), Math.sin(la1)];
  const v2 = [Math.cos(la2) * Math.cos(lo2), Math.cos(la2) * Math.sin(lo2), Math.sin(la2)];
  const dot = Math.min(1, Math.max(-1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
  const om = Math.acos(dot);
  if (om < 1e-6) return [a, b];
  const pts = [];
  let prevLon = null, shift = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n, s1 = Math.sin((1 - t) * om) / Math.sin(om), s2 = Math.sin(t * om) / Math.sin(om);
    const x = s1 * v1[0] + s2 * v2[0], y = s1 * v1[1] + s2 * v2[1], z = s1 * v1[2] + s2 * v2[2];
    let lon = Math.atan2(y, x) * d;
    // Antimeridian: Sprünge > 180° in fortlaufende Länge umrechnen
    if (prevLon !== null && lon + shift - prevLon > 180) shift -= 360;
    else if (prevLon !== null && lon + shift - prevLon < -180) shift += 360;
    prevLon = lon + shift;
    pts.push([Math.asin(z) * d, lon + shift]);
  }
  return pts;
}

async function renderMap(trips) {
  const db = await airports();
  ensureMap();
  mapLayer.clearLayers();
  const visits = new Map();   // IATA → {pos, city, count, isOrigin}
  const bump = (code, isDest) => {
    const ap = db[code]; if (!ap) return;
    const v = visits.get(code) || { pos: [ap[0], ap[1]], city: ap[2], count: 0 };
    if (isDest) v.count++;
    visits.set(code, v);
  };
  for (const t of trips) {
    bump(t.from, false); bump(t.to, true);
    const a = db[t.from], b = db[t.to];
    if (a && b) L.polyline(greatCircleArc([a[0], a[1]], [b[0], b[1]]), {
      color: "#E8703A", weight: 1, opacity: 0.7, interactive: false,
    }).addTo(mapLayer);
  }
  const bounds = [];
  for (const [code, v] of visits) {
    bounds.push(v.pos);
    L.circleMarker(v.pos, { radius: 3.5, color: "#E8703A", fillColor: "#E8703A", fillOpacity: 1, weight: 0 }).addTo(mapLayer);
    // Node-Ringe: einer pro Besuch (gedeckelt), Radius wächst
    for (let i = 1; i <= Math.min(v.count, 4); i++) {
      L.circleMarker(v.pos, { radius: 5 + i * 3.5, color: "#E8703A", fill: false, weight: 0.8,
        opacity: Math.max(0.15, 0.65 - i * 0.13), interactive: false }).addTo(mapLayer);
    }
    L.marker(v.pos, {
      icon: L.divIcon({ className: "mm-citylabel", iconAnchor: [-10, 6],
        html: `${code}${v.count > 1 ? " ×" + v.count : ""}` }),
      interactive: false, keyboard: false,
    }).addTo(mapLayer);
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 6 });
}

// ---------- Rendering ----------
function render() {
  const trips = loadTrips();
  const nights = loadNights();
  const has = trips.length > 0 || nights.length > 0;
  $("year").hidden = $("log").hidden = !has;
  $("collection").hidden = $("mapSection").hidden = trips.length === 0;
  $("inbox").hidden = $("inboxCards").children.length === 0;
  if (!has) return;

  // Jahres-Panel: das Jahr der jüngsten Reise (i. d. R. das aktuelle)
  const year = trips.length ? Math.max(...trips.map((t) => +t.date.slice(0, 4) || 0)) : new Date().getFullYear();
  const inYear = (iso) => iso && iso.startsWith(String(year));
  const yTrips = trips.filter((t) => inYear(t.date));
  const yNights = nights.filter(inYear).length;
  $("yearTitle").textContent = `Dein Reisejahr ${year}`;

  const km = yTrips.reduce((s, t) => s + (t.km || 0), 0);
  const cities = new Map();
  yTrips.forEach((t) => cities.set(t.toCity, (cities.get(t.toCity) || 0) + 1));
  const countries = new Set(yTrips.map((t) => t.toCountry).filter(Boolean));

  $("statKm").textContent = km.toLocaleString("de-DE");
  $("statFlights").textContent = yTrips.length;
  $("statCities").textContent = cities.size;
  $("statCountries").textContent = countries.size;
  $("statEarth").textContent = (km / 40075).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + "×";

  // Status-Fortschritt: Segmente + Elite-Nächte
  $("segVal").textContent = yTrips.length;
  $("segGoal").textContent = SEG_GOAL;
  $("segBar").style.width = Math.min(100, (yTrips.length / SEG_GOAL) * 100) + "%";
  $("segMark").style.left = "100%";
  $("nightVal").textContent = yNights;
  $("nightBar").style.width = Math.min(100, (yNights / 50) * 100) + "%";

  renderMap(trips);

  // Städte-Liste (Lebens-Sicht, nüchtern): Stadt · Land · Besuche · letzte Reise
  const cityStats = new Map();
  for (const t of trips) {
    const c = cityStats.get(t.toCity) || { country: t.toCountry, count: 0, km: 0, last: "" };
    c.count++; c.km += t.km || 0;
    if (t.date > c.last) c.last = t.date;
    cityStats.set(t.toCity, c);
  }
  $("cityList").innerHTML = [...cityStats.entries()]
    .sort((x, y) => y[1].count - x[1].count || (y[1].last > x[1].last ? 1 : -1))
    .map(([city, c]) => `
      <div class="city-row">
        <span class="c-name">${esc(city)}${c.country ? ` <span class="c-cc">${esc(c.country)}</span>` : ""}</span>
        <span class="c-count">${c.count}×</span>
        <span class="c-km">${c.km.toLocaleString("de-DE")} km</span>
        <span class="c-last">${c.last}</span>
      </div>`).join("");

  $("tripList").innerHTML = trips.map((t) => `
    <div class="trip">
      <span class="r">${t.from} → ${t.to} <span style="font-weight:400">· ${esc(t.toCity)}</span></span>
      <span class="km">${t.km ? t.km.toLocaleString("de-DE") + " km" : "—"}</span>
      <span class="d">${t.date} · ${t.carrier} ${t.flightNo}</span>
    </div>`).join("");
}

// ---------- Wiring ----------
const dz = $("dropzone"), fi = $("fileInput");
dz.addEventListener("click", () => fi.click());
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fi.click(); });
fi.addEventListener("change", () => { handleFiles([...fi.files]); fi.value = ""; });
["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => handleFiles([...e.dataTransfer.files]));

$("exportBtn").addEventListener("click", (e) => {
  e.preventDefault();
  const blob = new Blob([JSON.stringify({ trips: loadTrips(), nights: loadNights() }, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "miles-medals-export.json" });
  a.click();
});
$("addNight").addEventListener("click", () => {
  const n = loadNights();
  n.push(new Date().toISOString().slice(0, 10));
  saveNights(n);
  render();
});

$("resetBtn").addEventListener("click", (e) => {
  e.preventDefault();
  if (confirm("Wirklich alle Reisen löschen? (Vorher exportieren?)")) { localStorage.removeItem(STORE_KEY); localStorage.removeItem(NIGHTS_KEY); render(); }
});

render();
