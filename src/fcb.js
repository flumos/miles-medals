// FCB (ERA Flexible Content Barcode, U_FLEX) — heuristischer Leser fürs Testlabor.
// FCB ist ASN.1/UPER-bitgepackt; ein vollständiger Decoder kommt in der nativen App.
// Hier: Strings stehen byte-weise im Bitstrom, nur um 0–7 Bit verschoben. Wir lesen
// alle 8 Verschiebungen UTF-8-bewusst aus und matchen Kandidaten gegen die
// Bahnhofs-Datenbank. Ergebnis ist als Heuristik gekennzeichnet; das Reisedatum
// liefert FCB nicht lesbar — es bleibt Sache des Bestätigungs-Schritts.

import { normStation } from "./uic.js";

const utf8 = new TextDecoder("utf-8", { fatal: false });

// Alle Bit-Verschiebungen des Bitstroms als Byte-Sichten
export function bitShiftedViews(data) {
  const views = [data];
  for (let shift = 1; shift < 8; shift++) {
    const out = new Uint8Array(data.length - 1);
    for (let i = 0; i + 1 < data.length; i++) {
      out[i] = ((data[i] << 8) | data[i + 1]) >> (8 - shift) & 0xff;
    }
    views.push(out);
  }
  return views;
}

// Lesbare String-Kandidaten (UTF-8-tauglich) je Verschiebung, in Stream-Reihenfolge
export function extractCandidates(data) {
  const all = [];
  bitShiftedViews(data).forEach((view, shift) => {
    let run = [];
    const flush = (endPos) => {
      if (run.length >= 5) {
        const text = utf8.decode(new Uint8Array(run)).replace(/�/g, "");
        const letters = (text.match(/[A-Za-zÄÖÜäöüß]/g) || []).length;
        if (letters >= 4) all.push({ text: text.trim(), shift, pos: endPos - run.length });
      }
      run = [];
    };
    for (let i = 0; i < view.length; i++) {
      const b = view[i];
      const ok = (b >= 0x20 && b < 0x7f) || b >= 0x80;  // ASCII sichtbar oder UTF-8-Fortsetzung
      if (ok) run.push(b); else flush(i);
    }
    flush(view.length);
  });
  return all;
}

// Bester Stations-Treffer mit Ranking: exakt > „Hbf"-Präfix > kürzester Schlüssel
export function findStationBest(stations, name) {
  const key = normStation(name);
  if (key.length < 5) return null;
  if (stations[key]) return { station: stations[key], quality: 3 };
  let best = null;
  for (const k of Object.keys(stations)) {
    if (!(k.startsWith(key) || (key.startsWith(k) && k.length >= 6))) continue;
    const q = (k.includes("hbf") ? 2 : 1) + Math.min(k.length, key.length) / 100 - Math.abs(k.length - key.length) / 200;
    if (!best || q > best.q) best = { station: stations[k], quality: 1, q };
  }
  return best;
}

// Kandidaten → Reise (from/to) raten. Null, wenn keine zwei Bahnhöfe erkennbar sind.
export function guessJourney(data, stations) {
  const cands = extractCandidates(data);
  // Direkter Treffer: "A<->B" in einem Kandidaten
  for (const c of cands) {
    const m = c.text.split(/<->|<>/);
    if (m.length === 2) {
      const a = findStationBest(stations, m[0].replace(/\+/g, " "));
      const b = findStationBest(stations, m[1].replace(/\+/g, " "));
      if (a && b) return { from: a.station, to: b.station, tarif: findTarif(cands), method: "route-string" };
    }
  }
  // Sonst: pro Verschiebung Stations-Matches in Stream-Reihenfolge suchen
  for (let shift = 0; shift < 8; shift++) {
    const hits = [];
    for (const c of cands.filter((c) => c.shift === shift).sort((x, y) => x.pos - y.pos)) {
      // DB-Zusätze abschneiden: "&Via:…", "+City", "+"-Leerzeichen, Klammer-Reste
      const base = c.text.split(/&?Via:/i)[0].replace(/\+City.*$/i, "").trim();
      const variants = [base, base.replace(/\+/g, " "), c.text, base.replace(/\(.*$/, "")];
      for (const v of variants) {
        const hit = findStationBest(stations, v);
        if (hit) { hits.push({ ...hit, pos: c.pos, text: c.text }); break; }
      }
    }
    const uniq = [];
    for (const h of hits) if (!uniq.some((u) => u.station[2] === h.station[2])) uniq.push(h);
    if (uniq.length >= 2) {
      return { from: uniq[0].station, to: uniq[1].station, tarif: findTarif(cands), method: `bit-shift-${shift}` };
    }
  }
  return null;
}

function findTarif(cands) {
  const hit = cands.find((c) => /flex|sparpreis|super sparpreis|flexpreis|business/i.test(c.text));
  return hit ? hit.text.replace(/[^ -~ÄÖÜäöüß ]/g, "").trim() : "";
}
