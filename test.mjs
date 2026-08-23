// Round-Trip-Test: BCBP-String → PDF417-Barcode-PNG (zxing writer) → Decoder (zxing reader) → Parser.
// Testet exakt die Pipeline, die im Browser läuft — ohne echtes Foto.
import { parseBCBP, julianToDate, greatCircleKm } from "./src/bcbp.js";
import { readBarcodes, writeBarcode } from "zxing-wasm/full";
import { readFileSync, writeFileSync } from "node:fs";

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✅" : "  ❌"), msg); if (!cond) fail++; };

// 1) Parser mit synthetischen Strings
const oneLeg = "M1BLUME/FELIX         EABC123 HAMPEKCA 0910 289Y023A0042 100";
let r = parseBCBP(oneLeg);
ok(r && r.name === "BLUME/FELIX", "Name geparst");
ok(r && r.legs[0].from === "HAM" && r.legs[0].to === "PEK", "Route HAM→PEK");
ok(r && r.legs[0].carrier === "CA" && r.legs[0].flightNo === "0910", "Carrier+Flugnummer");
ok(r && r.legs[0].julianDay === 289 && r.legs[0].seat === "023A", "Julian Day + Sitz");

// Zwei Legs mit Conditional-Füllung im ersten Leg (varSize 0A = 10 Zeichen Müll)
const twoLeg = "M2BLUME/FELIX         EABC123 HAMFRALH 0031 289Y012C0007 10AXXXXXXXXXXDEF456 FRAPEKLH 0722 289C002A0001 100";
r = parseBCBP(twoLeg);
ok(r && r.legs.length === 2, "Multi-Leg erkannt");
ok(r && r.legs[1].from === "FRA" && r.legs[1].to === "PEK", "Leg 2 nach Conditional-Skip korrekt");

// 2) Jahres-Heuristik: Tag 289 = Mitte Oktober; Referenz heute (Aug) → Vorjahr? Nein: >2 Tage Zukunft → Vorjahr
const d = julianToDate(289, new Date(Date.UTC(2026, 7, 23)));
ok(d.getUTCFullYear() === 2025 && d.getUTCMonth() === 9, "Julian 289 bei Referenz Aug 2026 → Okt 2025 (Vergangenheits-Annahme)");
const d2 = julianToDate(236, new Date(Date.UTC(2026, 7, 23))); // Tag 236 = 24.08. → nur 1 Tag voraus → 2026
ok(d2.getUTCFullYear() === 2026, "Julian nahe heute bleibt im aktuellen Jahr");

// 3) Distanz gegen Flughafen-DB
const airports = JSON.parse(readFileSync("data/airports.json", "utf-8"));
const km = greatCircleKm(airports.HAM, airports.FRA);
ok(km >= 405 && km <= 420, `HAM–FRA = ${km} km (Soll ~412)`);

// 4) Round-Trip: PDF417 schreiben und wieder lesen
const barcode = await writeBarcode(oneLeg, { format: "PDF417" });
writeFileSync("/tmp/bcbp_test.png", new Uint8Array(await barcode.image.arrayBuffer()));
const decoded = await readBarcodes(new Blob([readFileSync("/tmp/bcbp_test.png")]), { formats: ["PDF417"] });
ok(decoded.length === 1 && decoded[0].text === oneLeg, "PDF417 Round-Trip: schreiben → lesen → identisch");
const rt = parseBCBP(decoded[0].text);
ok(rt && rt.legs[0].to === "PEK", "Dekodierter Barcode parst korrekt");

// ---- UIC 918-3 (Bahn): synthetisches Ticket bauen → Parser prüfen ----
const { looksLikeUIC, extractCompressed, parseUICPayload, findStation, normStation } = await import("./src/uic.js");
const zlib = await import("node:zlib");

