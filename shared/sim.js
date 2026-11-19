'use strict';
// Légtér – szerveroldali szimuláció.
// Koordináták tengeri mérföldben (nm): x kelet, y észak. Irány fokban, 0 = észak, óramutató szerint.
// Magasság lábban, a reptér szintjéhez képest (AGL).

const AIRPORTS = require('./airports.json');
const Rules = require('./rules');

// A légtér egy téglalap, a kapuk a szélein vannak.
const AIRSPACE = { hw: 24, hh: 14 };
const GATE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
// felül és alul középen egy-egy kapu, az oldalakon kettő-kettő
const GATE_BEARINGS = [72, 108, 180, 252, 288, 0];
const FAF_DISTANCE = 6;
const GLIDE_FT_PER_NM = 318;
// A játék gyorsított időben fut: a mozgás TIME_SCALE-szer gyorsabb a valóságosnál,
// az üzemanyag- és várakozási idők viszont valódi másodpercek.
const TIME_SCALE = 2.5;
const TURN_RATE = 3 * TIME_SCALE;            // fok/s
const CLIMB_RATE = (3000 / 60) * TIME_SCALE; // láb/s
const DESCENT_RATE = (3000 / 60) * TIME_SCALE;
const ACCEL = 2 * TIME_SCALE;                // csomó/s levegőben
const KT_TO_NMPS = TIME_SCALE / 3600;

const CLASSES = {
    turboprop: { label: 'Turbólégcsavaros', short: 'TP', cruise: 180, approach: 130 },
    jet: { label: 'Utasszállító', short: 'NB', cruise: 220, approach: 140 },
    wide: { label: 'Szélestörzsű', short: 'WB', cruise: 240, approach: 150 },
    biz: { label: 'Üzleti jet', short: 'BIZ', cruise: 250, approach: 135 }
};

const AIRLINES = [
    ['WZZ', 'jet'], ['RYR', 'jet'], ['DLH', 'jet'], ['AUA', 'jet'], ['BAW', 'wide'], ['AFR', 'jet'],
    ['KLM', 'jet'], ['UAE', 'wide'], ['QTR', 'wide'], ['LOT', 'turboprop'], ['EWG', 'jet'], ['SWR', 'jet'],
    ['UAL', 'wide'], ['DAL', 'jet'], ['THY', 'jet'], ['SAS', 'jet'], ['FIN', 'turboprop'], ['NJE', 'biz']
];

const ALT = {
    arrivalSpawn: [9000, 11000],
    approach: 3000,
    departureInitial: 5000,
    // az indulók kilépési szintje: a legközelebbi kapuig is el lehessen érni
    exitLevels: [8000, 9000, 10000, 11000],
    transit: [12000, 16000],
    min: 2000,
    max: 20000
};

const FUEL = {
    arrival: 600,
    transit: 520,
    departureGround: 300,
    departureAir: 600
};

const SEPARATION = {
    warnNm: 3, warnFt: 1000,
    lossNm: 1.5, lossFt: 800,
    crashNm: 0.3, crashFt: 300
};

const POINTS = { landed: 10, departed: 8, transited: 6, emergency: 15, incident: -20 };
const EMERGENCY_TIME = 360;

// ---------- geometria ----------
const toRad = (d) => d * Math.PI / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const angleDiff = (a, b) => { const d = norm360(b - a); return d > 180 ? d - 360 : d; };
const bearing = (from, to) => norm360(Math.atan2(to[0] - from[0], to[1] - from[1]) * 180 / Math.PI);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const fromBearing = (origin, brg, d) => [origin[0] + Math.sin(toRad(brg)) * d, origin[1] + Math.cos(toRad(brg)) * d];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// a középpontból adott irányba induló sugár és a légtér szélének metszéspontja
function edgePoint(brg) {
    const s = Math.sin(toRad(brg));
    const c = Math.cos(toRad(brg));
    const t = Math.min(Math.abs(s) > 1e-6 ? AIRSPACE.hw / Math.abs(s) : Infinity, Math.abs(c) > 1e-6 ? AIRSPACE.hh / Math.abs(c) : Infinity);
    return [s * t, c * t];
}

function insideAirspace(x, y, margin = 0) {
    return Math.abs(x) <= AIRSPACE.hw + margin && Math.abs(y) <= AIRSPACE.hh + margin;
}

function clampToAirspace(x, y) {
    return [clamp(x, -AIRSPACE.hw, AIRSPACE.hw), clamp(y, -AIRSPACE.hh, AIRSPACE.hh)];
}

function pointSegmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
    return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

class Sim {
    constructor(airportIcao = 'LOWW', shift = {}) {
        const ap = AIRPORTS[airportIcao] || AIRPORTS.LOWW;
        this.airport = ap;
        this.shift = Rules.normalizeShift(shift);
        this.rules = this.shift.rules;
        this.multiplier = Rules.scoreMultiplier(this.shift);
        this.time = 0;
        this.aircraft = [];
        this.storms = [];
        this.fogs = [];
        this.gameOver = null;
        this.events = [];
        this.stats = { landed: 0, departed: 0, transited: 0, incidents: 0, emergencies: 0, base: 0, score: 0 };
        this.incidentLog = [];
        this.nextId = 1;
        this.nextStormId = 1;
        this.usedCallsigns = new Set();
        this.lossPairs = new Set();
        this.stormHits = new Set();
        const gentle = this.shift.opening === 'gentle';
        this.openingArrivals = gentle ? 0 : 3;
        this.timers = {
            arrival: gentle ? 20 : 3,
            departure: gentle ? 70 : 40,
            transit: gentle ? 90 : 45,
            storm: rand(180, 300),
            fog: rand(120, 240),
            emergency: rand(200, 300),
            constraint: rand(240, 360)
        };
        this.gates = this._buildGates();
        this.runways = ap.runways.map((r, i) => ({
            index: i,
            names: r.names,
            ends: r.ends,
            activeEnd: 0,
            length: dist(r.ends[0], r.ends[1]),
            closingIn: 0,
            closedFor: 0
        }));
        this._chooseRunwayEndsForWind(rand(0, 360));
        if (this._wants('dep')) {
            for (let i = 0; i < (gentle ? 1 : 3); i++) this._spawnDeparture();
        }
    }

