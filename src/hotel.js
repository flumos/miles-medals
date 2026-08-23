// Hotelbestätigungs-Parser (OCR-Text → Übernachtung). Heuristik fürs Testlabor:
// Datumspaare über Check-in/Anreise-Schlüsselwörter, Hotelname über Marken-/Gattungswörter,
// Stadt über Abgleich mit den lokalen Orts-Datenbanken. Alles bleibt editierbar —
// die Heuristik füllt nur vor, der Nutzer bestätigt.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, mae: 3, mär: 3, apr: 4, mai: 5, may: 5, jun: 6, jul: 7,
  aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12,
};

const iso = (y, m, d) => {
  y = +y; m = +m; d = +d;
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

// Alle Datumsangaben mit Textposition
export function findDates(text) {
  const out = [];
  for (const m of text.matchAll(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/g)) {
    const d = iso(m[3], m[2], m[1]); if (d) out.push({ iso: d, index: m.index });
  }
  for (const m of text.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    const d = iso(m[1], m[2], m[3]); if (d) out.push({ iso: d, index: m.index });
  }
  // „24. August 2026" / „24 Aug 2026"
  for (const m of text.matchAll(/(\d{1,2})\.?\s*([A-Za-zÄÖÜäöü]{3,9})\.?\s*(\d{4})/g)) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) { const d = iso(m[3], mo, m[1]); if (d) out.push({ iso: d, index: m.index }); }
  }
  // „Aug 24, 2026"
  for (const m of text.matchAll(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/g)) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) { const d = iso(m[3], mo, m[2]); if (d) out.push({ iso: d, index: m.index }); }
  }
  return out.sort((a, b) => a.index - b.index);
}

const nearestAfter = (dates, kwIndex) =>
  dates.filter((d) => d.index >= kwIndex && d.index - kwIndex < 80)[0]
  || dates.filter((d) => Math.abs(d.index - kwIndex) < 80).sort((a, b) => Math.abs(a.index - kwIndex) - Math.abs(b.index - kwIndex))[0];

export function pickStayDates(text) {
  const dates = findDates(text);
  if (!dates.length) return null;
  const inKw = text.search(/check.?in|anreise|arrival|ankunft/i);
  const outKw = text.search(/check.?out|abreise|departure/i);
  let from = inKw >= 0 ? nearestAfter(dates, inKw) : null;
  let to = outKw >= 0 ? nearestAfter(dates, outKw) : null;
  if (from && to && from.iso < to.iso) return { from: from.iso, to: to.iso };
  // Fallback: erstes chronologisches Paar mit 1–30 Nächten
  const uniq = [...new Set(dates.map((d) => d.iso))].sort();
  for (let i = 0; i < uniq.length - 1; i++) {
    const nights = (new Date(uniq[i + 1]) - new Date(uniq[i])) / 86400000;
    if (nights >= 1 && nights <= 30) return { from: uniq[i], to: uniq[i + 1] };
  }
  return null;
}

const HOTEL_RE = /\b(hotel|motel|hostel|resort|inn|marriott|hilton|hyatt|ibis|mercure|novotel|intercity|steigenberger|lindner|moxy|adina|ruby|25hours|courtyard|residence|hampton|premier inn|leonardo|dorint|maritim|scandic|radisson|westin|sheraton|aloft|element|gasthof|pension|b&b)\b/i;

export function findHotelName(text) {
  for (const raw of text.split(/\n+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 4 || line.length > 70) continue;
    if (/ihre buchung|bestätigung|confirmation|reservierung|rechnung|gesamtpreis/i.test(line)) continue;
    if (HOTEL_RE.test(line)) return line;
  }
  return "";
}

// Stadt über bekannte Ortsnamen (Bahnhofs-/Flughafen-Städte) im Text finden
export function findCity(text, cityNames) {
  const low = text.toLowerCase();
  let best = "";
  for (const city of cityNames) {
    if (!city || city.length < 4) continue;
    const probe = city.toLowerCase();
    const first = probe.split(" ")[0];
    if (low.includes(probe)) { if (city.length > best.length) best = city; }
    else if (first.length >= 5 && low.includes(first) && !best) best = city.split(" ")[0];
  }
  return best;
}

export function parseHotelText(text, cityNames) {
  const dates = pickStayDates(text);
  if (!dates) return null;
  return { hotel: findHotelName(text), city: findCity(text, cityNames), ...dates };
}
