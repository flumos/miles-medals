import { extractCompressed } from "../src/uic.js";
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";

const bytes = new Uint8Array(readFileSync("/tmp/ticket_payload.bin"));
const ext = extractCompressed(bytes);
console.log("zlib gefunden, deklarierte Länge:", ext.declaredLength);
const payload = zlib.inflateSync(ext.compressed);
console.log("Entpackt:", payload.length, "Bytes");
const td = new TextDecoder("latin1");
const s = td.decode(payload);
let pos = 0;
while (pos + 12 <= s.length) {
  const id = s.slice(pos, pos + 6);
  if (!/^[A-Z0-9_]{6}$/.test(id)) break;
  const version = s.slice(pos + 6, pos + 8);
  const length = parseInt(s.slice(pos + 8, pos + 12), 10);
  console.log(`\nRecord ${id} v${version}, ${length} Bytes`);
  const data = payload.slice(pos + 12, pos + length);
  if (id === "U_FLEX") {
    writeFileSync("/tmp/uflex.bin", data);
    // Hexdump der ersten 160 Bytes
    for (let i = 0; i < Math.min(data.length, 160); i += 16) {
      const chunk = [...data.slice(i, i + 16)];
      const hex = chunk.map(x => x.toString(16).padStart(2, "0")).join(" ");
      const asc = chunk.map(x => x >= 32 && x < 127 ? String.fromCharCode(x) : "·").join("");
      console.log(i.toString().padStart(4), hex.padEnd(48), asc);
    }
    console.log("U_FLEX gesamt:", data.length, "Bytes → /tmp/uflex.bin");
    // Bit-verschobene String-Suche: Payload bei jedem der 8 Bit-Offsets als ASCII interpretieren
    for (let shift = 0; shift < 8; shift++) {
      let out = "";
      for (let i = 0; i + 1 < data.length; i++) {
        const v = ((data[i] << 8 | data[i + 1]) >> (8 - shift)) & 0xff;
        out += (v >= 32 && v < 127) ? String.fromCharCode(v) : "·";
      }
      const hits = out.match(/[A-Za-z (){}\/.\-]{6,}/g) || [];
      if (hits.length) console.log(`Bit-Offset ${shift}:`, JSON.stringify(hits.slice(0, 12)));
    }
  } else {
    console.log("  (Inhalt):", td.decode(data).slice(0, 80).replace(/[^\x20-\x7E]/g, "·"));
  }
  pos += length;
}