    _wants(kind) {
        return this.shift.practice === 'all' || this.shift.practice === kind;
    }

    // ---------- felépítés ----------
    _buildGates() {
        let bearings = GATE_BEARINGS;
        if (this.rules.randomGates) {
            const count = 4 + Math.floor(Math.random() * 3);
            const start = rand(0, 360);
            bearings = Array.from({ length: count }, (_, i) => norm360(start + (i * 360) / count + rand(-12, 12)));
            bearings.sort((a, b) => a - b);
        }
        const used = new Set();
        const gates = bearings.map((brg, i) => {
            const pos = edgePoint(brg);
            let best = null;
            for (const f of this.airport.fixes) {
                if (used.has(f.name)) continue;
                const diff = Math.abs(angleDiff(brg, bearing([0, 0], f.pos)));
                if (diff < 22 && (!best || diff < best.diff)) best = { name: f.name, diff };
            }
            const name = best ? best.name : `GATE${i + 1}`;
            used.add(name);
            return { letter: '', name, bearing: Math.round(brg), pos: pos.map((v) => Math.round(v * 100) / 100) };
        });
        // betűk északtól óramutató szerint
        const order = [...gates].sort((a, b) => norm360(a.bearing - 30) - norm360(b.bearing - 30));
        order.forEach((g, i) => { g.letter = GATE_LETTERS[i]; });
        return order;
    }

    _gate(letter) {
        return this.gates.find((g) => g.letter === letter);
    }

    // a kapun túli pont, merőlegesen a légtér szélére: erre célozva a gép biztosan kilép a kapun
    _gateExitTarget(gate) {
        const [x, y] = gate.pos;
        const onSide = Math.abs(Math.abs(x) - AIRSPACE.hw) < 0.05;
        return onSide ? [x + Math.sign(x) * 3, y] : [x, y + Math.sign(y) * 3];
    }

    _chooseRunwayEndsForWind(windFrom) {
        this.windFrom = Math.round(windFrom);
        for (const rw of this.runways) {
            const h0 = this.landingHeading(rw, 0);
            const h1 = this.landingHeading(rw, 1);
            rw.activeEnd = Math.abs(angleDiff(h0, windFrom)) <= Math.abs(angleDiff(h1, windFrom)) ? 0 : 1;
        }
    }

    landingHeading(rw, end = rw.activeEnd) {
        return bearing(rw.ends[end], rw.ends[1 - end]);
    }

    threshold(rw, end = rw.activeEnd) {
        return rw.ends[end];
    }

    runwayName(rw, end = rw.activeEnd) {
        return rw.names[end];
    }

    runwayOpen(rw) {
        return rw.closedFor <= 0;
    }

    // ---------- forgalom ----------
    _callsign(cls) {
        for (let tries = 0; tries < 50; tries++) {
            let cs;
            if (cls === 'biz' && Math.random() < 0.5) {
                cs = `N${Math.floor(rand(100, 999))}${String.fromCharCode(65 + Math.floor(rand(0, 26)))}${String.fromCharCode(65 + Math.floor(rand(0, 26)))}`;
            } else {
                const options = AIRLINES.filter((a) => a[1] === cls);
                const [code] = pick(options.length ? options : AIRLINES);
                cs = `${code}${Math.floor(rand(10, 9999))}`;
            }
            if (!this.usedCallsigns.has(cs)) {
                this.usedCallsigns.add(cs);
                return cs;
            }
        }
        return `X${this.nextId}`;
    }

    _randomClass() {
        const r = Math.random();
        if (r < 0.15) return 'turboprop';
        if (r < 0.7) return 'jet';
        if (r < 0.88) return 'wide';
        return 'biz';
    }

    _base(kind) {
        const cls = this._randomClass();
        const c = CLASSES[cls];
        return {
            id: this.nextId++,
            callsign: this._callsign(cls),
            kind,              // 'arr' | 'dep' | 'transit'
            cls,
            x: 0, y: 0,
            hdg: 0,
            spd: c.cruise,
            targetSpd: c.cruise,
            cruise: c.cruise,
            alt: 0,
            targetAlt: 0,
            exitAlt: 0,
            route: [],
            runway: null,
            exitGate: null,
            entryGate: null,
            state: 'airborne', // 'ground' | 'takeoff' | 'airborne' | 'final' | 'rollout'
            hold: false,
            fuel: 0,
            groundFuel: 0,
            conflict: false,
            emergency: false,
            emergencyLeft: 0,
            spawnedAt: this.time
        };
    }

    _gateClear(gate) {
        return !this.aircraft.some((a) => a.state === 'airborne' && dist([a.x, a.y], gate.pos) < 5)
            && ![...this.storms, ...this.fogs].some((s) => dist([s.x, s.y], gate.pos) < s.r + 2);
    }

    _enterAt(a, gate) {
        const inward = fromBearing(gate.pos, norm360(gate.bearing + 180), 0.5);
        a.x = inward[0];
        a.y = inward[1];
        a.entryGate = gate.letter;
    }

    _spawnArrival() {
        const gates = this.gates.filter((g) => this._gateClear(g));
        if (!gates.length) return null;
        const gate = pick(gates);
        const a = this._base('arr');
        this._enterAt(a, gate);
        a.hdg = norm360(gate.bearing + 180 + rand(-15, 15));
        a.alt = Math.round(rand(...ALT.arrivalSpawn) / 1000) * 1000;
        a.targetAlt = this.rules.altitude ? a.alt : ALT.approach;
        a.fuel = FUEL.arrival * (a.cls === 'turboprop' ? 0.85 : 1);
        this.aircraft.push(a);
        this._event('info', `${a.callsign} belépett ${gate.letter} (${gate.name}) felől, leszállásra vár.`, a.id, 'arrival');
        return a;
    }

