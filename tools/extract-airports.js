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

// Többrepteres pályák a „Saját reptér” multi módhoz: ahányan játszotok (legfeljebb 3), annyi reptér él.
const CLUSTERS = {
    LONDON: { name: 'London – 3 reptér', members: { egll: 'Heathrow', egkk: 'Gatwick', eglc: 'London City' } },
    NEWYORK: { name: 'New York – 2 reptér', members: { kjfk: 'JFK', kewr: 'Newark' } },
    WASHINGTON: { name: 'Washington – 2 reptér', members: { kiad: 'Dulles', kdca: 'Reagan National' } },
    TOKYO: { name: 'Tokió – 2 reptér', members: { rjtt: 'Haneda', rjaa: 'Narita' } }
};
const CLUSTER_AIRSPACE = { hw: 32, hh: 20 };

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

for (const [key, cl] of Object.entries(CLUSTERS)) {
    const members = Object.entries(cl.members).map(([icao, label]) => ({ icao, label, d: load(icao) }));
    const lat0 = members.reduce((s2, m) => s2 + center(m.d)[0], 0) / members.length;
    const lon0 = members.reduce((s2, m) => s2 + center(m.d)[1], 0) / members.length;
    const runways = [];
    members.forEach((m, i) => runways.push(...runwaysOf(m.d, lat0, lon0, i)));
    out[key] = {
        icao: key,
        name: cl.name,
        lat: lat0,
        lon: lon0,
        elevation: 0,
        cluster: true,
        airspace: CLUSTER_AIRSPACE,
        runways,
        fixes: fixesOf(members.map((m) => m.d), lat0, lon0, 18, 70),
        airports: members.map((m) => {
            const [la, lo] = center(m.d);
            return { icao: m.icao.toUpperCase(), name: m.label, pos: project(lat0, lon0, la, lo) };
        })
    };
}
// Budapest legyen elöl a választóban
const ordered = Object.fromEntries([...Object.keys(OA_PICK).filter((k) => out[k]), ...Object.keys(out).filter((k) => !OA_PICK[k])].map((k) => [k, out[k]]));
fs.writeFileSync(path.join(__dirname, '..', 'shared', 'airports.json'), JSON.stringify(ordered));
for (const a of Object.values(ordered)) console.log(a.icao, a.airports.map((x) => `${x.icao}@${x.pos.map((v) => v.toFixed(1))}`).join(' '), 'kifutók:', a.runways.length, 'fixek:', a.fixes.length);
