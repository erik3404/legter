// Builds shared/airports.json from openScope airport files (MIT, (c) openScope contributors).
// Usage: node tools/extract-airports.js <openscope/assets/airports> [ourairports-csv-mappa]
// Az openScope-ban nem szereplő repterek (pl. Budapest) az OurAirports nyílt adataiból jönnek (közkincs).
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OA_DIR = process.argv[3];
// OurAirports-ból felvett repterek: kód → megjelenített név
const OA_PICK = { LHBP: 'Budapest – Liszt Ferenc' };
const PICK = {
    loww: 'Bécs – Schwechat',
    egll: 'London – Heathrow',
    eddf: 'Frankfurt am Main',
    lkpr: 'Prága – Václav Havel',
    ksfo: 'San Francisco',
    kjfk: 'New York – JFK',
    kord: 'Chicago – O\'Hare',
    katl: 'Atlanta – Hartsfield-Jackson'
};
const NM = 1852;

// Multiban minden pálya kap két közeli társrepteret: ahányan vagytok (legfeljebb 3), annyi reptér él.
// A társrepterek kifutói az OurAirports nyílt adataiból jönnek.
const SATELLITES = {
    LHBP: { LHTL: 'Tököl', LHBS: 'Budaörs' },
    LOWW: { LZIB: 'Pozsony', LZMC: 'Malacky' },
    EGLL: { EGKK: 'Gatwick', EGLC: 'London City' },
    EDDF: { ETOU: 'Wiesbaden', EDFE: 'Egelsbach' },
    LKPR: { LKVO: 'Vodochody', LKKB: 'Kbely' },
    KSFO: { KOAK: 'Oakland', KSJC: 'San José' },
    KJFK: { KLGA: 'LaGuardia', KEWR: 'Newark' },
    KORD: { KMDW: 'Midway', KDPA: 'DuPage' },
    KATL: { KPDK: 'Peachtree', KFTY: 'Fulton County' }
};
// rövid nevek a reptércímkékhez
const SHORT = {
    LHBP: 'Ferihegy', LOWW: 'Schwechat', EGLL: 'Heathrow', EDDF: 'Frankfurt', LKPR: 'Ruzyně',
    KSFO: 'San Francisco', KJFK: 'JFK', KORD: "O'Hare", KATL: 'Hartsfield-Jackson'
};

function parseCoord(s) {
    if (typeof s === 'number') return s;
    const m = /^([NSEW])(\d+(?:\.\d+)?)(?:d(\d+(?:\.\d+)?))?(?:m(\d+(?:\.\d+)?))?/.exec(s);
    if (!m) return parseFloat(s);
    let v = parseFloat(m[2]) + (parseFloat(m[3] || 0) / 60) + (parseFloat(m[4] || 0) / 3600);
    if (m[1] === 'S' || m[1] === 'W') v = -v;
    return v;
}
function parseElev(s) { return s ? parseFloat(String(s)) || 0 : 0; }

// local flat projection in nautical miles, x east, y north
function project(lat0, lon0, lat, lon) {
    const R = 6371000 / NM;
    const x = (lon - lon0) * Math.PI / 180 * Math.cos(lat0 * Math.PI / 180) * R;
    const y = (lat - lat0) * Math.PI / 180 * R;
    return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000];
}

const out = {};
const load = (icao) => JSON.parse(fs.readFileSync(path.join(SRC, `${icao}.json`), 'utf8'));
const center = (d) => [parseCoord(d.position[0]), parseCoord(d.position[1])];

function runwaysOf(d, lat0, lon0, airportIndex) {
    return d.runways.map((r) => ({
        names: r.name,
        ends: [
            project(lat0, lon0, parseCoord(r.end[0][0]), parseCoord(r.end[0][1])),
            project(lat0, lon0, parseCoord(r.end[1][0]), parseCoord(r.end[1][1]))
        ],
        airport: airportIndex
    }));
}

function fixesOf(dataList, lat0, lon0, minD, maxD) {
    const seen = new Set();
    const fixes = [];
    for (const d of dataList) {
        for (const [fname, pos] of Object.entries(d.fixes || {})) {
            if (fname.startsWith('_') || !/^[A-Z]{5}$/.test(fname) || seen.has(fname)) continue;
            const p = project(lat0, lon0, parseCoord(pos[0]), parseCoord(pos[1]));
            const dist = Math.hypot(p[0], p[1]);
            if (dist > minD && dist < maxD) {
                seen.add(fname);
                fixes.push({ name: fname, pos: p });
            }
        }
    }
    return fixes;
}

for (const [icao, name] of Object.entries(PICK)) {
    const d = load(icao);
    const [lat0, lon0] = center(d);
    out[icao.toUpperCase()] = {
        icao: icao.toUpperCase(),
        name,
        lat: lat0,
        lon: lon0,
        elevation: parseElev(d.position[2]),
        runways: runwaysOf(d, lat0, lon0, 0),
        fixes: fixesOf([d], lat0, lon0, 14, 60),
        airports: [{ icao: icao.toUpperCase(), name, pos: [0, 0] }]
    };
}

