// UIC 918-3 — Parser für DB-Tickets (Aztec-Barcode, "#UT"-Header, zlib-Payload).
// Defensiv wie der BCBP-Parser: Wir suchen den zlib-Beginn statt Signatur-Längen
// zu raten (Signaturformate variieren je Version/Carrier), und lesen aus dem
// entpackten Datensatz nur, was wir sicher verstehen: U_HEAD (Datum) und die
// S-Blöcke des 0080BL-Records (S015 Start, S016 Ziel, S001 Tarif).
// Neue FCB-/DOSIPAS-Tickets (U_FLEX) werden erkannt, aber ehrlich abgelehnt.

const td = new TextDecoder("latin1");

export function looksLikeUIC(bytes) {
  return bytes && bytes.length > 20 && bytes[0] === 0x23 && bytes[1] === 0x55 && bytes[2] === 0x54; // "#UT"
}

// Liefert {compressed: Uint8Array} oder null
export function extractCompressed(bytes) {
  // zlib-Header: 0x78 + {0x01, 0x5E, 0x9C, 0xDA}; davor stehen 4 ASCII-Ziffern (Länge)
  for (let i = 14; i < Math.min(bytes.length - 2, 200); i++) {
    if (bytes[i] !== 0x78) continue;
    if (![0x01, 0x5e, 0x9c, 0xda].includes(bytes[i + 1])) continue;
    const lenStr = td.decode(bytes.slice(i - 4, i));
    if (!/^\d{4}$/.test(lenStr)) continue;
    return { compressed: bytes.slice(i), declaredLength: parseInt(lenStr, 10) };
  }
  return null;
}

// Entpackte Payload → Records → Ticketdaten
export function parseUICPayload(payload) {
  const s = td.decode(payload);
  const records = [];
  let pos = 0;
  while (pos + 12 <= s.length) {
    const id = s.slice(pos, pos + 6);
    if (!/^[A-Z0-9_]{6}$/.test(id)) break;
    const version = s.slice(pos + 6, pos + 8);
    const length = parseInt(s.slice(pos + 8, pos + 12), 10);
    if (!Number.isFinite(length) || length < 12) break;
    records.push({ id, version, data: s.slice(pos + 12, pos + length) });
    pos += length;
  }
  if (!records.length) return null;

  if (records.some((r) => r.id === "U_FLEX")) {
    return { unsupported: "FCB" };   // neues ERA-FCB-Format (ASN.1) — noch nicht unterstützt
  }

  const out = { records: records.map((r) => r.id) };

  const head = records.find((r) => r.id === "U_HEAD");
  if (head) {
    // U_HEAD: Carrier(4) + TicketID(20) + Ausstellung DDMMYYYYHHMM(12)
    const m = head.data.slice(24, 36).match(/^(\d{2})(\d{2})(\d{4})(\d{4})$/);
    if (m) out.issued = `${m[3]}-${m[2]}-${m[1]}`;
  }

  const bl = records.find((r) => r.id === "0080BL");
  if (bl) {
    // S-Blöcke: "S" + 3 Ziffern + 4-stellige Länge + Wert, ab erster Fundstelle fortlaufend
    const fields = {};
    let i = bl.data.search(/S\d{3}\d{4}/);
    while (i >= 0 && i + 8 <= bl.data.length) {
      const fid = bl.data.slice(i, i + 4);
      const flen = parseInt(bl.data.slice(i + 4, i + 8), 10);
      if (!/^S\d{3}$/.test(fid) || !Number.isFinite(flen)) break;
      fields[fid] = bl.data.slice(i + 8, i + 8 + flen);
      i += 8 + flen;
      if (!/^S\d{3}$/.test(bl.data.slice(i, i + 4))) break;
    }
    out.fields = fields;
    if (fields.S015) out.from = fields.S015.trim();
    if (fields.S016) out.to = fields.S016.trim();
    if (fields.S001) out.tarif = fields.S001.trim();
    // Geltungsbeginn (Fahrtdatum) steht in den Trip-Daten vor den S-Blöcken: DDMMYYYY
    const trip = bl.data.match(/(\d{2})(\d{2})(\d{4})\1?/);
    if (fields.S031) {  // S031 = "Gültig ab" DD.MM.YYYY
      const g = fields.S031.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      if (g) out.travelDate = `${g[3]}-${g[2]}-${g[1]}`;
    }
  }
  return out;
}

// Bahnhofsname → Normalform für den Stations-Lookup (muss zum Build-Skript passen)
export function normStation(n) {
  return n.toLowerCase()
    .replace(/ß/g, "ss").replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/[^a-z0-9]/g, "");
}

export function findStation(stations, name) {
  const key = normStation(name);
  if (stations[key]) return stations[key];
  // Fallback: Präfix-Matching in beide Richtungen (z. B. "FrankfurtMHbf")
  for (const k of Object.keys(stations)) {
    if (k.startsWith(key) || key.startsWith(k)) return stations[k];
  }
  return null;
}

export const RAIL_DETOUR = 1.25; // Schienen-km ≈ Luftlinie × 1,25 — bewusste Näherung
