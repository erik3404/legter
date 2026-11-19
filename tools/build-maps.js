// Háttértérképek építése reptérenként.
// Források: Natural Earth 1:10m (közkincs) és openScope terepadatok (MIT).
// Használat: node tools/build-maps.js <natural-earth-geojson-mappa> <openscope/assets/airports/terrain>
const fs = require('fs');
const path = require('path');

const [NE_DIR, TERRAIN_DIR] = process.argv.slice(2);
const AIRPORTS = require('../shared/airports.json');
const OUT_DIR = path.join(__dirname, '..', 'shared', 'maps');
const NM = 1852;
const R_NM = 6371000 / NM;
const BOX = 34;          // ekkora négyzetre vágunk (nm, a középponttól)
const TOL = 0.06;        // egyszerűsítési tűrés (nm)

const load = (f) => JSON.parse(fs.readFileSync(path.join(NE_DIR, `${f}.geojson`), 'utf8')).features;
const layers = {
    land: load('ne_10m_land'),
    lakes: [...load('ne_10m_lakes'), ...load('ne_10m_lakes_europe'), ...load('ne_10m_lakes_north_america')],
    rivers: [...load('ne_10m_rivers_lake_centerlines'), ...load('ne_10m_rivers_europe'), ...load('ne_10m_rivers_north_america')],
    roads: load('ne_10m_roads'),
    urban: load('ne_10m_urban_areas'),
    places: load('ne_10m_populated_places_simple')
};

function projector(lat0, lon0) {
    const c = Math.cos(lat0 * Math.PI / 180);
    return ([lon, lat]) => [(lon - lon0) * Math.PI / 180 * c * R_NM, (lat - lat0) * Math.PI / 180 * R_NM];
}

function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let maxD = 0;
        let idx = -1;
        const [ax, ay] = pts[a];
        const [bx, by] = pts[b];
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy) || 1e-9;
        for (let i = a + 1; i < b; i++) {
            const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > tol && idx > 0) {
            keep[idx] = 1;
            stack.push([a, idx], [idx, b]);
        }
    }
    return pts.filter((_, i) => keep[i]);
}

// Sutherland–Hodgman vágás a [-BOX, BOX] négyzetre
function clipRing(ring) {
    const edges = [
        (p) => p[0] >= -BOX, (p) => p[0] <= BOX, (p) => p[1] >= -BOX, (p) => p[1] <= BOX
    ];
    const inter = [
        (a, b) => lerpAt(a, b, 0, -BOX), (a, b) => lerpAt(a, b, 0, BOX),
        (a, b) => lerpAt(a, b, 1, -BOX), (a, b) => lerpAt(a, b, 1, BOX)
    ];
    let out = ring;
    for (let e = 0; e < 4; e++) {
        const input = out;
        out = [];
        for (let i = 0; i < input.length; i++) {
            const cur = input[i];
            const prev = input[(i + input.length - 1) % input.length];
            const cIn = edges[e](cur);
            const pIn = edges[e](prev);
            if (cIn) {
                if (!pIn) out.push(inter[e](prev, cur));
                out.push(cur);
            } else if (pIn) {
                out.push(inter[e](prev, cur));
            }
        }
        if (!out.length) return [];
    }
    return out;
}
function lerpAt(a, b, axis, v) {
    const t = (v - a[axis]) / (b[axis] - a[axis]);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function clipLine(line) {
    // a négyzeten belüli darabokra bontás (a széleken egy pont ráhagyással)
    const parts = [];
    let cur = [];
    const inside = (p) => Math.abs(p[0]) <= BOX && Math.abs(p[1]) <= BOX;
    for (let i = 0; i < line.length; i++) {
        const p = line[i];
        if (inside(p) || (i > 0 && inside(line[i - 1])) || (i < line.length - 1 && inside(line[i + 1]))) cur.push(p);
        else if (cur.length) { parts.push(cur); cur = []; }
    }
    if (cur.length) parts.push(cur);
    return parts.filter((pt) => pt.length > 1);
}

const round = (pts) => pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]);