    _spawnTransit() {
        const gates = this.gates.filter((g) => this._gateClear(g));
        if (!gates.length) return null;
        const entry = pick(gates);
        const exits = this.gates.filter((g) => Math.abs(angleDiff(g.bearing, entry.bearing)) >= 90);
        const exit = pick(exits.length ? exits : this.gates.filter((g) => g !== entry));
        const a = this._base('transit');
        this._enterAt(a, entry);
        a.hdg = this.rules.manualRouting ? norm360(entry.bearing + 180 + rand(-10, 10)) : bearing([a.x, a.y], exit.pos);
        a.alt = Math.round(rand(...ALT.transit) / 1000) * 1000;
        a.targetAlt = a.alt;
        // az átrepülő 2000–4000 lábbal a belépési szintje fölött vagy alatt lép ki
        a.exitAlt = this.rules.altitude ? clamp(a.alt + pick([-4000, -3000, -2000, 2000, 3000, 4000]), 8000, 18000) : 0;
        a.exitGate = exit.letter;
        a.fuel = FUEL.transit;
        this.aircraft.push(a);
        this._event('info', `${a.callsign} átrepülő: ${entry.letter} → ${exit.letter}${a.exitAlt ? `, kilépés ${a.exitAlt / 100} szinten` : ''}.`, a.id, 'transit');
        return a;
    }

    _spawnDeparture() {
        const a = this._base('dep');
        const gate = pick(this.gates);
        a.state = 'ground';
        a.spd = 0;
        a.targetSpd = 0;
        a.alt = 0;
        a.exitAlt = this.rules.altitude ? pick(ALT.exitLevels) : 0;
        a.targetAlt = this.rules.altitude ? ALT.departureInitial : 9000;
        a.exitGate = gate.letter;
        a.groundFuel = FUEL.departureGround;
        a.fuel = FUEL.departureAir;
        a.runway = this._bestRunwayFor(gate.pos);
        this.aircraft.push(a);
        this._event('dep', `${a.callsign} felszállásra kész: ${this.runwayName(this.runways[a.runway])}, kijárat ${gate.letter}.`, a.id, 'depReady');
        return a;
    }

    _bestRunwayFor(pos) {
        const target = bearing([0, 0], pos);
        let best = null;
        let bestDiff = 999;
        for (const rw of this.runways) {
            if (!this.runwayOpen(rw) || rw.closingIn > 0) continue;
            const diff = Math.abs(angleDiff(this.landingHeading(rw), target));
            if (diff < bestDiff) { bestDiff = diff; best = rw.index; }
        }
        return best == null ? 0 : best;
    }

    _trafficLevel() {
        const minutes = this.time / 60 - (this.shift.opening === 'gentle' ? 4 : 0);
        const factor = 1 / (this.shift.traffic / 100);
        return {
            arrival: clamp(55 - minutes * 1.5, 28, 70) * factor,
            departure: clamp(60 - minutes * 1.2, 32, 80) * factor,
            transit: clamp(110 - minutes * 2, 60, 140) * factor
        };
    }

    _spawnTick(dt) {
        const level = this._trafficLevel();
        const kinds = { arrival: 'arr', departure: 'dep', transit: 'transit' };
        for (const key of ['arrival', 'departure', 'transit']) {
            if (!this._wants(kinds[key])) continue;
            this.timers[key] -= dt;
            if (this.timers[key] > 0) continue;
            let ok;
            if (key === 'arrival') ok = this._spawnArrival();
            else if (key === 'transit') ok = this._spawnTransit();
            else ok = this.aircraft.filter((a) => a.state === 'ground').length < 6 ? this._spawnDeparture() : true;
            if (ok && key === 'arrival' && this.openingArrivals > 0) {
                this.openingArrivals -= 1;
                this.timers[key] = rand(10, 13);
            } else {
                this.timers[key] = ok ? level[key] * rand(0.8, 1.2) : 5;
            }
        }
    }

    // ---------- események ----------
    // sound: a kliens melyik hangot játssza le (arrival, transit, depReady, good, incident, emergency, warn)
    _event(kind, text, aircraftId = null, sound = null) {
        this.events.push({ t: Math.round(this.time), kind, text, aircraftId, sound });
    }

    _addPoints(p) {
        this.stats.base += p;
        this.stats.score = Math.round(this.stats.base * this.multiplier);
    }

    _incident(a, reason, callsign) {
        this.stats.incidents += 1;
        this._addPoints(POINTS.incident);
        const cs = callsign || (a ? a.callsign : '');
        this.incidentLog.push({ t: Math.round(this.time), callsign: cs, reason });
        this._event('incident', `INCIDENS: ${cs ? `${cs} – ` : ''}${reason}`, a ? a.id : null, 'incident');
    }

    _remove(a) {
        this.aircraft = this.aircraft.filter((x) => x !== a);
        this.usedCallsigns.delete(a.callsign);
    }

    find(id) {
        return this.aircraft.find((a) => a.id === id);
    }

    // ---------- kifutó-foglaltság ----------
    runwayBusy(rwIndex, ignore = null) {
        return this.aircraft.some((a) => {
            if (a === ignore || a.runway !== rwIndex) return false;
            if (a.state === 'rollout' || a.state === 'takeoff') return true;
            if (a.state === 'final') {
                const rw = this.runways[rwIndex];
                return dist([a.x, a.y], this.threshold(rw)) < 3;
            }
            return false;
        });
    }

