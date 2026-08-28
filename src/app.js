// Miles & Medals — Testlabor. Alles lokal: Barcode-Dekodierung (ZXing WASM),
// BCBP-Parsing, Speicherung (localStorage). Kein Server, kein Tracking.
import { parseBCBP, julianToDate, greatCircleKm } from "./bcbp.js?v=24.1";
import { looksLikeUIC, extractCompressed, parseUICPayload, RAIL_DETOUR } from "./uic.js?v=24.1";
import { guessJourney, findStationBest } from "./fcb.js?v=24.1";
import { parseHotelText } from "./hotel.js?v=24.1";

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

// Tesseract lazy laden — nur wenn wirklich OCR gebraucht wird (~8 MB einmalig, danach im Cache)
let ocrWorkerPromise = null;
function ensureOCR() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = new Promise((resolve, reject) => {
      const sc = document.createElement("script");
      sc.src = "vendor/tesseract/tesseract.min.js";
      sc.onload = () => resolve();
      sc.onerror = () => reject(new Error("OCR-Modul lädt nicht"));
      document.head.appendChild(sc);
    }).then(() => Tesseract.createWorker(["deu", "eng"], 1, {
      workerPath: "vendor/tesseract/worker.min.js",
      corePath: "vendor/tesseract/tesseract-core-simd-lstm.wasm.js",
      langPath: "vendor/tesseract/lang",
    }));
  }
  return ocrWorkerPromise;
}

