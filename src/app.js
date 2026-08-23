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

// ---------- Ranger-Badge (SVG, deterministisch pro Stadt) ----------
function cityBadge(city, count) {
  const h = [...city].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const skies = ["#F2997B", "#E9B44C", "#F2E8D5"];
  const sky = skies[h % skies.length];
  const m1 = 62 + (h % 20), m2 = 55 + ((h >> 3) % 22);   // Berg-Höhen variieren
  const sunX = 55 + ((h >> 5) % 30);
  const label = city.length > 12 ? city.slice(0, 11) + "…" : city;
  return `
  <svg width="128" height="140" viewBox="0 0 128 140" role="img" aria-label="${esc(city)}">
    <circle cx="64" cy="64" r="62" fill="#2B2118"/>
    <circle cx="64" cy="64" r="56" fill="#F2E8D5"/>
    <circle cx="64" cy="64" r="42" fill="${sky}"/>
    <circle cx="${sunX}" cy="52" r="13" fill="${sky === "#E9B44C" ? "#E8703A" : "#E9B44C"}"/>
    <polygon points="26,84 ${26 + 24},${84 - m1 + 40} 74,84" fill="#3E7C7B"/>
    <polygon points="52,84 ${52 + 26},${84 - m2 + 40} 104,84" fill="#2A4A44"/>
    <rect x="24" y="82" width="80" height="4" fill="#2B2118" opacity="0.9"/>
    <circle cx="64" cy="64" r="46" fill="none" stroke="#2B2118" stroke-width="2"/>
    <text x="64" y="112" text-anchor="middle" font-family="Staatliches, Arial Narrow, sans-serif"
          font-size="13" letter-spacing="1.5" fill="#2B2118">${esc(label.toUpperCase())}</text>
    ${count > 1 ? `<text x="64" y="126" text-anchor="middle" font-family="Staatliches, Arial Narrow, sans-serif"
          font-size="10" letter-spacing="1" fill="#A8481A">×${count}</text>` : ""}
  </svg>`;
}

// ---------- Rendering ----------
function render() {
  const trips = loadTrips();
  const has = trips.length > 0;
  $("year").hidden = $("collection").hidden = $("log").hidden = !has;
  $("inbox").hidden = $("inboxCards").children.length === 0;
  if (!has) return;

  const km = trips.reduce((s, t) => s + (t.km || 0), 0);
  const cities = new Map();
  trips.forEach((t) => cities.set(t.toCity, (cities.get(t.toCity) || 0) + 1));
  const countries = new Set(trips.map((t) => t.toCountry).filter(Boolean));

  $("statKm").textContent = km.toLocaleString("de-DE");
  $("statFlights").textContent = trips.length;
  $("statCities").textContent = cities.size;
  $("statCountries").textContent = countries.size;
  $("statEarth").textContent = (km / 40075).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + "×";

  $("badges").innerHTML = [...cities.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([city, count]) => `<div class="badge">${cityBadge(city, count)}</div>`)
    .join("");

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
  const blob = new Blob([JSON.stringify(loadTrips(), null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "miles-medals-export.json" });
  a.click();
});
$("resetBtn").addEventListener("click", (e) => {
  e.preventDefault();
  if (confirm("Wirklich alle Reisen löschen? (Vorher exportieren?)")) { localStorage.removeItem(STORE_KEY); render(); }
});

render();