    // ---------- parancsok ----------
    // Minden parancs [ok, üzenet] párt ad vissza.
    command(cmd) {
        const a = cmd.id != null ? this.find(cmd.id) : null;
        if (a && a.fogged && a.state === 'airborne') return [false, `${a.callsign} ködben van, nem tudja, hol jár – amíg ki nem ér, nem irányítható.`];
        switch (cmd.type) {
            case 'addWaypoint': return this._cmdAddWaypoint(a, cmd);
            case 'moveWaypoint': return this._cmdMoveWaypoint(a, cmd);
            case 'removeWaypoint': return this._cmdRemoveWaypoint(a, cmd);
            case 'replaceRoute': return this._cmdReplaceRoute(a, cmd);
            case 'runway': return this._cmdRunway(a, cmd);
            case 'takeoff': return this._cmdTakeoff(a);
            case 'hold': return this._cmdHold(a);
            case 'goAround': return this._cmdGoAround(a);
            case 'speed': return this._cmdSpeed(a, cmd);
            case 'altitude': return this._cmdAltitude(a, cmd);
            case 'flipRunway': return this._cmdFlipRunway(cmd);
            default: return [false, 'Ismeretlen parancs.'];
        }
    }

    _isAirborneControllable(a) {
        return a && (a.state === 'airborne' || a.state === 'final');
    }

    _routeEndpoint(a) {
        if (a.kind === 'arr' && a.runway != null) {
            const rw = this.runways[a.runway];
            return fromBearing(this.threshold(rw), norm360(this.landingHeading(rw) + 180), FAF_DISTANCE);
        }
        if (a.exitGate) return this._gate(a.exitGate).pos;
        return null;
    }

    _cmdAddWaypoint(a, { x, y, index }) {
        if (!a || a.state === 'rollout' || a.state === 'ground') return [false, 'Ennek a gépnek most nem adható útpont.'];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return [false, null];
        const p = clampToAirspace(x, y);
        if (a.state === 'final') a.state = 'airborne';
        if (typeof index === 'number') {
            a.route.splice(clamp(index, 0, a.route.length), 0, p);
        } else {
            // a legkisebb kerülőt okozó helyre szúrjuk be
            const pts = [[a.x, a.y], ...a.route];
            const end = this._routeEndpoint(a);
            if (end) pts.push(end);
            let bestIdx = a.route.length;
            let bestCost = Infinity;
            for (let i = 0; i < pts.length - 1; i++) {
                const cost = dist(pts[i], p) + dist(p, pts[i + 1]) - dist(pts[i], pts[i + 1]);
                if (cost < bestCost) { bestCost = cost; bestIdx = i; }
            }
            if (!end) bestIdx = a.route.length;
            a.route.splice(bestIdx, 0, p);
        }
        if (a.route.length > 12) a.route.length = 12;
        a.hold = false;
        return [true, null];
    }

    _cmdMoveWaypoint(a, { index, x, y }) {
        if (!a || !a.route[index] || !Number.isFinite(x) || !Number.isFinite(y)) return [false, null];
        a.route[index] = clampToAirspace(x, y);
        return [true, null];
    }

    _cmdRemoveWaypoint(a, { index }) {
        if (!a || !a.route[index]) return [false, null];
        a.route.splice(index, 1);
        return [true, null];
    }

    _cmdReplaceRoute(a, { x, y }) {
        if (!a || a.state === 'rollout' || a.state === 'ground' || !Number.isFinite(x) || !Number.isFinite(y)) return [false, null];
        if (a.state === 'final') a.state = 'airborne';
        a.route = [clampToAirspace(x, y)];
        a.hold = false;
        return [true, null];
    }

    _cmdRunway(a, { runway }) {
        if (!a) return [false, 'Nincs kijelölt gép.'];
        const rw = this.runways[runway];
        if (!rw) return [false, 'Nincs ilyen kifutó.'];
        if (!this.runwayOpen(rw)) return [false, `${this.runwayName(rw)} le van zárva.`];
        if (a.kind === 'transit') return [false, `${a.callsign} átrepülő, nem száll le.`];
        if (a.kind === 'dep') {
            if (a.state !== 'ground') return [false, `${a.callsign} már a levegőben van.`];
            a.runway = runway;
            return [true, `${a.callsign} felszálláshoz: ${this.runwayName(rw)}.`];
        }
        if (a.state === 'rollout') return [false, null];
        a.runway = runway;
        if (a.state === 'final') a.state = 'airborne';
        // magasság nélküli játékban automatikusan süllyed a megközelítéshez
        if (!this.rules.altitude && a.targetAlt > ALT.approach) a.targetAlt = ALT.approach;
        return [true, `${a.callsign} leszállásra engedélyezve: ${this.runwayName(rw)}.`];
    }

    _cmdTakeoff(a) {
        if (!a || a.kind !== 'dep' || a.state !== 'ground') return [false, 'Csak földön váró induló szállhat fel.'];
        const rw = this.runways[a.runway];
        if (!this.runwayOpen(rw)) return [false, `${this.runwayName(rw)} le van zárva, válassz másik kifutót.`];
        if (this.runwayBusy(a.runway)) return [false, `${this.runwayName(rw)} foglalt, ${a.callsign} vár.`];
        const thr = this.threshold(rw);
        a.state = 'takeoff';
        a.x = thr[0];
        a.y = thr[1];
        a.hdg = this.landingHeading(rw);
        a.spd = 0;
        a.targetSpd = a.cruise;
        a.alt = 0;
        a.takeoffEnd = this.threshold(rw, 1 - rw.activeEnd);
        return [true, `${a.callsign} felszállhat, ${this.runwayName(rw)}.`];
    }

    _cmdHold(a) {
        if (!this._isAirborneControllable(a)) return [false, null];
        a.hold = !a.hold;
        if (a.hold && a.state === 'final') a.state = 'airborne';
        return [true, a.hold ? `${a.callsign} várakozó körözés.` : `${a.callsign} folytatja az útvonalat.`];
    }

    _cmdGoAround(a) {
        if (!a || a.kind !== 'arr' || a.state !== 'final') return [false, 'Átstartolás csak végső megközelítésen.'];
        this._goAround(a, 'utasításra');
        return [true, null];
    }

    _cmdSpeed(a, { delta, to }) {
        if (!this._isAirborneControllable(a) || a.state === 'final') return [false, 'A sebesség most automatikus.'];
        const lo = Math.round(a.cruise * 0.8);
        const hi = Math.round(a.cruise * 1.2);
        if (to === 'max') a.targetSpd = hi;
        else if (to === 'min') a.targetSpd = lo;
        else if (to === 'reset') a.targetSpd = a.cruise;
        else a.targetSpd = clamp(a.targetSpd + (Number(delta) || 0), lo, hi);
        return [true, null];
    }