let CITY_NAMES = null;
async function cityNames() {
  if (!CITY_NAMES) {
    const [st, ap] = [await stations(), await airports()];
    CITY_NAMES = [...new Set([...Object.values(st).map((v) => v[3]), ...Object.values(ap).map((v) => v[2])])];
  }
  return CITY_NAMES;
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
const CHECKINS_KEY = "mm_checkins_v1";       // Standort-Logs: {date, city, lat, lon}
const loadCheckins = () => JSON.parse(localStorage.getItem(CHECKINS_KEY) || "[]");
const saveCheckins = (x) => localStorage.setItem(CHECKINS_KEY, JSON.stringify(x));
const HOME_KEY = "mm_home_v1";               // Heimatstandort: {city, lat?, lon?}
const loadHome = () => JSON.parse(localStorage.getItem(HOME_KEY) || "null");
const saveHome = (h) => localStorage.setItem(HOME_KEY, JSON.stringify(h));

// Heimat-Erkennung: gleicher Städtename, bei Check-ins zusätzlich Koordinaten-Nähe (< 30 km)
const isHomeCity = (home, city) => !!home && !!city && city.toLowerCase() === home.city.toLowerCase();
function isHomeCheckin(home, c) {
  if (!home) return false;
  if (isHomeCity(home, c.city)) return true;
  return home.lat != null && c.lat != null && greatCircleKm([home.lat, home.lon], [c.lat, c.lon]) < 30;
}

// Koordinaten zu einem Städtenamen aus den lokalen DBs (Heimatstandort, Auto-Etappen).
// Städtenamen sind mehrdeutig (sechs Bahnhöfe heißen „Münster", drei Orte): Kandidaten
// werden nach Lage geclustert, dann gewinnt der Ort mit Hauptbahnhof, den meisten
// Bahnhöfen und Flughafen in der Nähe. Präzisieren geht über den Bahnhofsnamen
// („Münster (Westf)") — der matcht als Präfix, wenn kein Stadt-Feld exakt passt.
async function findCityPos(name) {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const [st, ap] = [await stations(), await airports()];
  let cands = Object.entries(st).filter(([, v]) => v[3] && v[3].toLowerCase() === q);
  if (!cands.length) cands = Object.entries(st).filter(([, v]) => v[2] && v[2].toLowerCase().startsWith(q));
  if (!cands.length) {
    for (const v of Object.values(ap)) if (v[2] && v[2].toLowerCase() === q) return { city: v[2], lat: v[0], lon: v[1] };
    return null;
  }
  const clusters = [];
  for (const [key, v] of cands) {
    let c = clusters.find((x) => greatCircleKm([x.lat, x.lon], [v[0], v[1]]) < 30);
    if (!c) { c = { lat: v[0], lon: v[1], n: 0, hbf: null, score: 0, city: v[3] || v[2] }; clusters.push(c); }
    c.n++;
    if (key.includes("hbf") || /hauptbahnhof/i.test(v[2])) { c.hbf = v; c.score += 10; }
    if (v[2] && v[3] && v[2].toLowerCase() === v[3].toLowerCase()) c.score += 2;   // Bahnhof heißt wie die Stadt
  }
  for (const c of clusters) {
    c.score += c.n;
    for (const v of Object.values(ap)) {
      if (greatCircleKm([c.lat, c.lon], [v[0], v[1]]) < 30) { c.score += 5; break; }   // Flughafen in der Nähe = größerer Ort
    }
  }
  clusters.sort((a, b) => b.score - a.score);
  const best = clusters[0];
  const pos = best.hbf ? [best.hbf[0], best.hbf[1]] : [best.lat, best.lon];
  return { city: best.city, lat: pos[0], lon: pos[1] };
}

// ---------- Ort-Autocomplete (lokale DB, keine externen Dienste) ----------
let PLACES = null;
async function places() {
  if (!PLACES) {
    const [st, ap] = [await stations(), await airports()];
    PLACES = [];
    for (const [key, v] of Object.entries(st)) {
      if (!v[2]) continue;
      PLACES.push({ label: v[2], sub: v[3] && v[3] !== v[2] ? v[3] : "", city: v[3] || v[2],
                    lat: v[0], lon: v[1], hbf: key.includes("hbf"),
                    l: v[2].toLowerCase(), s: (v[3] || "").toLowerCase() });
    }
    for (const [code, v] of Object.entries(ap)) {
      if (!v[2]) continue;
      const label = `${v[2]} (${code})`;
      PLACES.push({ label, sub: v[3] || "", city: v[2], lat: v[0], lon: v[1], hbf: false,
                    l: label.toLowerCase(), s: v[2].toLowerCase() });
    }
  }
  return PLACES;
}

// Explizite Nutzer-Auswahl je Eingabefeld — schlägt jede Namens-Heuristik
const AC_CHOICE = {};
function attachAutocomplete(input) {
  const wrap = input.parentElement;
  const list = document.createElement("div");
  list.className = "ac-list";
  list.hidden = true;
  wrap.appendChild(list);
  let items = [];
  const close = () => { list.hidden = true; list.innerHTML = ""; };
  input.addEventListener("input", async () => {
    delete AC_CHOICE[input.id];
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { close(); return; }
    const all = await places();
    items = [];
    for (const pl of all) {
      let rank = -1;
      if (pl.l.startsWith(q)) rank = 0;
      else if (pl.s && pl.s.startsWith(q)) rank = 1;
      else if (q.length >= 3 && pl.l.includes(q)) rank = 2;
      if (rank < 0) continue;
      items.push({ pl, r: rank + (pl.hbf ? -0.5 : 0) + pl.l.length / 200 });
    }
    items.sort((a, b) => a.r - b.r);
    items = items.slice(0, 8);
    if (!items.length) { close(); return; }
    list.innerHTML = items.map((x, i) =>
      `<button type="button" data-i="${i}">${esc(x.pl.label)}${x.pl.sub ? `<em>${esc(x.pl.sub)}</em>` : ""}</button>`).join("");
    list.hidden = false;
  });
  list.addEventListener("mousedown", (e) => {   // mousedown feuert vor blur
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    e.preventDefault();
    const pl = items[+b.dataset.i].pl;
    AC_CHOICE[input.id] = { city: pl.city, lat: pl.lat, lon: pl.lon };
    input.value = pl.label;
    close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

// Nächstgelegene Stadt aus den lokalen Datenbanken (Bahnhöfe + Flughäfen) — kein Geocoding-Dienst
async function nearestCity(lat, lon) {
  const [ap, st] = [await airports(), await stations()];
  let best = null;
  const consider = (plat, plon, city) => {
    const d = greatCircleKm([lat, lon], [plat, plon]);
    if (!best || d < best.d) best = { d, city };
  };
  for (const v of Object.values(st)) consider(v[0], v[1], v[3]);
  for (const v of Object.values(ap)) consider(v[0], v[1], v[2]);
  return best && best.d < 80 ? best.city : `${lat.toFixed(2)}° / ${lon.toFixed(2)}°`;
}
// Flughafen-Städtenamen (OurAirports, teils englisch: „Munich") auf die Bahn-Städtenamen
// normalisieren, damit Flug/Bahn/Auto in derselben Stadt landen
async function canonicalCity(name, pos) {
  if (!pos) return name;
  const st = await stations();
  let best = null;
  for (const v of Object.values(st)) {
    if (!v[3]) continue;
    const d = greatCircleKm(pos, [v[0], v[1]]);
    if (d < 25 && (!best || d < best.d)) best = { d, city: v[3] };
  }
  return best ? best.city : name;
}

// Nächte eines Aufenthalts als ISO-Daten (Anreise bis Tag vor Abreise)
function stayNights(stay) {
  const out = [];
  const d = new Date(stay.from + "T12:00:00Z"), end = new Date(stay.to + "T12:00:00Z");
  while (d < end && out.length < 90) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const SEG_GOAL = 30;                          // Vielflieger-Segment-Ziel (später konfigurierbar)
const ROAD_DETOUR = 1.25;                     // Auto: Fallback-Schätzung, wenn kein Routing verfügbar

// Auto-Route über OSRM (öffentlicher OSM-Demo-Server, kein Key): echte Straßen-km + Routen-Geometrie.
// Einzige Anfrage, die das Labor nach draußen schickt (nur Start-/Ziel-Koordinaten) — im Formular ausgewiesen.
async function osrmRoute(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const r = data.routes && data.routes[0];
    if (!r || !r.distance) return null;
    return {
      km: Math.round(r.distance / 1000),
      path: r.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(4), +lon.toFixed(4)]),
    };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// Gletscher-Palette (Design v0.4): Ereignisfarben
const C = { flug: "#6FC7DD", bahn: "#5B7FA6", auto: "#9AA7B5", night: "#4E7A8C", checkin: "#A8D8E8" };
const svgI = (paths, color) => `<svg class="mi" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const modeIcon = (m) => m === "train"
  ? svgI('<rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 10h14M9 19l-1.5 2M15 19l1.5 2"/>', C.bahn)
  : m === "car"
    ? svgI('<path d="M4 16v-3l2-5h10l3 5h1a1 1 0 0 1 1 1v2M4 16h17"/><circle cx="7.5" cy="17.5" r="1.6"/><circle cx="16.5" cy="17.5" r="1.6"/>', C.auto)
    : svgI('<path d="M2 12L22 3l-7 19-3.5-8.5L2 12z"/>', C.flug);
const BED_ICON = svgI('<path d="M3 18v-7h13a5 5 0 0 1 5 5v2M3 14h18M6 11V8"/>', C.night);
const PIN_ICON = svgI('<path d="M12 21c-4.4-5.2-6.6-8.6-6.6-11.4a6.6 6.6 0 1 1 13.2 0C18.6 12.4 16.4 15.8 12 21z"/><circle cx="12" cy="9.6" r="2.2"/>', C.checkin);
const apx = (t) => (t.est || t.mode === "train") ? "\u2248 " : "";
const COUNTRY = { DE: "Deutschland", AT: "\u00d6sterreich", CH: "Schweiz", FR: "Frankreich", NL: "Niederlande", BE: "Belgien", LU: "Luxemburg", DK: "D\u00e4nemark", PL: "Polen", CZ: "Tschechien", IT: "Italien", ES: "Spanien", PT: "Portugal", GB: "Gro\u00dfbritannien", IE: "Irland", SE: "Schweden", NO: "Norwegen", FI: "Finnland", US: "USA", CN: "China", JP: "Japan", SG: "Singapur", AE: "VAE", TR: "T\u00fcrkei", GR: "Griechenland", HU: "Ungarn" };

// ---------- Barcode → Inbox ----------
ZXingWASM.prepareZXingModule({
  overrides: { locateFile: (path) => path.endsWith(".wasm") ? "vendor/zxing_full.wasm" : path },
});

async function handleFiles(files) {
  const dz = $("captureBtn");
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
        if (!results.length) {
          // Kein Barcode → Hotelbestätigung? Texterkennung lokal versuchen
          const info = document.createElement("div");
          info.className = "error-card";
          info.textContent = `${file.name}: Kein Barcode — versuche Texterkennung (beim ersten Mal lädt das OCR-Modul, ~8 MB) …`;
          $("inboxCards").prepend(info);
          $("inbox").hidden = false;
          try {
            const worker = await ensureOCR();
            const { data } = await worker.recognize(file);
            info.remove();
            const stay = parseHotelText(data.text || "", await cityNames());
            if (stay) { addStayCard(stay); continue; }
            showError(file.name, "Weder Barcode noch Hotel-Daten erkannt. Für Tickets: Barcode screenshotten; für Hotels: Bestätigung mit An-/Abreisedatum teilen.");
          } catch (e) {
            info.remove();
            showError(file.name, "Texterkennung fehlgeschlagen (" + e.message + ").");
          }
          continue;
        }
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
          const fromCity = a ? await canonicalCity(a[2], [a[0], a[1]]) : leg.from;
          const toCity = b ? await canonicalCity(b[2], [b[0], b[1]]) : leg.to;
          addInboxCard({
            mode: "flight",
            from: leg.from, to: leg.to,
            fromCity, toCity,
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
            date: "",                                    // FCB trägt kein lesbares Datum — Nutzer muss setzen
            dateUnknown: true,
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
    <div class="route"><span>${esc(flight.from)}</span><span class="plane">${modeIcon(flight.mode)}</span><span>${esc(flight.to)}</span></div>
    <div class="meta"><b>${esc(flight.fromCity)} → ${esc(flight.toCity)}</b>
      · ${flight.carrier} ${flight.flightNo}${flight.seat ? " · Sitz " + flight.seat : ""}
      ${flight.km ? " · <b>" + apx(flight) + flight.km.toLocaleString("de-DE") + " km</b>" : ""}</div>
    <div class="actions">
      <input type="date" value="${flight.date}" aria-label="Flugdatum">
      <button class="confirm">In die Sammlung</button>
      <button class="dismiss">Verwerfen</button>
    </div>`;
  if (flight.dateUnknown) {
    card.querySelector("input").classList.add("attention");
    card.querySelector(".meta").insertAdjacentHTML("beforeend", " · <b style=\"color:var(--acc)\">Datum aus dem Ticket nicht lesbar — bitte setzen</b>");
  }
  card.querySelector("input").addEventListener("input", (e) => e.target.classList.remove("attention"));
  card.querySelector(".confirm").addEventListener("click", () => {
    const dv = card.querySelector("input").value;
    if (!dv && flight.dateUnknown) { alert("Bitte zuerst das Reisedatum setzen — das Ticketformat (FCB) enthält es nicht lesbar."); return; }
    flight.date = dv || flight.date;
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

function addStayCard(stay) {
  const card = document.createElement("div");
  card.className = "inbox-card";
  card.innerHTML = `
    <div class="route"><span class="plane">🛏</span><span style="font-size:18px">Übernachtung erkannt</span></div>
    <div class="meta">Aus der Bestätigung gelesen — bitte prüfen und anpassen.</div>
    <div class="stay-grid" style="margin-bottom:10px">
      <input class="sh" value="${esc(stay.hotel)}" placeholder="Hotel" aria-label="Hotelname">
      <input class="sc" value="${esc(stay.city)}" placeholder="Stadt" aria-label="Stadt">
      <input class="sf" type="date" value="${stay.from}" aria-label="Anreise">
      <input class="st" type="date" value="${stay.to}" aria-label="Abreise">
    </div>
    <div class="actions">
      <button class="confirm">In die Sammlung</button>
      <button class="dismiss">Verwerfen</button>
    </div>`;
  card.querySelector(".confirm").addEventListener("click", () => {
    const v = (cls) => card.querySelector("." + cls).value.trim();
    const rec = { hotel: v("sh"), city: v("sc"), from: v("sf"), to: v("st") };
    if (!rec.from || !rec.to || rec.to <= rec.from) { alert("Bitte An- und Abreise prüfen (Abreise nach Anreise)."); return; }
    if (!rec.hotel && !rec.city) { alert("Hotel oder Stadt angeben."); return; }
    const stays = loadStays();
    stays.push(rec);
    saveStays(stays);
    card.remove();
    render();
  });
  card.querySelector(".dismiss").addEventListener("click", () => { card.remove(); render(); });
  $("inboxCards").appendChild(card);
  $("inbox").hidden = false;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- Karte (Instrument-Register, Leaflet + CARTO dark wie Passjäger) ----------
let map = null, mapLayer = null, labelLayer = null, labelData = [];

// Labels nach Priorität platzieren, kollidierende ausblenden — läuft bei jedem Zoom/Move neu,
// beim Reinzoomen tauchen die restlichen Orte automatisch auf (Punkte/Ringe bleiben immer sichtbar)
function placeLabels() {
  if (!map || !labelLayer) return;
  labelLayer.clearLayers();
  const placed = [];
  for (const l of labelData) {
    const pt = map.latLngToContainerPoint(l.pos);
    const w = l.text.length * 7.5 + 10, h = 18;
    const r = { x1: pt.x + 8, y1: pt.y - h / 2, x2: pt.x + 8 + w, y2: pt.y + h / 2 };
    if (placed.some((o) => r.x1 < o.x2 + 4 && r.x2 > o.x1 - 4 && r.y1 < o.y2 + 2 && r.y2 > o.y1 - 2)) continue;
    placed.push(r);
    L.marker(l.pos, {
      icon: L.divIcon({ className: "mm-citylabel", iconAnchor: [-10, 6], html: esc(l.text) }),
      interactive: false, keyboard: false,
    }).addTo(labelLayer);
  }
}
function ensureMap() {
  if (map) return map;
  map = L.map("map", { worldCopyJump: true, attributionControl: true, zoomControl: true });
  map.attributionControl.setPrefix(false);
  // CARTO-Basemaps brauchen seit 2026-08 einen API-Key — Esri Dark Gray ist keyless und passt zu Gletscher
  // Nur die textfreie Basis-Ebene — Beschriftung übernehmen die eigenen Mono-Labels (Instrument-Register)
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: 'Esri &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 12,
  }).addTo(map);
  mapLayer = L.layerGroup().addTo(map);
  labelLayer = L.layerGroup().addTo(map);
  map.on("zoomend moveend", placeLabels);
  map.setView([50.5, 10], 4);
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

async function renderMap(trips, checkins, home) {
  const db = await airports();
  ensureMap();
  mapLayer.clearLayers();
  labelData = [];
  const visits = new Map();   // Code/Name → {pos, count, km, last, modes, city}
  const bumpPos = (code, pos, isDest, info) => {
    const v = visits.get(code) || { pos, count: 0, km: 0, last: "", modes: new Set(), city: null };
    if (isDest) {
      v.count++;
      if (info) {
        v.km += info.km || 0;
        if (info.date && info.date > v.last) v.last = info.date;
        if (info.mode) v.modes.add(info.mode);
        if (info.city && !v.city) v.city = info.city;
      }
    }
    visits.set(code, v);
  };
  for (const t of trips) {
    const pa = t.fromPos || (db[t.from] ? [db[t.from][0], db[t.from][1]] : null);
    const pb = t.toPos || (db[t.to] ? [db[t.to][0], db[t.to][1]] : null);
    const color = t.mode === "train" ? C.bahn : t.mode === "car" ? C.auto : C.flug;
    if (pa) bumpPos(t.from, pa, false);
    if (pb) bumpPos(t.to, pb, true, { km: t.km || 0, date: t.date, mode: t.mode || "flight", city: t.toCity });
    if (pa && pb) L.polyline(t.path && t.path.length > 1 ? t.path : greatCircleArc(pa, pb), {
      color, weight: 1, opacity: 0.7, interactive: false,
    }).addTo(mapLayer);
  }
  for (const c of (checkins || [])) {
    if (c.lat != null) bumpPos(c.city, [c.lat, c.lon], true, { km: 0, date: c.date, mode: "checkin", city: c.city });
  }
  // Orte im 20-km-Radius zusammenlegen (Flughafen + Hbf = eine Stadt); Knoten neutral,
  // Verkehrsmittel-Farbe tragen nur die Linien (ein Ort ist per Flug, Bahn UND Auto erreichbar)
  const NODE_C = "#E8EDF2";
  const nodes = [];
  for (const [code, v] of visits) {
    let n = nodes.find((x) => greatCircleKm(x.pos, v.pos) < 20);
    if (!n) { n = { pos: v.pos, count: 0, km: 0, last: "", modes: new Set(), city: null, members: [] }; nodes.push(n); }
    n.count += v.count;
    n.km += v.km;
    if (v.last > n.last) n.last = v.last;
    v.modes.forEach((m) => n.modes.add(m));
    if (v.city && !n.city) n.city = v.city;
    n.members.push({ code, count: v.count, pos: v.pos });
  }
  const bounds = [];
  for (const n of nodes) {
    n.members.sort((x, y) => y.count - x.count);
    const iata = n.members.find((m) => /^[A-Z]{3}$/.test(m.code));
    const name = iata ? iata.code : n.members[0].code;
    const pos = n.members[0].pos;
    bounds.push(pos);
    L.circleMarker(pos, { radius: 3.5, color: NODE_C, fillColor: NODE_C, fillOpacity: 1, weight: 0 }).addTo(mapLayer);
    // Node-Ringe: einer pro Besuch (gedeckelt), Radius wächst
    for (let i = 1; i <= Math.min(n.count, 4); i++) {
      L.circleMarker(pos, { radius: 5 + i * 3.5, color: NODE_C, fill: false, weight: 0.8,
        opacity: Math.max(0.15, 0.65 - i * 0.13), interactive: false }).addTo(mapLayer);
    }
    const atHome = isHomeCity(home, name) || (home && home.lat != null && greatCircleKm([home.lat, home.lon], pos) < 30);
    let lbl = name;
    if (lbl.length > 12 && lbl.includes(" ")) lbl = lbl.split(" ")[0];   // „Frankfurt am Main" → „Frankfurt"
    if (lbl.length > 12) lbl = lbl.slice(0, 11) + "…";
    labelData.push({
      pos,
      text: `${atHome ? "\u2302 " : ""}${lbl}${n.count > 1 ? " ×" + n.count : ""}`,
      prio: (atHome ? 1000 : 0) + n.count,
    });
    // Antippbarer Ort: unsichtbare größere Tap-Fläche mit Detail-Popup
    const MODE_DE = { flight: "Flug", train: "Bahn", car: "Auto", checkin: "Check-in" };
    const fmtDate = (iso) => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : "";
    const popup = `<div class="mm-pop"><b>${esc(name)}${n.city && n.city !== name ? " · " + esc(n.city) : ""}</b>` +
      `${n.count} ${n.count === 1 ? "Besuch" : "Besuche"}${n.last ? " · zuletzt " + fmtDate(n.last) : ""}` +
      `${n.km ? "<br>" + n.km.toLocaleString("de-DE") + " km angereist" : ""}` +
      `${n.modes.size ? "<br>" + [...n.modes].map((m) => MODE_DE[m] || m).join(" · ") : ""}</div>`;
    L.circleMarker(pos, { radius: 16, opacity: 0, fillOpacity: 0 })
      .bindPopup(popup, { closeButton: false, offset: [0, -6] })
      .addTo(mapLayer);
  }
  labelData.sort((x, y) => y.prio - x.prio);
  placeLabels();
  if (bounds.length) map.fitBounds(bounds, { padding: [36, 36], maxZoom: 6 });
}

// ---------- Rendering ----------
function render() {
  const home = loadHome();
  const trips = loadTrips();
  const stays = loadStays();
  const checkins = loadCheckins();
  const nights = [...loadNights(), ...stays.flatMap(stayNights)];
  const has = trips.length > 0 || nights.length > 0 || checkins.length > 0;
  $("emptyHint").hidden = has;
  $("inbox").hidden = $("inboxCards").children.length === 0;

  // Jahr: das der jüngsten Reise (i. d. R. das aktuelle)
  const year = trips.length ? Math.max(...trips.map((t) => +t.date.slice(0, 4) || 0)) : new Date().getFullYear();
  const inYear = (iso) => iso && iso.startsWith(String(year));
  const yTrips = trips.filter((t) => inYear(t.date));
  const yNights = nights.filter(inYear).length;
  $("yearLabel").textContent = year;

  const km = yTrips.reduce((s, t) => s + (t.km || 0), 0);
  const cities = new Map();
  yTrips.filter((t) => !isHomeCity(home, t.toCity)).forEach((t) => cities.set(t.toCity, (cities.get(t.toCity) || 0) + 1));
  checkins.filter((c) => inYear(c.date) && !isHomeCheckin(home, c)).forEach((c) => cities.set(c.city, (cities.get(c.city) || 0) + 1));
  const countries = new Set(yTrips.map((t) => t.toCountry).filter(Boolean));

  $("statKm").textContent = km.toLocaleString("de-DE");
  $("statCities").textContent = cities.size;
  $("statCountries").textContent = countries.size;
  const travelDays = new Set([
    ...yTrips.map((t) => t.date),
    ...nights.filter(inYear),
    ...checkins.filter((c) => inYear(c.date) && !isHomeCheckin(home, c)).map((c) => c.date),
  ]);
  $("statDays").textContent = travelDays.size;

  // Weiteste Etappe (Passjäger-Muster: eine Einzelzeile)
  const far = yTrips.filter((t) => t.km).sort((a, b) => b.km - a.km)[0];
  $("farthestRow").hidden = !far;
  if (far) {
    $("farthestRoute").textContent = `${far.from} \u2192 ${far.to}`;
    $("farthestKm").textContent = `${apx(far)}${far.km.toLocaleString("de-DE")} km`;
  }

  // Bewegungsart: gestapelter Balken + Inline-Legende
  const modes = [
    { key: "flight", label: "FLUG", color: C.flug },
    { key: "train",  label: "BAHN", color: C.bahn },
    { key: "car",    label: "AUTO", color: C.auto },
  ];
  const kmBy = {};
  yTrips.forEach((t) => { const m = t.mode || "flight"; kmBy[m] = (kmBy[m] || 0) + (t.km || 0); });
  const active = modes.filter((m) => kmBy[m.key]);
  $("splitSection").hidden = !active.length;
  $("splitBar").innerHTML = active.map((m) =>
    `<i style="width:${km ? Math.max(1, Math.round((kmBy[m.key] / km) * 100)) : 0}%;background:${m.color}"></i>`).join("");
  $("splitLegend").innerHTML = active.map((m) =>
    `<span><i style="background:${m.color}"></i><b>${m.label}</b> ${kmBy[m.key].toLocaleString("de-DE")}</span>`).join("");

  // Status-Fortschritt (Details-Tab)
  const yFlights = yTrips.filter((t) => (t.mode || "flight") === "flight");
  $("segVal").textContent = yFlights.length;
  $("segGoal").textContent = SEG_GOAL;
  $("segBar").style.width = Math.min(100, (yFlights.length / SEG_GOAL) * 100) + "%";
  $("segMark").style.left = "100%";
  $("nightVal").textContent = yNights;
  $("nightBar").style.width = Math.min(100, (yNights / 50) * 100) + "%";

  renderMap(trips, checkins, home);
  renderTopLists(trips, stays, checkins, home);
  $("tripList").innerHTML = renderDays(trips, stays, checkins);
}

// ---------- Details: Top-Listen (Lebens-Sicht, ohne Heimat) ----------
function renderTopLists(trips, stays, checkins, home) {
  const fmt = (n) => n.toLocaleString("de-DE");
  const rows = (items, mapper, total) => {
    const html = items.slice(0, 5).map((it, i) => mapper(it, i)).join("");
    const more = total - Math.min(items.length, 5);
    return html + (more > 0 ? `<div class="tl-more">+ ${more} weitere</div>` : "");
  };

  const cityStats = new Map();
  for (const c of checkins) {
    if (isHomeCheckin(home, c)) continue;
    const e = cityStats.get(c.city) || { count: 0, km: 0 };
    e.count++; cityStats.set(c.city, e);
  }
  for (const t of trips) {
    if (isHomeCity(home, t.toCity)) continue;
    const e = cityStats.get(t.toCity) || { count: 0, km: 0 };
    e.count++; e.km += t.km || 0;
    cityStats.set(t.toCity, e);
  }
  const cityArr = [...cityStats.entries()].sort((a, b) => b[1].count - a[1].count || b[1].km - a[1].km);
  $("cityMeta").textContent = cityArr.length ? `${cityArr.length} gesamt` : "";
  $("topCities").innerHTML = rows(cityArr, ([city, e], i) =>
    `<div class="tl-row"><span class="rank">${i + 1}</span><span class="name">${esc(city)}</span><span class="count">\u00d7${e.count}</span><span class="val">${fmt(e.km)} km</span></div>`, cityArr.length);

  const countryStats = new Map();
  for (const t of trips) {
    if (!t.toCountry) continue;
    const e = countryStats.get(t.toCountry) || { count: 0, km: 0 };
    e.count++; e.km += t.km || 0;
    countryStats.set(t.toCountry, e);
  }
  const countryArr = [...countryStats.entries()].sort((a, b) => b[1].count - a[1].count || b[1].km - a[1].km);
  $("countryMeta").textContent = countryArr.length ? `${countryArr.length} gesamt` : "";
  $("topCountries").innerHTML = rows(countryArr, ([cc, e], i) =>
    `<div class="tl-row"><span class="rank">${i + 1}</span><span class="name">${esc(COUNTRY[cc] || cc)}</span><span class="count">\u00d7${e.count}</span><span class="val">${fmt(e.km)} km</span></div>`, countryArr.length);

  const mcol = { flight: C.flug, train: C.bahn, car: C.auto };
  const routeStats = new Map();
  for (const t of trips) {
    if (!t.from || !t.to) continue;
    const key = `${t.from} \u2192 ${t.to}`;
    const e = routeStats.get(key) || { count: 0, km: 0, mode: t.mode || "flight", est: false };
    e.count++; e.km += t.km || 0; e.est = e.est || !!t.est || t.mode === "train";
    routeStats.set(key, e);
  }
  const routeArr = [...routeStats.entries()].sort((a, b) => b[1].count - a[1].count || b[1].km - a[1].km);
  $("routeMeta").textContent = trips.length ? `${trips.length} Etappen` : "";
  $("topRoutes").innerHTML = rows(routeArr, ([route, e], i) =>
    `<div class="tl-row"><span class="rank">${i + 1}</span><i class="mdot" style="background:${mcol[e.mode] || C.flug}"></i><span class="name">${esc(route)}</span><span class="count">\u00d7${e.count}</span><span class="val">${e.est ? "\u2248 " : ""}${fmt(e.km)} km</span></div>`, routeArr.length);

  const hotelStats = new Map();
  for (const st of stays) {
    const key = st.hotel || st.city || "Hotel";
    const e = hotelStats.get(key) || { nights: 0, city: st.city };
    e.nights += stayNights(st).length;
    hotelStats.set(key, e);
  }
  const hotelArr = [...hotelStats.entries()].sort((a, b) => b[1].nights - a[1].nights);
  const nightsTotal = hotelArr.reduce((s, [, e]) => s + e.nights, 0);
  $("hotelMeta").textContent = hotelArr.length ? `${nightsTotal} N\u00e4chte in ${hotelArr.length} ${hotelArr.length === 1 ? "Hotel" : "Hotels"}` : "";
  $("topHotels").innerHTML = rows(hotelArr, ([hotel, e], i) =>
    `<div class="tl-row"><span class="rank">${i + 1}</span><span class="name">${esc(hotel)}${e.city && hotel !== e.city ? ` \u00b7 ${esc(e.city)}` : ""}</span><span class="val">${e.nights} ${e.nights === 1 ? "Nacht" : "N\u00e4chte"}</span></div>`, hotelArr.length);
}

// ---------- Tages-Timeline: Basis-Einheit Tag, Übernachtungen als Balken ----------
function renderDays(trips, stays, checkins) {
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const legsByDay = {};
  trips.forEach((t, i) => (legsByDay[t.date] = legsByDay[t.date] || []).push({ ...t, _i: i }));
  const nightByDay = {};   // Tag → Stay (Nacht auf diesen Tag folgend)
  stays.forEach((st, i) => { for (const n of stayNights(st)) nightByDay[n] = { ...st, _i: i }; });
  const checkinsByDay = {};
  checkins.forEach((c, i) => (checkinsByDay[c.date] = checkinsByDay[c.date] || []).push({ ...c, _i: i }));

  const dates = [...Object.keys(legsByDay), ...Object.keys(nightByDay), ...Object.keys(checkinsByDay)].sort();
  if (!dates.length) return "";
  const min = dates[0];
  const today = new Date().toISOString().slice(0, 10);
  const max = dates[dates.length - 1] > today ? dates[dates.length - 1] : today;

  const WD = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  const MON = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
  const rows = [];
  let emptyRun = [];
  const flushEmpty = () => {
    if (emptyRun.length > 3) {
      rows.push(`<div class="day-row day-gap"><span class="d-track"></span><span class="d-date"></span><span class="d-loc">· ${emptyRun.length} Tage ·</span></div>`);
    } else {
      for (const d of emptyRun.reverse()) rows.push(dayRow(d, [], null));
    }
    emptyRun = [];
  };
  function dayRow(d, legs, night, checks) {
    const wd = WD[new Date(d + "T12:00:00Z").getUTCDay()];
    const date = `<span class="d-date">${wd} ${d.slice(8, 10)}.${d.slice(5, 7)}.</span>`;
    let track = '<span class="d-track"></span>';
    if (night) {
      const isStart = night.from === d, isEnd = addDays(night.to, -1) === d;
      track = `<span class="d-track"><i class="bar${isStart ? " b-start" : ""}${isEnd ? " b-end" : ""}"></i></span>`;
    } else if (legs.length) {
      track = '<span class="d-track"><i class="dot"></i></span>';
    } else if (checks && checks.length) {
      track = '<span class="d-track"><i class="dot dot-checkin"></i></span>';
    }
    const parts = [];
    for (const t of legs) parts.push(`<span class="d-leg">${modeIcon(t.mode)}<span class="d-txt">${esc(t.from)} → ${esc(t.to)}</span>${t.km ? `<em>${apx(t) + t.km.toLocaleString("de-DE")} km</em>` : ""}<button class="del" data-k="trip" data-i="${t._i}" title="Eintrag löschen">✕</button></span>`);
    if (night && night.from === d) {
      const n = stayNights(night).length;
      parts.push(`<span class="d-leg">${BED_ICON}<span class="d-txt">${esc(night.hotel || "Hotel")}</span><em>${night.city ? esc(night.city) + " · " : ""}${n} ${n === 1 ? "Nacht" : "Nächte"}</em><button class="del" data-k="stay" data-i="${night._i}" title="Übernachtung löschen">✕</button></span>`);
    }
    for (const c of (checks || [])) parts.push(`<span class="d-leg">${PIN_ICON}<span class="d-txt">${c.label ? esc(c.label) : esc(c.city)}</span>${c.label ? `<em>${esc(c.city)}</em>` : ""}<button class="del edit" data-k="checkin-edit" data-i="${c._i}" title="Label ändern">✎</button><button class="del" data-k="checkin" data-i="${c._i}" title="Check-in löschen">✕</button></span>`);
    const loc = night ? (night.city || night.hotel) : (legs.length ? legs[legs.length - 1].toCity : (checks && checks.length ? (checks[0].label || checks[0].city) : ""));
    const locHtml = loc ? `<span class="d-loc">${esc(loc)}</span>` : `<span class="d-loc d-home">·</span>`;
    const events = parts.length ? `<span class="d-events">${parts.join("")}</span>` : "";
    return `<div class="day-row">${track}${date}${locHtml}${events}</div>`;
  }

  let lastMonth = "";
  let d = max;
  while (d >= min) {
    const legs = legsByDay[d] || [];
    const night = nightByDay[d] || null;
    const checks = checkinsByDay[d] || null;
    const month = d.slice(0, 7);
    if (month !== lastMonth) { flushEmpty(); if (lastMonth) rows.push(""); rows.push(`<div class="day-month">${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}</div>`); lastMonth = month; }
    if (!legs.length && !night && !checks) emptyRun.push(d);
    else { flushEmpty(); rows.push(dayRow(d, legs, night, checks)); }
    d = addDays(d, -1);
  }
  flushEmpty();
  return rows.join("");
}

// ---------- Wiring ----------
const fi = $("fileInput");
fi.addEventListener("change", () => { handleFiles([...fi.files]); fi.value = ""; });

// Erfassen-Menü am Plus (oben rechts)
const menu = $("captureMenu");
const closeMenu = () => { menu.hidden = true; $("captureBtn").setAttribute("aria-expanded", "false"); };
$("captureBtn").addEventListener("click", () => {
  menu.hidden = !menu.hidden;
  $("captureBtn").setAttribute("aria-expanded", String(!menu.hidden));
});
const hideForms = () => { $("stayForm").hidden = true; $("carForm").hidden = true; $("homeForm").hidden = true; };
menu.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cap]");
  if (!btn) return;
  const cap = btn.dataset.cap;
  if (cap === "file") { fi.click(); closeMenu(); }
  if (cap === "stay") { hideForms(); $("stayForm").hidden = false; closeMenu(); $("stayHotel").focus(); }
  if (cap === "car") { hideForms(); $("carForm").hidden = false; closeMenu(); $("carFrom").focus(); }
  if (cap === "checkin") { closeMenu(); doCheckin(); }
});

// Drag & Drop: die ganze Seite nimmt Belege an
["dragover", "dragenter"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
document.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]); });