function rec(id, version, data) {
  const body = id + version + String(12 + data.length).padStart(4, "0") + data;
  return body;
}
const uHead = rec("U_HEAD", "01", "0080" + "ABC123DEF4560000000 ".padEnd(20) + "231120261435" + "0" + "DE");
const blTrips = "00" + "1" + "23112026" + "23112026" + "12345678";  // vereinfachter Trip-Vorspann
const sBlocks = "S001" + "0012" + "Flexpreis Hi" + "S015" + "0011" + "Hamburg Hbf" + "S016" + "0018" + "Frankfurt(Main)Hbf" + "S031" + "0010" + "23.11.2026";
const uBl = rec("0080BL", "03", blTrips + sBlocks);
const payload = Buffer.from(uHead + uBl, "latin1");
const compressed = zlib.deflateSync(payload);
const header = Buffer.concat([
  Buffer.from("#UT01" + "0080" + "00007", "latin1"),
  Buffer.alloc(50, 0x30),                                   // Fake-Signatur
  Buffer.from(String(compressed.length).padStart(4, "0"), "latin1"),
  compressed,
]);
ok(looksLikeUIC(header), "UIC-Header erkannt");
const ext = extractCompressed(header);
ok(ext && ext.declaredLength === compressed.length, "zlib-Payload gefunden (Längenfeld stimmt)");
const parsed = parseUICPayload(new Uint8Array(zlib.inflateSync(ext.compressed)));
ok(parsed && parsed.from === "Hamburg Hbf" && parsed.to === "Frankfurt(Main)Hbf", "Start/Ziel aus 0080BL");
ok(parsed && parsed.travelDate === "2026-11-23", "Reisedatum aus S031");

const stations = JSON.parse(readFileSync("data/stations.json", "utf-8"));
const a = findStation(stations, "Hamburg Hbf"), b = findStation(stations, "Frankfurt(Main)Hbf");
ok(a && b, "Bahnhöfe im Stations-Lookup gefunden");
const railKm = Math.round(greatCircleKm(a, b) * 1.25);
ok(railKm > 450 && railKm < 560, `Bahn-km HAM–FRA ≈ ${railKm} (Näherung, real ~500)`);

// U_FLEX (neues FCB-Format) wird sauber abgelehnt
const flexPayload = Buffer.from(rec("U_FLEX", "13", "xxxx"), "latin1");
ok(parseUICPayload(new Uint8Array(flexPayload))?.unsupported === "FCB", "U_FLEX → ehrliche Ablehnung");

// ---- FCB-Heuristik: bit-verschobene Stations-Strings erkennen (anonymisiertes Muster) ----
const { guessJourney } = await import("./src/fcb.js");
function shiftInto(text, shift) {
  const src = Buffer.from("\x00\x00" + text + "\x00\x00", "utf-8");   // Rauschen drumherum
  const bits = [];
  for (const byte of src) for (let b = 7; b >= 0; b--) bits.push((byte >> b) & 1);
  for (let i = 0; i < shift; i++) bits.unshift(1);                     // Bit-Versatz wie im UPER-Strom
  while (bits.length % 8) bits.push(0);
  const out = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, i) => { out[i >> 3] |= bit << (7 - (i % 8)); });
  return out;
}
const fcbFake = Buffer.concat([
  Buffer.from([0x62, 0xb2, 0x00, 0x86]),                               // UPER-artiger Vorspann
  shiftInto("Hamburg+City", 3),
  Buffer.from([0x81, 0x05]),
  shiftInto("Münster(Westf)+City&Via: <1080>VAI*(MZ/MA*F)", 3),
  shiftInto("Flexpreis", 6),
]);
const journey = guessJourney(new Uint8Array(fcbFake), stations);
ok(journey && journey.from[2] === "Hamburg Hbf", "FCB-Heuristik: Start erkannt (Hamburg+City → Hamburg Hbf)");
ok(journey && journey.to[2].startsWith("Münster"), "FCB-Heuristik: Ziel erkannt (Münster(Westf))");
ok(journey && /Flexpreis/.test(journey.tarif), "FCB-Heuristik: Tarif gefunden");
console.log(fail === 0 ? "FCB-TESTS GRÜN" : `${fail} FCB-TEST(S) ROT`);
process.exit(fail ? 1 : 0);
