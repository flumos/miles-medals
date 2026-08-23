# Miles & Medals — Webapp-Testlabor

Konzept-Testbed für die iOS-App (Vault: `02 Projekte/Miles & Medals/`).
Boardingpass-Foto/-Screenshot rein → Barcode (PDF417/Aztec) wird **lokal im Browser**
dekodiert (ZXing WASM) → BCBP-Parsing → Reisejahr-Statistik + Ranger-Badges.
Kein Server, kein Konto — Speicherung in localStorage, Export als JSON.

- `src/bcbp.js` — IATA-BCBP-Parser + Julian-Day-Heuristik + Großkreisdistanz
- `data/airports.json` — 8.801 IATA-Flughäfen (OurAirports, Public Domain)
- `vendor/` — zxing-wasm (IIFE + wasm), lokal ausgeliefert
- `test.mjs` — Round-Trip-Test (BCBP → PDF417-PNG → Decode → Parse): `node test.mjs`

Lokal testen: `python3 -m http.server 8080` und http://localhost:8080 öffnen.