    _cmdAltitude(a, { delta, to }) {
        if (!this.rules.altitude) return [false, 'A magasság ebben a műszakban automatikus (Szabályok → Magasság).'];
        if (!a || !(a.state === 'airborne' || a.state === 'takeoff')) return [false, 'A magasság most automatikus.'];
        const max = a.kind === 'arr' ? 12000 : ALT.max;
        if (to === 'max') a.targetAlt = max;
        else if (to === 'min') a.targetAlt = ALT.min;
        else a.targetAlt = clamp(a.targetAlt + (Number(delta) || 0), ALT.min, max);
        return [true, null];
    }

    _cmdFlipRunway({ runway }) {
        const rw = this.runways[runway];
        if (!rw) return [false, null];
        const touched = this.runways.filter((r) => Math.abs(angleDiff(this.landingHeading(r), this.landingHeading(rw))) < 20
            || Math.abs(angleDiff(this.landingHeading(r), this.landingHeading(rw))) > 160);
        for (const r of touched) {
            if (this.aircraft.some((a) => a.runway === r.index && ['takeoff', 'final', 'rollout'].includes(a.state))) {
                return [false, `${this.runwayName(r)} használatban, most nem fordítható.`];
            }
        }
        for (const r of touched) r.activeEnd = 1 - r.activeEnd;
        return [true, `Üzemi irány váltás: ${touched.map((r) => this.runwayName(r)).join(', ')}.`];
    }

    _goAround(a, reason) {
        const rw = this.runways[a.runway];
        const hdg = this.landingHeading(rw);
        const far = this.threshold(rw, 1 - rw.activeEnd);
        const p1 = fromBearing(far, hdg, 2.5);
        const p2 = fromBearing(p1, norm360(hdg + 90), 4);
        const p3 = fromBearing(fromBearing(this.threshold(rw), norm360(hdg + 180), 11), norm360(hdg + 90), 4);
        a.state = 'airborne';
        a.route = [p1, p2, p3].map((p) => clampToAirspace(p[0], p[1]));
        a.targetAlt = ALT.approach;
        a.targetSpd = a.cruise;
        a.hold = false;
        this._event('warn', `${a.callsign} átstartol (${reason}).`, a.id);
    }

    // ---------- lépés ----------
    step(dt) {
        this.time += dt;
        this._spawnTick(dt);
        this._weatherTick(dt);
        if (this.rules.emergencies) this._emergencyTick(dt);
        if (this.rules.constraints) this._constraintTick(dt);
        this._runwayTick(dt);
        for (const a of [...this.aircraft]) this._updateAircraft(a, dt);
        this._checkSeparation();
        this._checkStorms();
    }

    // ---------- időjárás: zivatar és köd ----------
    // Mindkettő kicsi, lassan sodródik, és egyszerre legfeljebb egy-egy lehet a légtérben.
    _spawnWeather(kind) {
        const r = kind === 'storm' ? rand(2.5, 3.5) : rand(2, 3.5);
        // a légtér belsejében, de a reptértől távolabb jelenik meg, és lassan befelé sodródik
        let pos;
        for (let tries = 0; tries < 20; tries++) {
            pos = [rand(-AIRSPACE.hw + r, AIRSPACE.hw - r), rand(-AIRSPACE.hh + r, AIRSPACE.hh - r)];
            const busy = this.aircraft.some((a) => a.state !== 'ground' && dist([a.x, a.y], pos) < r + 3);
            if (Math.hypot(pos[0], pos[1]) > 9 && !busy) break;
        }
        const cell = {
            id: this.nextStormId++,
            x: pos[0], y: pos[1],
            r,
            hdg: norm360(bearing(pos, [0, 0]) + rand(-70, 70)),
            spd: rand(0.006, 0.012), // nm/s – nagyon lassú
            age: 0,
            life: kind === 'storm' ? rand(600, 900) : rand(500, 800),
            turnIn: rand(90, 180)
        };
        if (kind === 'storm') {
            this.storms.push(cell);
            this._event('warn', 'Zivatar alakult ki a légtérben. A piros magba repülés a műszak végét jelenti!', null, 'warn');
        } else {
            this.fogs.push(cell);
            this._event('warn', 'Köd ereszkedett le. A benne repülő gépek nem irányíthatók, amíg ki nem érnek.', null, 'warn');
        }
    }

    _driftCells(cells, dt) {
        for (const c of cells) {
            c.age += dt;
            c.turnIn -= dt;
            if (c.turnIn <= 0) {
                c.turnIn = rand(90, 180);
                c.hdg = norm360(c.hdg + rand(-30, 30));
                c.spd = clamp(c.spd * rand(0.8, 1.2), 0.004, 0.014);
            }
            c.x += Math.sin(toRad(c.hdg)) * c.spd * dt;
            c.y += Math.cos(toRad(c.hdg)) * c.spd * dt;
        }
        return cells.filter((c) => c.age < c.life && insideAirspace(c.x, c.y, c.r));
    }

    _weatherTick(dt) {
        if (this.rules.storms) {
            this.timers.storm -= dt;
            if (this.timers.storm <= 0) {
                this.timers.storm = rand(360, 600);
                if (!this.storms.length) this._spawnWeather('storm');
            }
        }
        if (this.rules.fog) {
            this.timers.fog -= dt;
            if (this.timers.fog <= 0) {
                this.timers.fog = rand(360, 600);
                if (!this.fogs.length) this._spawnWeather('fog');
            }
        }
        this.storms = this._driftCells(this.storms, dt);
        this.fogs = this._driftCells(this.fogs, dt);
    }

