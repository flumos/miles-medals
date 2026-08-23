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

console.log(fail === 0 ? "\nALLE TESTS GRÜN" : `\n${fail} TEST(S) ROT`);
process.exit(fail ? 1 : 0);
