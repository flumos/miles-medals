import { createWorker } from "tesseract.js";
import { readFileSync } from "node:fs";
const { parseHotelText } = await import("../src/hotel.js");
const worker = await createWorker(["deu", "eng"]);
const { data } = await worker.recognize("/tmp/hotel_test.png");
await worker.terminate();
console.log("OCR-Text (Auszug):", JSON.stringify(data.text.slice(0, 140)));
const stay = parseHotelText(data.text, ["Frankfurt am Main", "München", "Hamburg"]);
console.log("Ergebnis:", JSON.stringify(stay));
if (!stay || stay.from !== "2026-08-24" || stay.to !== "2026-08-27") { console.log("❌ FEHLGESCHLAGEN"); process.exit(1); }
console.log("✅ OCR-End-to-End grün");