    // a zivatar rétegei: külső (zöld) és középső (sárga) átrepülhető, a mag (piros) nem
    _stormCore(s) {
        // születéskor és a vége felé a mag kisebb, az utolsó 10%-ban eltűnik
        const f = s.age / s.life;
        if (f > 0.9) return 0;
        const grow = clamp(s.age / 60, 0.4, 1);
        return s.r * 0.3 * grow;
    }

    inFog(x, y) {
        return this.fogs.some((f) => dist([x, y], [f.x, f.y]) < f.r);
    }

    _checkStorms() {
        for (const a of this.aircraft) a.stormWarn = false;
        if (!this.storms.length) return;
        for (const a of this.aircraft) {
            if (a.state !== 'airborne' && a.state !== 'final') continue;
            for (const s of this.storms) {
                const core = this._stormCore(s);
                if (core <= 0) continue;
                const d = dist([a.x, a.y], [s.x, s.y]);
                if (d < core) {
                    if (!this.gameOver) {
                        this._incident(a, 'berepült a zivatar piros magjába');
                        this.gameOver = { reason: `${a.callsign} berepült a zivatar piros magjába.`, callsign: a.callsign };
                        this._event('incident', `VÉGE A MŰSZAKNAK: ${a.callsign} berepült a zivatar magjába.`, a.id, 'incident');
                    }
                    return;
                }
                // előrejelzés: a jelenlegi irányában 25 mp-en belül a magba érne
                const ahead = fromBearing([a.x, a.y], a.hdg, a.spd * KT_TO_NMPS * 25);
                if (d < core + 4 && pointSegmentDistance([s.x, s.y], [a.x, a.y], ahead) < core + 0.3) {
                    if (!a.stormWarn) {
                        a.stormWarn = true;
                        const key = `${a.id}-${s.id}`;
                        if (!this.stormHits.has(key)) {
                            this.stormHits.add(key);
                            this._event('incident', `FIGYELEM: ${a.callsign} a zivatar magja felé tart – fordítsd el!`, a.id, 'stormWarn');
                        }
                    }
                }
            }
        }
    }

    // ---------- vészhelyzetek ----------
    _emergencyTick(dt) {
        this.timers.emergency -= dt;
        if (this.timers.emergency > 0) return;
        this.timers.emergency = rand(300, 480);
        const candidates = this.aircraft.filter((a) => a.kind === 'arr' && a.state === 'airborne' && !a.emergency && a.fuel > 200);
        if (!candidates.length) {
            this.timers.emergency = 30;
            return;
        }
        const a = pick(candidates);
        a.emergency = true;
        a.emergencyLeft = EMERGENCY_TIME;
        a.cruise = Math.round(a.cruise * 0.8);
        a.targetSpd = Math.min(a.targetSpd, a.cruise);
        a.fuel = Math.max(a.fuel, EMERGENCY_TIME + 60);
        this._event('incident', `VÉSZHELYZET: ${a.callsign} – 6 percen belül le kell szállnia!`, a.id, 'emergency');
    }

    // ---------- kifutó-ellenőrzések ----------
    _constraintTick(dt) {
        this.timers.constraint -= dt;
        if (this.timers.constraint > 0) return;
        this.timers.constraint = rand(360, 540);
        const open = this.runways.filter((r) => this.runwayOpen(r) && r.closingIn <= 0);
        if (open.length < 2) return;
        const rw = pick(open);
        rw.closingIn = 60;
        this._event('warn', `${this.runwayName(rw)} kifutó 60 másodperc múlva ellenőrzés miatt lezár.`, null, 'warn');
    }

    _runwayTick(dt) {
        for (const rw of this.runways) {
            if (rw.closingIn > 0) {
                rw.closingIn -= dt;
                if (rw.closingIn <= 0) {
                    rw.closingIn = 0;
                    rw.closedFor = rand(150, 240);
                    this._closeRunway(rw);
                }
            } else if (rw.closedFor > 0) {
                rw.closedFor -= dt;
                if (rw.closedFor <= 0) {
                    rw.closedFor = 0;
                    this._event('good', `${this.runwayName(rw)} kifutó újra nyitva.`);
                }
            }
        }
    }

    _closeRunway(rw) {
        this._event('warn', `${this.runwayName(rw)} kifutó lezárva. A rá tartó érkezők új kifutót kérnek.`);
        for (const a of this.aircraft) {
            if (a.runway !== rw.index) continue;
            if (a.kind === 'arr' && (a.state === 'airborne' || a.state === 'final')) {
                a.runway = null;
                a.state = 'airborne';
            } else if (a.kind === 'dep' && a.state === 'ground') {
                a.runway = this._bestRunwayFor(this._gate(a.exitGate).pos);
            }
        }
    }

    // ---------- mozgás ----------
    _turnToward(a, targetHdg, dt) {
        const diff = angleDiff(a.hdg, targetHdg);
        const maxTurn = TURN_RATE * dt;
        a.hdg = norm360(a.hdg + clamp(diff, -maxTurn, maxTurn));
    }

    _move(a, dt) {
        const d = a.spd * KT_TO_NMPS * dt;
        a.x += Math.sin(toRad(a.hdg)) * d;
        a.y += Math.cos(toRad(a.hdg)) * d;
    }

    _approachSpeedAndAlt(a, dt) {
        if (a.targetSpd > a.spd) a.spd = Math.min(a.targetSpd, a.spd + ACCEL * dt);
        else a.spd = Math.max(a.targetSpd, a.spd - ACCEL * dt);
        if (a.targetAlt > a.alt) a.alt = Math.min(a.targetAlt, a.alt + CLIMB_RATE * dt);
        else a.alt = Math.max(a.targetAlt, a.alt - DESCENT_RATE * dt);
    }

