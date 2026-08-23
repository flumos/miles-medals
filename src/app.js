// Miles & Medals — Testlabor. Alles lokal: Barcode-Dekodierung (ZXing WASM),
// BCBP-Parsing, Speicherung (localStorage). Kein Server, kein Tracking.
import { parseBCBP, julianToDate, greatCircleKm } from "./bcbp.js?v=12";
import { looksLikeUIC, extractCompressed, parseUICPayload, RAIL_DETOUR } from "./uic.js?v=12";
import { guessJourney, findStationBest } from "./fcb.js?v=12";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "mm_trips_v1";

let AIRPORTS = null, STATIONS = null;
async function airports() {
  if (!AIRPORTS) AIRPORTS = await (await fetch("data/airports.json")).json();
  return AIRPORTS;
}
async function stations() {
  if (!STATIONS) STATIONS = await (await fetch("data/stations.json")).json();
  return STATIONS;
}

function extractRecord(payload, wantId) {
  const td2 = new TextDecoder("latin1");
  const str = td2.decode(payload);
  let pos = 0;
  while (pos + 12 <= str.length) {
    const id = str.slice(pos, pos + 6);
    if (!/^[A-Z0-9_]{6}$/.test(id)) break;
    const length = parseInt(str.slice(pos + 8, pos + 12), 10);
    if (!Number.isFinite(length) || length < 12) break;
    if (id === wantId) return payload.slice(pos + 12, pos + length);
    pos += length;
  }
  return null;
}

