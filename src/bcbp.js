// IATA BCBP (Bar Coded Boarding Pass, Resolution 792) — Parser für den Mandatory-Teil.
// Defensiv: Pflichtfelder strikt, Conditional-Sektion wird nur übersprungen (Längen-Hex),
// nie interpretiert. Kein Jahr im Barcode — Julian Day + Jahresannahme passiert im Aufrufer.

export function parseBCBP(raw) {
  const s = String(raw);
  if (s.length < 60 || s[0] !== "M") return null;
  const legsCount = parseInt(s[1], 10);
  if (!(legsCount >= 1 && legsCount <= 4)) return null;

  const name = s.slice(2, 22).trim();          // NACHNAME/VORNAME, auf 20 Zeichen gekürzt
  const eticket = s[22];
  const legs = [];
  let p = 23;

  for (let i = 0; i < legsCount; i++) {
    if (s.length < p + 37) return null;        // Mandatory-Block je Leg: 37 Zeichen
    const pnr      = s.slice(p, p + 7).trim();
    const from     = s.slice(p + 7, p + 10).trim().toUpperCase();
    const to       = s.slice(p + 10, p + 13).trim().toUpperCase();
    const carrier  = s.slice(p + 13, p + 16).trim();
    const flightNo = s.slice(p + 16, p + 21).trim();
    const julian   = parseInt(s.slice(p + 21, p + 24), 10);
    const compartment = s[p + 24];
    const seat     = s.slice(p + 25, p + 29).trim();
    const sequence = s.slice(p + 29, p + 34).trim();
    const status   = s[p + 34];
    const varSizeHex = s.slice(p + 35, p + 37);
    const varSize = parseInt(varSizeHex, 16);
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return null;
    if (Number.isNaN(varSize)) return null;

    legs.push({ pnr, from, to, carrier, flightNo, julianDay: Number.isNaN(julian) ? null : julian,
                compartment, seat, sequence, status });
    p += 37 + varSize;                         // Conditional-Teil tolerant überspringen
  }
  return { name, eticket, legs };
}

// Julian Day → Datum. Annahme: aktuelles Jahr; liegt der Tag mehr als 2 Tage in der
// Zukunft, war es vergangenes Jahr (alter Pass). Aufrufer darf überschreiben.
export function julianToDate(julianDay, refDate = new Date()) {
  if (!julianDay) return null;
  const year = refDate.getFullYear();
  const mk = (y) => {
    const d = new Date(Date.UTC(y, 0, 1));
    d.setUTCDate(julianDay);
    return d;
  };
  let d = mk(year);
  const diffDays = (d - refDate) / 86400000;
  if (diffDays > 2) d = mk(year - 1);
  return d;
}

// Großkreisdistanz in km
export function greatCircleKm(a, b) {
  const r = Math.PI / 180;
  const [la1, lo1] = [a[0] * r, a[1] * r];
  const [la2, lo2] = [b[0] * r, b[1] * r];
  const x = Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return Math.round(6371 * Math.acos(Math.min(1, Math.max(-1, x))));
}