    _updateAircraft(a, dt) {
        if (a.state === 'ground') {
            a.groundFuel -= dt;
            if (a.groundFuel <= 0) {
                this._incident(a, 'túl sokat várt a földön, a járatot törölték');
                this._remove(a);
            }
            return;
        }

        if (a.state === 'takeoff') {
            a.spd = Math.min(a.cruise, a.spd + 6 * TIME_SCALE * dt);
            if (a.spd > 140) a.alt = Math.min(a.targetAlt, a.alt + CLIMB_RATE * dt);
            this._move(a, dt);
            if (a.alt > 0 && !a.climbOutUntil && dist([a.x, a.y], a.takeoffEnd) < 0.2 + a.spd * KT_TO_NMPS * dt) {
                // egyenes emelkedés a kifutó vége után még 1 nm-ig
                a.climbOutUntil = fromBearing(a.takeoffEnd, a.hdg, 1);
            }
            if (a.climbOutUntil && dist([a.x, a.y], a.climbOutUntil) < 0.3) {
                a.state = 'airborne';
                a.climbOutUntil = null;
                a.targetSpd = a.cruise;
            }
            return;
        }

        if (a.state === 'rollout') {
            a.spd = Math.max(25, a.spd - 5 * TIME_SCALE * dt);
            this._move(a, dt);
            a.rollTime = (a.rollTime || 0) + dt;
            if (a.rollTime > 14 || dist([a.x, a.y], a.rollEnd) < 0.15) {
                this.stats.landed += 1;
                this._addPoints(POINTS.landed);
                if (a.emergency) {
                    this.stats.emergencies += 1;
                    if (a.emergencyLeft > 0) this._addPoints(POINTS.emergency);
                }
                this._event('good', `${a.callsign} leszállt.`, a.id, 'good');
                this._remove(a);
            }
            return;
        }

        // levegőben
        a.fuel -= dt;
        if (a.emergency && a.emergencyLeft > 0) {
            a.emergencyLeft -= dt;
            if (a.emergencyLeft <= 0) this._incident(a, 'a vészhelyzetben lévő gép nem szállt le időben');
        }
        if (a.fuel <= 0) {
            this._incident(a, 'kifogyott az üzemanyag-tartalék, kitérő reptérre ment');
            this._remove(a);
            return;
        }

        if (a.state === 'final') {
            this._flyFinal(a, dt);
            return;
        }

        // ködben a pilóta nem tudja, hol van: egyenesen repül tovább, és nem irányítható
        a.fogged = this.inFog(a.x, a.y);
        if (a.fogged) {
            this._approachSpeedAndAlt(a, dt);
            this._move(a, dt);
            this._checkExit(a);
            return;
        }

        let target = null;
        if (a.hold) {
            a.hdg = norm360(a.hdg + TURN_RATE * dt);
        } else if (a.route.length) {
            target = a.route[0];
            if (dist([a.x, a.y], target) < 0.6) {
                a.route.shift();
                target = a.route[0] || null;
                // kézi útvonalnál az utolsó útpont után a kapu felé fordul
                if (!target && a.exitGate && this.rules.manualRouting) a.routedToGate = true;
            }
        }
        if (!a.hold && !target) {
            if (a.kind === 'arr' && a.runway != null) {
                const rw = this.runways[a.runway];
                if (this._canJoinFinal(a, rw)) {
                    a.state = 'final';
                    this._flyFinal(a, dt);
                    return;
                }
                target = fromBearing(this.threshold(rw), norm360(this.landingHeading(rw) + 180), FAF_DISTANCE);
                if (dist([a.x, a.y], target) < 1.2) {
                    // FAF elérve, de rossz szögben: rávezetjük a tengelyre
                    target = fromBearing(this.threshold(rw), norm360(this.landingHeading(rw) + 180), FAF_DISTANCE - 3);
                }
            } else if (a.exitGate && (!this.rules.manualRouting || a.routedToGate)) {
                const gate = this._gate(a.exitGate);
                // messziről a kapura, közelről a kapun túli pontra célzunk
                target = dist([a.x, a.y], gate.pos) > 3 ? gate.pos : this._gateExitTarget(gate);
            }
        }
        if (target) this._turnToward(a, bearing([a.x, a.y], target), dt);
        // magasság nélküli játékban az indulók és átrepülők maguktól a kilépési szintre emelkednek
        if (!this.rules.altitude && a.kind !== 'arr') a.targetAlt = Math.max(a.targetAlt, 9000);
        this._approachSpeedAndAlt(a, dt);
        this._move(a, dt);

        this._checkExit(a);
    }

    // kilépés a légtérből
    _checkExit(a) {
        if (!insideAirspace(a.x, a.y, 0.5)) {
            if ((a.kind === 'dep' || a.kind === 'transit') && a.exitGate) {
                const gate = this._gate(a.exitGate);
                if (dist([a.x, a.y], gate.pos) < 4) {
                    if (a.exitAlt && Math.abs(a.alt - a.exitAlt) > 600) {
                        this._incident(a, `rossz magasságon lépett ki (${Math.round(a.alt / 100)} helyett ${a.exitAlt / 100})`);
                    } else {
                        if (a.kind === 'dep') {
                            this.stats.departed += 1;
                            this._addPoints(POINTS.departed);
                        } else {
                            this.stats.transited += 1;
                            this._addPoints(POINTS.transited);
                        }
                        this._event('good', `${a.callsign} átadva ${gate.letter} (${gate.name}) kapun.`, a.id, 'good');
                    }
                } else {
                    this._incident(a, `rossz helyen hagyta el a légteret (cél: ${gate.letter})`);
                }
            } else {
                this._incident(a, 'leszállás nélkül elhagyta a légteret');
            }
            this._remove(a);
        }
    }

    _alongAndCross(a, rw) {
        const thr = this.threshold(rw);
        const back = norm360(this.landingHeading(rw) + 180);
        const ux = Math.sin(toRad(back));
        const uy = Math.cos(toRad(back));
        const dx = a.x - thr[0];
        const dy = a.y - thr[1];
        return { along: dx * ux + dy * uy, cross: dx * uy - dy * ux };
    }

    _canJoinFinal(a, rw) {
        const { along, cross } = this._alongAndCross(a, rw);
        const hdgOk = Math.abs(angleDiff(a.hdg, this.landingHeading(rw))) < 70;
        return along > 2 && along < 16 && Math.abs(cross) < Math.max(1, along * 0.3) && hdgOk;
    }