async function inflate(bytes) {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------- Storage ----------
const loadTrips = () => JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
const saveTrips = (t) => localStorage.setItem(STORE_KEY, JSON.stringify(t));
const NIGHTS_KEY = "mm_nights_v1";           // Alt: einzelne Hotelnächte (ISO-Daten) — bleibt zählbar
const loadNights = () => JSON.parse(localStorage.getItem(NIGHTS_KEY) || "[]");
const saveNights = (n) => localStorage.setItem(NIGHTS_KEY, JSON.stringify(n));
const STAYS_KEY = "mm_stays_v1";             // Übernachtungen: {hotel, city, from, to}
const loadStays = () => JSON.parse(localStorage.getItem(STAYS_KEY) || "[]");
const saveStays = (x) => localStorage.setItem(STAYS_KEY, JSON.stringify(x));
// Nächte eines Aufenthalts als ISO-Daten (Anreise bis Tag vor Abreise)
function stayNights(stay) {
  const out = [];
  const d = new Date(stay.from + "T12:00:00Z"), end = new Date(stay.to + "T12:00:00Z");
  while (d < end && out.length < 90) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
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
      const bcbpHit = results.find((r) => r.text && r.text[0] === "M" && parseBCBP(r.text));
      const uicHit = results.find((r) => r.bytes && looksLikeUIC(new Uint8Array(r.bytes)))
        || results.find((r) => r.text && r.text.startsWith("#UT"));   // Fallback: Text-Repräsentation
      if (!bcbpHit && !uicHit) {
        if (!results.length) { showError(file.name, "Kein Barcode im Bild. Tipp: Im DB Navigator den Tab „Ticket“ öffnen (nicht „Reiseplan“) und den Aztec-Code screenshotten; bei Papier: näher und gerade fotografieren."); continue; }
        // Bekannter Irrläufer: Buchungs-Link-QR der Bahn (aus der Bestätigung) statt Ticket-Aztec
        if (results.some((r) => r.text && /bahn\.(de|com)/.test(r.text))) {
          showError(file.name, "Das ist der Buchungs-Link-QR der Bahn — nicht das Ticket. Der Ticket-Code ist der quadratische Aztec-Code mit dem „Bullauge“ in der Mitte: im DB Navigator unter Reisen → Fahrt → Tab „Ticket“.");
          continue;
        }
        // Diagnose: Format + Inhalts-Anfang zeigen, damit unbekannte Ticketformate identifizierbar sind
        const diag = results.map((r) => {
          const b = r.bytes ? new Uint8Array(r.bytes) : null;
          const hex = b ? [...b.slice(0, 10)].map((x) => x.toString(16).padStart(2, "0")).join(" ") : "—";
          const txt = (r.text || "").slice(0, 24).replace(/[^\x20-\x7E]/g, "·");
          console.log("MM-Diagnose", r.format, r.text, b);
          return `${r.format}: „${txt}“ [${hex}]`;
        }).join(" · ");
        showError(file.name, `Barcode gefunden, aber unbekanntes Format — Diagnose: ${diag}`);
        continue;
      }

      if (bcbpHit) {
        const pass = parseBCBP(bcbpHit.text);
        const db = await airports();
        for (const leg of pass.legs) {
          const a = db[leg.from], b = db[leg.to];
          addInboxCard({
            mode: "flight",
            from: leg.from, to: leg.to,
            fromCity: a ? a[2] : leg.from, toCity: b ? b[2] : leg.to,
            toCountry: b ? b[3] : null,
            fromPos: a ? [a[0], a[1]] : null, toPos: b ? [b[0], b[1]] : null,
            km: a && b ? greatCircleKm(a, b) : null,
            carrier: leg.carrier, flightNo: leg.flightNo, seat: leg.seat,
            date: isoDate(julianToDate(leg.julianDay) ?? fileDate(file)),
            name: pass.name, barcodeFormat: bcbpHit.format,
          });
        }
      }

      if (uicHit) {
        const bytes = uicHit.bytes && uicHit.bytes.length
          ? new Uint8Array(uicHit.bytes)
          : Uint8Array.from(uicHit.text, (c) => c.charCodeAt(0) & 0xff);
        const ext = extractCompressed(bytes);
        if (!ext) { showError(file.name, "DB-Ticket erkannt, aber die Daten ließen sich nicht auspacken."); continue; }
        const ticket = parseUICPayload(await inflate(ext.compressed));
        if (!ticket) { showError(file.name, "DB-Ticket erkannt, aber das Datenformat ist unbekannt."); continue; }
        if (ticket.unsupported === "FCB") {
          // Heuristischer FCB-Leser: U_FLEX-Record erneut aus der Payload ziehen
          const payload = await inflate(ext.compressed);
          const flex = extractRecord(payload, "U_FLEX");
          const st = await stations();
          const j = flex ? guessJourney(flex, st) : null;
          if (!j) { showError(file.name, "Neues DB-Ticketformat (FCB) — Start/Ziel konnten heuristisch nicht erkannt werden. Das Bild hilft mir beim Parser-Ausbau."); continue; }
          addInboxCard({
            mode: "train",
            from: j.from[3] || j.from[2], to: j.to[3] || j.to[2],
            fromCity: j.from[3], toCity: j.to[3],
            toCountry: "DE",
            fromPos: [j.from[0], j.from[1]], toPos: [j.to[0], j.to[1]],
            km: Math.round(greatCircleKm(j.from, j.to) * RAIL_DETOUR),
            carrier: "DB", flightNo: j.tarif || "FCB", seat: "",
            date: isoDate(fileDate(file)) || new Date().toISOString().slice(0, 10),
          });
          continue;
        }
        if (!ticket.from || !ticket.to) { showError(file.name, `DB-Ticket gelesen (${(ticket.records || []).join(", ")}), aber ohne Start/Ziel-Felder — vermutlich Zeitkarte oder Sonderformat.`); continue; }
        const st = await stations();
        const a = findStationBest(st, ticket.from)?.station, b = findStationBest(st, ticket.to)?.station;
        addInboxCard({
          mode: "train",
          from: (a && a[3]) || ticket.from, to: (b && b[3]) || ticket.to,
          fromCity: a ? a[3] : ticket.from, toCity: b ? b[3] : ticket.to,
          toCountry: (a && b) ? "DE" : null,
          fromPos: a ? [a[0], a[1]] : null, toPos: b ? [b[0], b[1]] : null,
          km: a && b ? Math.round(greatCircleKm(a, b) * RAIL_DETOUR) : null,
          carrier: "DB", flightNo: ticket.tarif || "", seat: "",
          date: ticket.travelDate || ticket.issued || isoDate(fileDate(file)),
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
    <div class="route"><span>${esc(flight.from)}</span><span class="plane">${flight.mode === "train" ? "🚆" : "✈"}</span><span>${esc(flight.to)}</span></div>
    <div class="meta"><b>${esc(flight.fromCity)} → ${esc(flight.toCity)}</b>
      · ${flight.carrier} ${flight.flightNo}${flight.seat ? " · Sitz " + flight.seat : ""}
      ${flight.km ? " · <b>" + (flight.mode === "train" ? "≈ " : "") + flight.km.toLocaleString("de-DE") + " km</b>" : ""}</div>
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
  const visits = new Map();   // Code/Name → {pos, count, color}
  const bumpPos = (code, pos, isDest, color) => {
    const v = visits.get(code) || { pos, count: 0, color };
    if (isDest) v.count++;
    visits.set(code, v);
  };
  for (const t of trips) {
    const pa = t.fromPos || (db[t.from] ? [db[t.from][0], db[t.from][1]] : null);
    const pb = t.toPos || (db[t.to] ? [db[t.to][0], db[t.to][1]] : null);
    const color = t.mode === "train" ? "#5E9A94" : "#E8703A";
    if (pa) bumpPos(t.from, pa, false, color);
    if (pb) bumpPos(t.to, pb, true, color);
    if (pa && pb) L.polyline(greatCircleArc(pa, pb), {
      color, weight: 1, opacity: 0.7, interactive: false,
    }).addTo(mapLayer);
  }
  const bounds = [];
  for (const [code, v] of visits) {
    bounds.push(v.pos);
    L.circleMarker(v.pos, { radius: 3.5, color: v.color, fillColor: v.color, fillOpacity: 1, weight: 0 }).addTo(mapLayer);
    // Node-Ringe: einer pro Besuch (gedeckelt), Radius wächst
    for (let i = 1; i <= Math.min(v.count, 4); i++) {
      L.circleMarker(v.pos, { radius: 5 + i * 3.5, color: v.color, fill: false, weight: 0.8,
        opacity: Math.max(0.15, 0.65 - i * 0.13), interactive: false }).addTo(mapLayer);
    }
    L.marker(v.pos, {
      icon: L.divIcon({ className: "mm-citylabel", iconAnchor: [-10, 6],
        html: (() => {
          let lbl = code;
          if (lbl.length > 12 && lbl.includes(" ")) lbl = lbl.split(" ")[0];   // „Frankfurt am Main" → „Frankfurt"
          if (lbl.length > 12) lbl = lbl.slice(0, 11) + "…";
          return `${esc(lbl)}${v.count > 1 ? " ×" + v.count : ""}`;
        })() }),
      interactive: false, keyboard: false,
    }).addTo(mapLayer);
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 6 });
}

// ---------- Rendering ----------
function render() {
  const trips = loadTrips();
  const stays = loadStays();
  const nights = [...loadNights(), ...stays.flatMap(stayNights)];
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
  const yFlights = yTrips.filter((t) => t.mode !== "train");
  $("statFlights").textContent = yFlights.length;
  $("statCities").textContent = cities.size;
  $("statCountries").textContent = countries.size;
  $("statEarth").textContent = (km / 40075).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + "×";

  // Status-Fortschritt: Segmente + Elite-Nächte
  $("segVal").textContent = yFlights.length;
  $("segGoal").textContent = SEG_GOAL;
  $("segBar").style.width = Math.min(100, (yFlights.length / SEG_GOAL) * 100) + "%";
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

  $("tripList").innerHTML = renderReisen(trips, stays);
}

// ---------- Reise-Gruppierung: Etappen + Übernachtungen, die zeitlich zusammenhängen ----------
function renderReisen(trips, stays) {
  const events = [
    ...trips.map((t) => ({ kind: "leg", start: t.date, end: t.date, t })),
    ...stays.map((st) => ({ kind: "stay", start: st.from, end: st.to, st })),
  ].filter((e) => e.start).sort((a, b) => (a.start < b.start ? -1 : 1));
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const groups = [];
  for (const e of events) {
    const g = groups[groups.length - 1];
    if (g && e.start <= addDays(g.end, 2)) { g.events.push(e); if (e.end > g.end) g.end = e.end; }
    else groups.push({ start: e.start, end: e.end, events: [e] });
  }
  const fmt = (iso) => iso.slice(8, 10) + "." + iso.slice(5, 7) + ".";
  return groups.reverse().map((g) => {
    const km = g.events.reduce((s, e) => s + (e.t?.km || 0), 0);
    const nights = g.events.filter((e) => e.kind === "stay").reduce((s, e) => s + stayNights(e.st).length, 0);
    // Reise-Titel: Ziel der weitesten Etappe, sonst Stadt der Übernachtung
    const far = g.events.filter((e) => e.kind === "leg").sort((a, b) => (b.t.km || 0) - (a.t.km || 0))[0];
    const title = far ? far.t.toCity : (g.events[0].st?.city || g.events[0].st?.hotel || "Reise");
    const range = g.start === g.end ? fmt(g.start) : `${fmt(g.start)}–${fmt(g.end)}`;
    const meta = [range, km ? km.toLocaleString("de-DE") + " km" : null, nights ? nights + (nights === 1 ? " Nacht" : " Nächte") : null].filter(Boolean).join(" · ");
    const rows = g.events.map((e) => e.kind === "leg" ? `
      <div class="reise-row">
        <span class="ic">${e.t.mode === "train" ? "🚆" : "✈"}</span>
        <span class="rr-main">${esc(e.t.from)} → ${esc(e.t.to)} <span>· ${e.t.date.slice(8, 10)}.${e.t.date.slice(5, 7)}. · ${esc(e.t.carrier)} ${esc(e.t.flightNo)}</span></span>
        <span class="rr-km">${e.t.km ? (e.t.mode === "train" ? "≈ " : "") + e.t.km.toLocaleString("de-DE") + " km" : ""}</span>
      </div>` : `
      <div class="reise-row">
        <span class="ic">🛏</span>
        <span class="rr-main">${esc(e.st.hotel || "Hotel")} <span>· ${esc(e.st.city || "")}</span></span>
        <span class="rr-km nights">${stayNights(e.st).length} ${stayNights(e.st).length === 1 ? "Nacht" : "Nächte"}</span>
      </div>`).join("");
    return `<div class="reise"><div class="reise-head"><span class="rt">${esc(title)}</span><span class="rm">${meta}</span></div>${rows}</div>`;
  }).join("");
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
  const blob = new Blob([JSON.stringify({ trips: loadTrips(), stays: loadStays(), nights: loadNights() }, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "miles-medals-export.json" });
  a.click();
});
$("stayAdd").addEventListener("click", () => {
  const stay = { hotel: $("stayHotel").value.trim(), city: $("stayCity").value.trim(),
                 from: $("stayFrom").value, to: $("stayTo").value };
  if (!stay.from || !stay.to || stay.to <= stay.from) { alert("Bitte An- und Abreise angeben (Abreise nach Anreise)."); return; }
  if (!stay.hotel && !stay.city) { alert("Hotel oder Stadt angeben."); return; }
  const stays = loadStays();
  stays.push(stay);
  saveStays(stays);
  ["stayHotel", "stayCity", "stayFrom", "stayTo"].forEach((id) => $(id).value = "");
  render();
});

$("resetBtn").addEventListener("click", (e) => {
  e.preventDefault();
  if (confirm("Wirklich alle Reisen löschen? (Vorher exportieren?)")) { localStorage.removeItem(STORE_KEY); localStorage.removeItem(NIGHTS_KEY); localStorage.removeItem(STAYS_KEY); render(); }
});

async function migrateTripCodes() {
  const trips = loadTrips();
  if (!trips.some((t) => t.mode === "train")) return;
  const st = await stations();
  const byRil = {};
  for (const v of Object.values(st)) if (v[4]) byRil[v[4]] = v;
  let changed = false;
  for (const t of trips) {
    if (t.mode !== "train") continue;
    for (const k of ["from", "to"]) {
      if (!t[k]) continue;
      const hit = findStationBest(st, t[k])?.station || byRil[t[k]];   // voller Name oder alter RIL100-Code
      if (hit && hit[3] && t[k] !== hit[3]) { t[k] = hit[3]; changed = true; }
    }
  }
  if (changed) saveTrips(trips);
}

migrateTripCodes().then(render);
render();