function rings(geom) {
    if (geom.type === 'Polygon') return [geom.coordinates];
    if (geom.type === 'MultiPolygon') return geom.coordinates;
    return [];
}
function lines(geom) {
    if (geom.type === 'LineString') return [geom.coordinates];
    if (geom.type === 'MultiLineString') return geom.coordinates;
    return [];
}
function bboxNear(coords, proj) {
    // gyors előszűrés fokokban
    return coords;
}

function polygons(features, proj, lat0, lon0) {
    const out = [];
    const dLat = (BOX + 5) / 60;
    const dLon = dLat / Math.cos(lat0 * Math.PI / 180);
    for (const f of features) {
        for (const poly of rings(f.geometry || {})) {
            const outer = poly[0];
            let near = false;
            for (const [lon, lat] of outer) {
                if (Math.abs(lat - lat0) < dLat * 3 && Math.abs(lon - lon0) < dLon * 3) { near = true; break; }
            }
            if (!near && outer.length > 0) {
                // nagy (pl. kontinens) poligon is lefedheti a területet csúcsok nélkül
                let minLat = 90; let maxLat = -90; let minLon = 180; let maxLon = -180;
                for (const [lon, lat] of outer) {
                    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
                    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
                }
                if (!(lat0 > minLat && lat0 < maxLat && lon0 > minLon && lon0 < maxLon)) continue;
            }
            const clipped = poly.map((ring) => simplify(clipRing(ring.map(proj)), TOL)).filter((r) => r.length >= 3);
            if (clipped.length) out.push(clipped.map(round));
        }
    }
    return out;
}

function polylines(features, proj, lat0, lon0, propsFn) {
    const out = [];
    const dLat = (BOX + 5) / 60;
    const dLon = dLat / Math.cos(lat0 * Math.PI / 180);
    for (const f of features) {
        for (const line of lines(f.geometry || {})) {
            if (!line.some(([lon, lat]) => Math.abs(lat - lat0) < dLat && Math.abs(lon - lon0) < dLon)) continue;
            for (const part of clipLine(line.map(proj))) {
                const s = simplify(part, TOL);
                if (s.length > 1) out.push(Object.assign({ p: round(s) }, propsFn ? propsFn(f.properties) : {}));
            }
        }
    }
    return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const ap of Object.values(AIRPORTS)) {
    const proj = projector(ap.lat, ap.lon);
    const map = {
        source: 'Natural Earth (public domain); terep: openScope (MIT)',
        land: polygons(layers.land, proj, ap.lat, ap.lon),
        lakes: polygons(layers.lakes, proj, ap.lat, ap.lon),
        urban: polygons(layers.urban, proj, ap.lat, ap.lon),
        rivers: polylines(layers.rivers, proj, ap.lat, ap.lon, (p) => ({ n: p.name || '' })),
        roads: polylines(layers.roads, proj, ap.lat, ap.lon, (p) => ({ m: /Major|Highway/i.test(p.type || '') || p.expressway === 1 ? 1 : 0 })),
        places: [],
        terrain: []
    };
    for (const f of layers.places) {
        const [x, y] = proj(f.geometry.coordinates);
        if (Math.abs(x) < BOX && Math.abs(y) < BOX && Math.hypot(x, y) > 3) {
            map.places.push({ n: f.properties.name, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, r: f.properties.scalerank, pop: f.properties.pop_max });
        }
    }
    const tf = path.join(TERRAIN_DIR, `${ap.icao.toLowerCase()}.geojson`);
    if (fs.existsSync(tf)) {
        const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
        for (const f of t.features) {
            const elev = f.properties.elevation;
            for (const poly of rings(f.geometry)) {
                const clipped = poly.map((ring) => simplify(clipRing(ring.map(proj)), TOL)).filter((r) => r.length >= 3);
                if (clipped.length) map.terrain.push({ e: Math.round(elev), r: clipped.map(round) });
            }
        }
    }
    const json = JSON.stringify(map);
    fs.writeFileSync(path.join(OUT_DIR, `${ap.icao}.json`), json);
    console.log(ap.icao, `${(json.length / 1024).toFixed(0)} KB`, Object.entries(map).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k}:${v.length}`).join(' '));
}
