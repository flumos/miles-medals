import { readBarcodes } from "zxing-wasm/full";
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[2];
const res = await readBarcodes(new Blob([readFileSync(file)]), { formats: ["Aztec", "PDF417", "QRCode", "DataMatrix"], tryHarder: true });
for (const r of res) {
  const b = new Uint8Array(r.bytes || []);
  console.log("Format:", r.format, "| Bytes:", b.length);
  console.log("Prefix (ASCII):", String.fromCharCode(...b.slice(0, 40)).replace(/[^\x20-\x7E]/g, "·"));
  console.log("Prefix (Hex):", [...b.slice(0, 48)].map(x => x.toString(16).padStart(2, "0")).join(" "));
  writeFileSync("/tmp/ticket_payload.bin", b);
  // Lesbare Strings im Gesamt-Payload suchen
  const s = String.fromCharCode(...b);
  const strings = s.match(/[\x20-\x7E]{5,}/g) || [];
  console.log("Lesbare Strings:", JSON.stringify(strings.slice(0, 30)));
}