// Tab-Navigation
document.querySelectorAll(".tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbar button").forEach((x) => x.classList.toggle("active", x === btn));
    for (const id of ["uebersicht", "details", "logbuch"]) $("tab-" + id).hidden = id !== btn.dataset.tab;
    if (btn.dataset.tab === "uebersicht" && map) setTimeout(() => map.invalidateSize(), 0);
  });
});

function doCheckin() {
  if (!navigator.geolocation) { showError("Standort", "Dein Browser gibt keinen Standort her."); return; }
  $("captureBtn").classList.add("busy");
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    const city = await nearestCity(lat, lon);
    const list = loadCheckins();
    list.push({ date: new Date().toISOString().slice(0, 10), city, lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    saveCheckins(list);
    $("captureBtn").classList.remove("busy");
    render();
  }, (err) => {
    $("captureBtn").classList.remove("busy");
    showError("Standort", "Kein Standort: " + err.message);
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
}

// Auto-Etappe: manuell erfassen, km aus der Städte-DB geschätzt (Luftlinie × Straßen-Umweg)
$("carAdd").addEventListener("click", async () => {
  const fromName = $("carFrom").value.trim(), toName = $("carTo").value.trim(), date = $("carDate").value;
  if (!fromName || !toName || !date) { alert("Bitte Start, Ziel und Datum angeben."); return; }
  const btn = $("carAdd");
  btn.disabled = true; btn.textContent = "Route wird berechnet …";
  const [a, b] = [AC_CHOICE.carFrom || await findCityPos(fromName), AC_CHOICE.carTo || await findCityPos(toName)];
  const route = a && b ? await osrmRoute(a, b) : null;
  btn.disabled = false; btn.textContent = "Eintragen";
  const kmInput = parseInt($("carKm").value, 10);
  let km = Number.isFinite(kmInput) && kmInput > 0 ? kmInput : (route ? route.km : null);
  let est = false;
  if (!km && a && b) { km = Math.round(greatCircleKm([a.lat, a.lon], [b.lat, b.lon]) * ROAD_DETOUR); est = true; }
  if (!km) { alert("Ort nicht in der Städte-DB gefunden — bitte km direkt angeben."); return; }
  const trips = loadTrips();
  trips.push({
    mode: "car",
    from: a ? a.city : fromName, to: b ? b.city : toName,
    fromCity: a ? a.city : fromName, toCity: b ? b.city : toName,
    toCountry: null,
    fromPos: a ? [a.lat, a.lon] : null, toPos: b ? [b.lat, b.lon] : null,
    km, est, date, carrier: "", flightNo: "", seat: "",
    ...(route && route.path.length > 1 ? { path: route.path } : {}),
  });
  trips.sort((x, y) => (x.date < y.date ? 1 : -1));
  saveTrips(trips);
  ["carFrom", "carTo", "carDate", "carKm"].forEach((id) => $(id).value = "");
  delete AC_CHOICE.carFrom; delete AC_CHOICE.carTo;
  $("carForm").hidden = true;
  render();
});

$("exportBtn").addEventListener("click", (e) => {
  e.preventDefault();
  const blob = new Blob([JSON.stringify({ trips: loadTrips(), stays: loadStays(), checkins: loadCheckins(), nights: loadNights(), home: loadHome() }, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "miles-medals-export.json" });
  a.click();
});
$("tripList").addEventListener("click", (e) => {
  const btn = e.target.closest(".del");
  if (!btn) return;
  const { k, i } = btn.dataset;
  if (k === "checkin-edit") {
    const list = loadCheckins();
    const c = list[+i];
    const label = prompt("Label für diesen Check-in (z. B. Kunde, Restaurant, Ausflugsziel):", c.label || "");
    if (label !== null) { c.label = label.trim(); saveCheckins(list); render(); }
    return;
  }
  const stores = { trip: [loadTrips, saveTrips], stay: [loadStays, saveStays], checkin: [loadCheckins, saveCheckins] };
  const labels = { trip: "Etappe", stay: "Übernachtung", checkin: "Check-in" };
  if (!confirm(`${labels[k]} wirklich löschen?`)) return;
  const [load, save] = stores[k];
  const list = load();
  list.splice(+i, 1);
  save(list);
  render();
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
  $("stayForm").hidden = true;
  render();
});

function homeLabel() {
  const h = loadHome();
  $("homeBtn").textContent = h ? `Heimat: ${h.city}` : "Heimat festlegen";
}
$("homeBtn").addEventListener("click", (e) => {
  e.preventDefault();
  hideForms();
  const f = $("homeForm");
  f.hidden = false;
  const h = loadHome();
  $("homeCity").value = h ? h.city : "";
  delete AC_CHOICE.homeCity;
  f.scrollIntoView({ block: "center" });
  $("homeCity").focus();
});
$("homeSave").addEventListener("click", async () => {
  const name = $("homeCity").value.trim();
  const choice = AC_CHOICE.homeCity || (name ? await findCityPos(name) : null);
  if (!choice) { alert("Ort nicht gefunden — bitte einen Vorschlag aus der Liste wählen."); return; }
  saveHome({ city: choice.city, lat: choice.lat, lon: choice.lon });
  $("homeForm").hidden = true;
  homeLabel(); render();
});
$("homeLocate").addEventListener("click", () => {
  if (!navigator.geolocation) { showError("Heimat", "Dein Browser gibt keinen Standort her — bitte den Ort eintippen."); return; }
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude: lat, longitude: lon } = pos.coords;
    saveHome({ city: await nearestCity(lat, lon), lat: +lat.toFixed(4), lon: +lon.toFixed(4) });
    $("homeForm").hidden = true;
    homeLabel(); render();
  }, (err) => showError("Heimat", "Kein Standort: " + err.message), { enableHighAccuracy: false, timeout: 10000 });
});
attachAutocomplete($("carFrom"));
attachAutocomplete($("carTo"));
attachAutocomplete($("homeCity"));
homeLabel();

$("resetBtn").addEventListener("click", (e) => {
  e.preventDefault();
  if (confirm("Wirklich alle Reisen löschen? (Vorher exportieren?)")) { localStorage.removeItem(STORE_KEY); localStorage.removeItem(NIGHTS_KEY); localStorage.removeItem(STAYS_KEY); localStorage.removeItem(CHECKINS_KEY); render(); }
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

async function migrateCityNames() {
  const trips = loadTrips();
  let changed = false;
  for (const t of trips) {
    if ((t.mode || "flight") !== "flight") continue;
    if (t.fromPos && t.fromCity) { const c = await canonicalCity(t.fromCity, t.fromPos); if (c !== t.fromCity) { t.fromCity = c; changed = true; } }
    if (t.toPos && t.toCity) { const c = await canonicalCity(t.toCity, t.toPos); if (c !== t.toCity) { t.toCity = c; changed = true; } }
  }
  if (changed) saveTrips(trips);
}

migrateTripCodes().then(migrateCityNames).then(render);
render();