    _flyFinal(a, dt) {
        const rw = this.runways[a.runway];
        const { along, cross } = this._alongAndCross(a, rw);
        const lhdg = this.landingHeading(rw);
        // pálya-tengelyre vezetés: a tengely egy előrébb lévő pontját követjük
        const aim = fromBearing(this.threshold(rw), norm360(lhdg + 180), Math.max(0, along - 1.2));
        this._turnToward(a, bearing([a.x, a.y], aim), dt);
        const c = CLASSES[a.cls];
        a.targetSpd = along < 4 ? c.approach : Math.max(c.approach + 20, Math.min(a.cruise, 180));
        a.spd = a.targetSpd > a.spd ? Math.min(a.targetSpd, a.spd + ACCEL * dt) : Math.max(a.targetSpd, a.spd - ACCEL * dt);
        const glide = Math.max(0, along * GLIDE_FT_PER_NM);
        if (a.alt > glide) a.alt = Math.max(glide, a.alt - DESCENT_RATE * 2.5 * dt);
        a.targetAlt = Math.round(a.alt);
        this._move(a, dt);

        if (along < 3 && a.alt > glide + 1500) {
            this._goAround(a, 'túl magasan volt');
            return;
        }
        if (along < 2.5 && Math.abs(cross) > 0.6) {
            this._goAround(a, 'nem állt a tengelyre');
            return;
        }
        if (along < 1.5 && this.runwayBusy(a.runway, a)) {
            this._goAround(a, 'foglalt kifutó');
            return;
        }
        if (along <= 0.05) {
            a.state = 'rollout';
            a.alt = 0;
            a.hdg = lhdg;
            a.rollEnd = this.threshold(rw, 1 - rw.activeEnd);
            a.route = [];
        }
    }

    _checkSeparation() {
        const air = this.aircraft.filter((a) => a.state === 'airborne' || a.state === 'final' || (a.state === 'takeoff' && a.alt > 0));
        for (const a of this.aircraft) a.conflict = false;
        const activePairs = new Set();
        const crashed = new Set();
        const useAlt = this.rules.altitude;
        for (let i = 0; i < air.length; i++) {
            for (let j = i + 1; j < air.length; j++) {
                const a = air[i];
                const b = air[j];
                const d = dist([a.x, a.y], [b.x, b.y]);
                if (d >= SEPARATION.warnNm) continue;
                const v = useAlt ? Math.abs(a.alt - b.alt) : 0;
                if (v >= SEPARATION.warnFt) continue;
                // két gép ugyanarra a kifutóra a végső megközelítésen 3 nm-nél közelebb is lehet egymás mögött
                const sameFinal = a.state === 'final' && b.state === 'final' && a.runway === b.runway;
                if (sameFinal && d > 1.0) continue;
                a.conflict = true;
                b.conflict = true;
                const key = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
                if (d < SEPARATION.crashNm && v < SEPARATION.crashFt) {
                    crashed.add(a);
                    crashed.add(b);
                    this._incident(a, `ütközött: ${b.callsign}`);
                    this._incident(b, `ütközött: ${a.callsign}`);
                } else if (d < SEPARATION.lossNm && v < SEPARATION.lossFt) {
                    activePairs.add(key);
                    if (!this.lossPairs.has(key)) this._incident(a, `elkülönítés elveszett ${b.callsign} géppel`);
                }
            }
        }
        this.lossPairs = activePairs;
        for (const a of crashed) this._remove(a);
    }

    // ---------- kimenet ----------
    snapshot() {
        const r1 = (v) => Math.round(v * 10) / 10;
        return {
            t: Math.round(this.time * 10) / 10,
            stats: this.stats,
            aircraft: this.aircraft.map((a) => ({
                id: a.id,
                cs: a.callsign,
                k: a.kind,
                c: a.cls,
                x: Math.round(a.x * 1000) / 1000,
                y: Math.round(a.y * 1000) / 1000,
                h: Math.round(a.hdg * 10) / 10,
                s: Math.round(a.spd),
                ts: Math.round(a.targetSpd),
                al: Math.round(a.alt),
                ta: Math.round(a.targetAlt),
                xa: a.exitAlt,
                st: a.state,
                rw: a.runway,
                eg: a.exitGate,
                ig: a.entryGate,
                r: a.route.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]),
                hd: a.hold,
                f: Math.round(a.fuel),
                gf: Math.round(a.groundFuel),
                cf: a.conflict,
                em: a.emergency ? Math.max(0, Math.round(a.emergencyLeft)) : null,
                fg: !!a.fogged && a.state === 'airborne',
                sw: !!a.stormWarn
            })),
            runways: this.runways.map((r) => ({ e: r.activeEnd, w: Math.ceil(r.closingIn), c: Math.ceil(r.closedFor) })),
            fogs: this.fogs.map((f) => ({ id: f.id, x: Math.round(f.x * 100) / 100, y: Math.round(f.y * 100) / 100, r: r1(f.r) })),
            storms: this.storms.map((s) => ({ id: s.id, x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100, r: r1(s.r), core: r1(this._stormCore(s)), h: Math.round(s.hdg) }))
        };
    }

    staticInfo() {
        return {
            icao: this.airport.icao,
            name: this.airport.name,
            airspace: AIRSPACE,
            timeScale: TIME_SCALE,
            fafDistance: FAF_DISTANCE,
            windFrom: this.windFrom,
            gates: this.gates,
            runways: this.runways.map((r) => ({ index: r.index, names: r.names, ends: r.ends })),
            classes: CLASSES,
            shift: this.shift,
            multiplier: this.multiplier
        };
    }

    drainEvents() {
        const ev = this.events;
        this.events = [];
        return ev;
    }
}

module.exports = {
    Sim,
    AIRPORTS,
    AIRSPACE,
    CLASSES,
    TIME_SCALE,
    geometry: { bearing, dist, fromBearing, angleDiff, pointSegmentDistance, edgePoint, insideAirspace }
};
