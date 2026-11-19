// Builds shared/airports.json from openScope airport files (MIT, (c) openScope contributors).
// Usage: node tools/extract-airports.js <openscope/assets/airports> 
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
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
for (const [icao, name] of Object.entries(PICK)) {
    const d = JSON.parse(fs.readFileSync(path.join(SRC, `${icao}.json`), 'utf8'));
    const lat0 = parseCoord(d.position[0]);
    const lon0 = parseCoord(d.position[1]);
    const runways = [];
    for (const r of d.runways) {
        const a = project(lat0, lon0, parseCoord(r.end[0][0]), parseCoord(r.end[0][1]));
        const b = project(lat0, lon0, parseCoord(r.end[1][0]), parseCoord(r.end[1][1]));
        runways.push({ names: r.name, ends: [a, b] });
    }
    const fixes = [];
    for (const [fname, pos] of Object.entries(d.fixes || {})) {
        if (fname.startsWith('_') || !/^[A-Z]{5}$/.test(fname)) continue;
        const p = project(lat0, lon0, parseCoord(pos[0]), parseCoord(pos[1]));
        const dist = Math.hypot(p[0], p[1]);
        if (dist > 14 && dist < 60) fixes.push({ name: fname, pos: p });
    }
    out[icao.toUpperCase()] = {
        icao: icao.toUpperCase(),
        name,
        lat: lat0,
        lon: lon0,
        elevation: parseElev(d.position[2]),
        runways,
        fixes
    };
}
fs.writeFileSync(path.join(__dirname, '..', 'shared', 'airports.json'), JSON.stringify(out));
for (const a of Object.values(out)) console.log(a.icao, a.runways.map((r) => r.names.join('/')).join(' '), 'fixes:', a.fixes.length);