// ---------- OurAirports (CSV) ----------
function parseCsv(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    const head = rows.shift();
    return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

if (OA_DIR) {
    const readCsv = (f) => parseCsv(fs.readFileSync(path.join(OA_DIR, `${f}.csv`), 'utf8'));
    const airportsCsv = readCsv('airports');
    const runwaysCsv = readCsv('runways');
    const navaidsCsv = readCsv('navaids');
    for (const [icao, name] of Object.entries(OA_PICK)) {
        const ap = airportsCsv.find((a) => a.ident === icao);
        const lat0 = Number(ap.latitude_deg);
        const lon0 = Number(ap.longitude_deg);
        const runways = runwaysCsv.filter((r) => r.airport_ident === icao && r.closed !== '1' && r.le_latitude_deg && r.he_latitude_deg)
            .map((r) => ({
                names: [r.le_ident, r.he_ident],
                ends: [
                    project(lat0, lon0, Number(r.le_latitude_deg), Number(r.le_longitude_deg)),
                    project(lat0, lon0, Number(r.he_latitude_deg), Number(r.he_longitude_deg))
                ],
                airport: 0
            }));
        // kapunevek: a környék rádiónavigációs adói (VOR, NDB)
        const fixes = [];
        for (const n of navaidsCsv) {
            if (!n.latitude_deg || !/^[A-Z]{3,5}$/.test(n.ident)) continue;
            const p = project(lat0, lon0, Number(n.latitude_deg), Number(n.longitude_deg));
            const d = Math.hypot(p[0], p[1]);
            if (d > 14 && d < 70 && !fixes.some((f) => f.name === n.ident)) fixes.push({ name: n.ident, pos: p });
        }
        out[icao] = {
            icao,
            name,
            lat: lat0,
            lon: lon0,
            elevation: Number(ap.elevation_ft) || 0,
            runways,
            fixes,
            airports: [{ icao, name, pos: [0, 0] }],
            source: 'OurAirports'
        };
    }
}

// ---------- társrepterek ----------
if (OA_DIR) {
    const readCsv = (f) => parseCsv(fs.readFileSync(path.join(OA_DIR, `${f}.csv`), 'utf8'));
    const airportsCsv = readCsv('airports');
    const runwaysCsv = readCsv('runways');
    for (const [main, sats] of Object.entries(SATELLITES)) {
        const m = out[main];
        if (!m) continue;
        m.airports[0].name = SHORT[main] || m.name;
        Object.entries(sats).forEach(([icao, label], i) => {
            const ap = airportsCsv.find((a) => a.ident === icao);
            const rws = runwaysCsv.filter((r) => r.airport_ident === icao && r.closed !== '1' && r.le_latitude_deg && r.he_latitude_deg);
            if (!ap || !rws.length) throw new Error(`Hiányzó társreptér-adat: ${icao}`);
            const pos = project(m.lat, m.lon, Number(ap.latitude_deg), Number(ap.longitude_deg));
            m.airports.push({ icao, name: label, pos });
            for (const r of rws) {
                let ends = [
                    project(m.lat, m.lon, Number(r.le_latitude_deg), Number(r.le_longitude_deg)),
                    project(m.lat, m.lon, Number(r.he_latitude_deg), Number(r.he_longitude_deg))
                ];
                // Néhány rekordban a két végpont azonos (adathiba): ilyenkor a kifutót a hosszából
                // és irányából rakjuk össze a megadott pont köré.
                const lenNm = Number(r.length_ft) / 6076.12;
                const got = Math.hypot(ends[1][0] - ends[0][0], ends[1][1] - ends[0][1]);
                if (lenNm > 0 && got < lenNm * 0.5) {
                    const hdg = Number(r.le_heading_degT) || (parseInt(r.le_ident, 10) * 10);
                    const c = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
                    const dx = Math.sin(hdg * Math.PI / 180) * lenNm / 2;
                    const dy = Math.cos(hdg * Math.PI / 180) * lenNm / 2;
                    const rnd = (v) => Math.round(v * 1000) / 1000;
                    ends = [[rnd(c[0] - dx), rnd(c[1] - dy)], [rnd(c[0] + dx), rnd(c[1] + dy)]];
                    console.log(`  javítva: ${icao} ${r.le_ident}/${r.he_ident} (${Math.round(lenNm * 1852)} m, ${hdg}°)`);
                }
                m.runways.push({ names: [r.le_ident, r.he_ident], ends, airport: i + 1 });
            }
        });
    }
}

// Budapest legyen elöl a választóban
const ordered = Object.fromEntries([...Object.keys(OA_PICK).filter((k) => out[k]), ...Object.keys(out).filter((k) => !OA_PICK[k])].map((k) => [k, out[k]]));
fs.writeFileSync(path.join(__dirname, '..', 'shared', 'airports.json'), JSON.stringify(ordered));
for (const a of Object.values(ordered)) console.log(a.icao, a.airports.map((x) => `${x.icao}@${x.pos.map((v) => v.toFixed(1))}`).join(' '), 'kifutók:', a.runways.length, 'fixek:', a.fixes.length);
