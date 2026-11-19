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
    biz: { label: 'Üzleti jet', short: 'BIZ', cruise: 250, approach: 135 },
    fighter: { label: 'Vadászgép', short: 'VAD', cruise: 450, approach: 160 }
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

const POINTS = { landed: 10, departed: 8, transited: 6, emergency: 15, intercept: 25, vip: 30, incident: -20 };
const VIP_ESCORT_DUE = 60;     // ennyi másodperc alatt kell kíséretet küldeni a VIP gép elé
const EARLY_HANDOFF_S = 6;     // „Korábbi átvétel”: ennyivel korábban látszik a belépő gép
const FLEX_EXIT_COOLDOWN = 120;
const HIJACK_REACH_NM = 2.5;   // ennyire megközelítve a reptért az eltérített gép „odaért”
const INTERCEPT_NM = 0.8;      // ilyen közel érve a vadászgép elfogja
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
function edgePoint(brg, as = AIRSPACE) {
    const s = Math.sin(toRad(brg));
    const c = Math.cos(toRad(brg));
    const t = Math.min(Math.abs(s) > 1e-6 ? as.hw / Math.abs(s) : Infinity, Math.abs(c) > 1e-6 ? as.hh / Math.abs(c) : Infinity);
    return [s * t, c * t];
}

function insideAirspace(x, y, margin = 0, as = AIRSPACE) {
    return Math.abs(x) <= as.hw + margin && Math.abs(y) <= as.hh + margin;
}

function clampToAirspace(x, y, as = AIRSPACE) {
    return [clamp(x, -as.hw, as.hw), clamp(y, -as.hh, as.hh)];
}

function segmentsIntersect(p1, p2, p3, p4) {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function pointSegmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
    return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

class Sim {
    // opts.airportCount: többrepteres pályán hány reptér él (a „Saját reptér” módban = játékosok száma)
    constructor(airportIcao = 'LOWW', shift = {}, opts = {}) {
        const ap = AIRPORTS[airportIcao] || AIRPORTS.LOWW;
        this.airport = ap;
        // A légtér a képernyő arányához igazodik (opts.aspect = szélesség / magasság),
        // multiban játékosonként +15% terület (legfeljebb +30%).
        const base = ap.airspace || AIRSPACE;
        const grow = 1 + 0.15 * clamp((opts.players || 1) - 1, 0, 2);
        const hw = Math.round(base.hw * Math.sqrt(grow) * 10) / 10;
        const aspect = Number(opts.aspect);
        const hh = Number.isFinite(aspect) && aspect > 0
            ? Math.round(clamp(hw / clamp(aspect, 0.55, 2.6), base.hh * 0.7, hw * 1.4) * 10) / 10
            : Math.round(base.hh * Math.sqrt(grow) * 10) / 10;
        this.airspace = { hw, hh };
        // nagyobb légtérben arányosan több üzemanyag, hogy a leghosszabb út is beleférjen
        this.fuelScale = Math.max(1, (this.airspace.hw + this.airspace.hh) / (AIRSPACE.hw + AIRSPACE.hh));
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
        // fejlesztések és értékelés
        this.perks = new Set();
        this.review = null;
        this.nextReviewMoves = Rules.REVIEW_EVERY_MOVES;
        this.nextReviewTime = Rules.REVIEW_EVERY_SECONDS;
        this.incoming = [];
        this.nextIncomingId = 1;
        this.flexReadyAt = 0;
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
            hijack: rand(420, 600),
            vip: rand(540, 780),
            constraint: rand(240, 360)
        };
        const allAirports = ap.airports || [{ icao: ap.icao, name: ap.name, pos: [0, 0] }];
        const count = clamp(Math.round(opts.airportCount || allAirports.length), 1, allAirports.length);
        this.airports = allAirports.slice(0, count);
        this.nextHome = 0;
        this.gates = this._buildGates();
        this.runways = ap.runways.filter((r) => (r.airport || 0) < count).map((r, i) => ({
            index: i,
            airport: r.airport || 0,
            names: r.names,
            ends: r.ends,
            activeEnd: 0,
            length: dist(r.ends[0], r.ends[1]),
            closingIn: 0,
            closedFor: 0
        }));
        this._chooseRunwayEndsForWind(rand(0, 360));
        if (this._wants('dep')) {
            const initial = gentle ? this.airports.length : Math.max(3, this.airports.length * 2);
            for (let i = 0; i < initial; i++) this._spawnDeparture();
        }
    }

    // a következő gép „saját” repterének kiválasztása (többrepteres pályán felváltva)
    _nextHomeAirport() {
        const home = this.nextHome % this.airports.length;
        this.nextHome += 1;
        return home;
    }

    _airportPos(home) {
        return (this.airports[home] || this.airports[0]).pos;
    }

    _airportCode(home) {
        return (this.airports[home] || this.airports[0]).icao;
    }

    _wants(kind) {
        return this.shift.practice === 'all' || this.shift.practice === kind;
    }

    _edge(brg) { return edgePoint(brg, this.airspace); }

    hasPerk(key) { return this.perks.has(key); }

    _turnRate() { return TURN_RATE * (this.hasPerk('agile') ? 1.25 : 1); }

    _moves() { return this.stats.landed + this.stats.departed + this.stats.transited; }

    _inside(x, y, margin = 0) { return insideAirspace(x, y, margin, this.airspace); }

    _clamp(x, y) { return clampToAirspace(x, y, this.airspace); }

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
            const pos = this._edge(brg);
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
        const onSide = Math.abs(Math.abs(x) - this.airspace.hw) < 0.05;
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
            home: this._nextHomeAirport(),
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

    _spawnArrival(fixedGate = null) {
        const gates = this.gates.filter((g) => this._gateClear(g));
        if (!gates.length) return null;
        const gate = fixedGate && gates.includes(fixedGate) ? fixedGate : fixedGate ? null : pick(gates);
        if (!gate) return null;
        const a = this._base('arr');
        this._enterAt(a, gate);
        a.hdg = norm360(gate.bearing + 180 + rand(-15, 15));
        a.alt = Math.round(rand(...ALT.arrivalSpawn) / 1000) * 1000;
        a.targetAlt = this.rules.altitude ? a.alt : ALT.approach;
        a.fuel = FUEL.arrival * (a.cls === 'turboprop' ? 0.85 : 1) * this.fuelScale;
        this.aircraft.push(a);
        const dest = this.airports.length > 1 ? ` → ${this._airportCode(a.home)}` : '';
        this._event('info', `${a.callsign} belépett ${gate.letter} (${gate.name}) felől, leszállásra vár${dest}.`, a.id, 'arrival');
        return a;
    }

    _spawnTransit(fixedGate = null) {
        const gates = this.gates.filter((g) => this._gateClear(g));
        if (!gates.length) return null;
        const entry = fixedGate && gates.includes(fixedGate) ? fixedGate : fixedGate ? null : pick(gates);
        if (!entry) return null;
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
        a.fuel = FUEL.transit * this.fuelScale;
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
        a.exitGate = gate.letter;
        a.exitAlt = this.rules.altitude ? this._reachableExitLevel(a) : 0;
        a.targetAlt = this.rules.altitude ? Math.min(ALT.departureInitial, a.exitAlt) : 9000;
        a.groundFuel = FUEL.departureGround;
        a.fuel = FUEL.departureAir * this.fuelScale;
        a.runway = this._bestRunwayFor(gate.pos, a.home);
        this.aircraft.push(a);
        const from = this.airports.length > 1 ? `${this._airportCode(a.home)} ` : '';
        this._event('dep', `${from}${a.callsign} felszállásra kész: ${this.runwayName(this.runways[a.runway])}, kijárat ${gate.letter}.`, a.id, 'depReady');
        return a;
    }

    // olyan kilépési szint, amit az induló a repterétől a kapujáig biztosan elér
    _reachableExitLevel(a) {
        const gate = this._gate(a.exitGate);
        const d = Math.max(0, dist(this._airportPos(a.home), gate.pos) - 2);
        const climbable = (d / (a.cruise * KT_TO_NMPS)) * CLIMB_RATE * 0.75;
        const options = ALT.exitLevels.filter((l) => l <= climbable);
        if (options.length) return pick(options);
        return Math.max(4000, Math.floor(climbable / 1000) * 1000);
    }

    _bestRunwayFor(pos, home = 0) {
        const target = bearing(this._airportPos(home), pos);
        let best = null;
        let bestDiff = 999;
        for (const rw of this.runways) {
            if (rw.airport !== home || !this.runwayOpen(rw) || rw.closingIn > 0) continue;
            const diff = Math.abs(angleDiff(this.landingHeading(rw), target));
            if (diff < bestDiff) { bestDiff = diff; best = rw.index; }
        }
        if (best == null) best = (this.runways.find((rw) => rw.airport === home) || this.runways[0]).index;
        return best;
    }

    _trafficLevel() {
        const minutes = this.time / 60 - (this.shift.opening === 'gentle' ? 4 : 0);
        // több reptérnél arányosan több forgalom, hogy mindenkinek jusson munka
        const factor = 1 / (this.shift.traffic / 100) / (1 + 0.8 * (this.airports.length - 1));
        return {
            arrival: (clamp(55 - minutes * 1.5, 28, 70) + (this.hasPerk('spacing') ? 3 + (this._airborneCount() > 6 * this.airports.length ? 8 : 0) : 0)) * factor,
            departure: clamp(60 - minutes * 1.2, 32, 80) * factor,
            transit: clamp(110 - minutes * 2, 60, 140) * factor
        };
    }

    _airborneCount() {
        return this.aircraft.filter((a) => a.state === 'airborne' || a.state === 'final').length;
    }

    _incomingTick(dt) {
        for (const inc of [...this.incoming]) {
            inc.t -= dt;
            if (inc.t > 0) continue;
            const gate = this._gate(inc.gate);
            const a = inc.kind === 'arr' ? this._spawnArrival(gate) : this._spawnTransit(gate);
            if (a) this.incoming = this.incoming.filter((i) => i !== inc);
            else inc.t = 2; // a kapu még foglalt: kicsit később lép be
        }
    }

    _spawnTick(dt) {
        const level = this._trafficLevel();
        const kinds = { arrival: 'arr', departure: 'dep', transit: 'transit' };
        for (const key of ['arrival', 'departure', 'transit']) {
            if (!this._wants(kinds[key])) continue;
            this.timers[key] -= dt;
            if (this.timers[key] > 0) continue;
            let ok;
            if ((key === 'arrival' || key === 'transit') && this.hasPerk('earlyHandoff')) {
                // „Korábbi átvétel”: a gép előbb csak jelzésként jelenik meg a kapunál
                const gates = this.gates.filter((g) => this._gateClear(g) && !this.incoming.some((i) => i.gate === g.letter));
                ok = gates.length ? this.incoming.push({ id: this.nextIncomingId++, kind: key === 'arrival' ? 'arr' : 'transit', gate: pick(gates).letter, t: EARLY_HANDOFF_S }) : null;
            } else if (key === 'arrival') ok = this._spawnArrival();
            else if (key === 'transit') ok = this._spawnTransit();
            else ok = this.aircraft.filter((a) => a.state === 'ground').length < 6 * this.airports.length ? this._spawnDeparture() : true;
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
        return !!this.runwayBusyBy(rwIndex, ignore);
    }

    // melyik gép foglalja a kifutót (és miért) – a játékosnak szóló üzenethez
    runwayBusyBy(rwIndex, ignore = null) {
        for (const a of this.aircraft) {
            if (a === ignore || a.runway !== rwIndex) continue;
            if (a.state === 'rollout') return { a, why: 'éppen leszállt, még kigurul' };
            if (a.state === 'takeoff') return { a, why: 'éppen felszáll' };
            if (a.state === 'final') {
                const d = dist([a.x, a.y], this.threshold(this.runways[rwIndex]));
                if (d < 3) return { a, why: `${d.toFixed(1)} nm-re leszáll` };
            }
        }
        return null;
    }

    // ---------- parancsok ----------
    // Minden parancs [ok, üzenet] párt ad vissza.
    command(cmd) {
        const a = cmd.id != null ? this.find(cmd.id) : null;
        if (cmd.type === 'scramble') return this._cmdScramble(a);
        if (a && a.kind === 'mil') return [false, 'A vadászgépek önállóan repülnek, nem irányíthatók.'];
        if (a && a.hijacked) return [false, `${a.callsign} eltérített gép, nem válaszol. Indíts vadászgépeket (F)!`];
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
            case 'choosePerk': return this._cmdChoosePerk(cmd);
            case 'changeExit': return this._cmdChangeExit(a, cmd);
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

    // honnan indul a tervezett útvonal: felszálló gépnél a kifutó vége utáni egyenes emelkedés pontjából
    _routeStart(a) {
        if (a.kind === 'dep' && (a.state === 'ground' || a.state === 'takeoff') && a.runway != null) {
            const rw = this.runways[a.runway];
            return fromBearing(this.threshold(rw, 1 - rw.activeEnd), this.landingHeading(rw), 1);
        }
        return [a.x, a.y];
    }

    _stopHolding(a) {
        a.hold = false;
        a.autoHold = false;
        a.appPhase = null;
    }

    _cmdAddWaypoint(a, { x, y, index }) {
        if (!a || a.state === 'rollout' || (a.state === 'ground' && a.kind !== 'dep')) return [false, 'Ennek a gépnek most nem adható útpont.'];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return [false, null];
        const p = this._clamp(x, y);
        if (a.state === 'final') a.state = 'airborne';
        if (typeof index === 'number') {
            a.route.splice(clamp(index, 0, a.route.length), 0, p);
        } else {
            // a legkisebb kerülőt okozó helyre szúrjuk be
            const pts = [this._routeStart(a), ...a.route];
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
        // útpontot kapott: abbahagyja a körözést
        this._stopHolding(a);
        return [true, null];
    }

    _cmdMoveWaypoint(a, { index, x, y }) {
        if (!a || !a.route[index] || !Number.isFinite(x) || !Number.isFinite(y)) return [false, null];
        a.route[index] = this._clamp(x, y);
        this._stopHolding(a);
        return [true, null];
    }

    _cmdRemoveWaypoint(a, { index }) {
        if (!a || !a.route[index]) return [false, null];
        a.route.splice(index, 1);
        return [true, null];
    }

    _cmdReplaceRoute(a, { x, y }) {
        if (!a || a.state === 'rollout' || (a.state === 'ground' && a.kind !== 'dep') || !Number.isFinite(x) || !Number.isFinite(y)) return [false, null];
        if (a.state === 'final') a.state = 'airborne';
        a.route = [this._clamp(x, y)];
        this._stopHolding(a);
        a.hold = false;
        return [true, null];
    }

    _cmdRunway(a, { runway }) {
        if (!a) return [false, 'Nincs kijelölt gép.'];
        const rw = this.runways[runway];
        if (!rw) return [false, 'Nincs ilyen kifutó.'];
        if (!this.runwayOpen(rw)) return [false, `${this.runwayName(rw)} le van zárva.`];
        if (a.kind === 'transit') return [false, `${a.callsign} átrepülő, nem száll le.`];
        if (rw.airport !== a.home) {
            return [false, `${this.runwayName(rw)} a(z) ${this._airportCode(rw.airport)} kifutója, ${a.callsign} viszont ${this._airportCode(a.home)} gépe.`];
        }
        if (a.kind === 'dep') {
            if (a.state !== 'ground') return [false, `${a.callsign} már a levegőben van.`];
            a.runway = runway;
            return [true, `${a.callsign} felszálláshoz: ${this.runwayName(rw)}.`];
        }
        if (a.state === 'rollout') return [false, null];
        a.runway = runway;
        if (a.state === 'final') a.state = 'airborne';
        // kifutót kapott: abbahagyja a körözést (kényszerleszállásnál újra beáll, ha kell)
        this._stopHolding(a);
        // magasság nélküli játékban automatikusan süllyed a megközelítéshez
        if (!this.rules.altitude && a.targetAlt > ALT.approach) a.targetAlt = ALT.approach;
        return [true, `${a.callsign} leszállásra engedélyezve: ${this.runwayName(rw)}.`];
    }

    _vipBlocks(home) {
        return this.aircraft.some((p) => p.vip && p.home === home);
    }

    _cmdTakeoff(a) {
        if (!a || a.kind !== 'dep' || a.state !== 'ground') return [false, 'Csak földön váró induló szállhat fel.'];
        const rw = this.runways[a.runway];
        if (!this.runwayOpen(rw)) return [false, `${this.runwayName(rw)} le van zárva, válassz másik kifutót.`];
        if (a.queued) {
            a.queued = false;
            return [true, `${a.callsign} kivéve a felszállási sorból.`];
        }
        const vip = this._vipBlocks(a.home);
        if (vip || this.runwayBusy(a.runway)) {
            if (this.hasPerk('takeoffQueue') && !this.aircraft.some((o) => o.queued && o.runway === a.runway)) {
                a.queued = true;
                return [true, `${a.callsign} felszállási sorban, ${this.runwayName(rw)} – indul, amint szabad.`];
            }
            if (vip) return [false, `VIP gép érkezik: amíg le nem száll, ${this._airportCode(a.home)} kifutói zárva.`];
            const busy = this.runwayBusyBy(a.runway);
            const free = this.runways.find((r) => r.airport === a.home && r !== rw && this.runwayOpen(r) && !this.runwayBusy(r.index));
            const why = busy ? ` (${busy.a.callsign} ${busy.why})` : '';
            const tip = free ? ` Szabad: ${this.runwayName(free)} – nyomd meg a ${free.index + 1}-es gombot, majd X.` : '';
            return [false, `${this.runwayName(rw)} foglalt${why}, ${a.callsign} vár.${tip}`];
        }
        return this._doTakeoff(a);
    }

    _doTakeoff(a) {
        const rw = this.runways[a.runway];
        a.queued = false;
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

    _cmdSpeed(a, { delta, to, value }) {
        if (!this._isAirborneControllable(a) || a.state === 'final') return [false, 'A sebesség most automatikus.'];
        const lo = Math.round(a.cruise * 0.8);
        const hi = Math.round(a.cruise * 1.2);
        if (value != null) {
            if (!this.hasPerk('exactSpeed')) return [false, 'Pontos sebességhez a „Pontos sebesség” fejlesztés kell.'];
            if (!Number.isFinite(Number(value))) return [false, null];
            a.targetSpd = clamp(Math.round(Number(value)), lo, hi);
            return [true, null];
        }
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
        a.route = [p1, p2, p3].map((p) => this._clamp(p[0], p[1]));
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
        if (this.rules.security) {
            this._hijackTick(dt);
            this._vipTick(dt);
        }
        this._incomingTick(dt);
        this._reviewTick();
        if (this.rules.constraints) this._constraintTick(dt);
        this._runwayTick(dt);
        for (const a of [...this.aircraft]) this._updateAircraft(a, dt);
        this._checkSeparation();
        this._checkStorms();
    }

    // ---------- időjárás: zivatar és köd ----------
    // Mindkettő kicsi, lassan sodródik, és egyszerre legfeljebb egy-egy lehet a légtérben.
    _spawnWeather(kind) {
        // minden zivatar 1% eséllyel hurrikánná erősödik
        const hurricane = kind === 'storm' && (this.forceHurricane || Math.random() < 0.01);
        const r = hurricane ? rand(6, 8) : kind === 'storm' ? rand(2.5, 3.5) : rand(2, 3.5);
        // a légtér belsejében, de a reptértől távolabb jelenik meg, és lassan befelé sodródik
        let pos;
        for (let tries = 0; tries < 20; tries++) {
            pos = [rand(-this.airspace.hw + r, this.airspace.hw - r), rand(-this.airspace.hh + r, this.airspace.hh - r)];
            const busy = this.aircraft.some((a) => a.state !== 'ground' && dist([a.x, a.y], pos) < r + 3);
            if (Math.hypot(pos[0], pos[1]) > 9 && !busy) break;
        }
        const cell = {
            id: this.nextStormId++,
            x: pos[0], y: pos[1],
            r,
            hdg: norm360(bearing(pos, [0, 0]) + rand(-70, 70)),
            spd: hurricane ? rand(0.012, 0.018) : rand(0.006, 0.012), // nm/s – lassú
            hurricane,
            age: 0,
            life: kind === 'storm' ? rand(600, 900) : rand(500, 800),
            turnIn: rand(90, 180)
        };
        if (hurricane) {
            this.storms.push(cell);
            this._event('incident', 'HURRIKÁN! Egy zivatar hurrikánná erősödött. Tartsd távol a gépeket a magjától!', null, 'hurricane');
        } else if (kind === 'storm') {
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
                c.spd = clamp(c.spd * rand(0.8, 1.2), 0.004, c.hurricane ? 0.02 : 0.014);
            }
            c.x += Math.sin(toRad(c.hdg)) * c.spd * dt;
            c.y += Math.cos(toRad(c.hdg)) * c.spd * dt;
        }
        return cells.filter((c) => c.age < c.life && this._inside(c.x, c.y, c.r));
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
        return s.r * (s.hurricane ? 0.35 : 0.3) * grow;
    }

    inFog(x, y) {
        return this.fogs.some((f) => dist([x, y], [f.x, f.y]) < f.r);
    }

    _checkStorms() {
        for (const a of this.aircraft) a.stormWarn = false;
        if (!this.storms.length) return;
        for (const a of this.aircraft) {
            if ((a.state !== 'airborne' && a.state !== 'final') || a.kind === 'mil') continue;
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
        const candidates = this.aircraft.filter((a) => a.kind === 'arr' && a.state === 'airborne' && !a.emergency && !a.vip && !a.hijacked && a.fuel > 200);
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
        // a vészhelyzetek fele kényszerleszállás: amíg le nem száll, a repterén senki más nem szállhat le
        if (this.forceForcedLanding || Math.random() < 0.5) {
            this._declarePriority(a);
            this._event('incident', `KÉNYSZERLESZÁLLÁS: ${a.callsign} – amíg le nem száll, ${this._airportCode(a.home)} reptéren senki más nem szállhat le!`, a.id, 'emergency');
        } else {
            this._event('incident', `VÉSZHELYZET: ${a.callsign} – 6 percen belül le kell szállnia!`, a.id, 'emergency');
        }
    }

    // elsőbbség (kényszerleszállás): a többi érkező a megközelítési pontnál kör, a végső megközelítésen lévők átstartolnak
    _declarePriority(a) {
        a.priority = true;
        for (const o of this.aircraft) {
            if (o !== a && o.kind === 'arr' && o.home === a.home && o.state === 'final') this._goAround(o, 'kényszerleszállás miatt');
        }
    }

    _priorityBlocks(a) {
        return this.aircraft.some((p) => p !== a && p.priority && p.home === a.home);
    }

    // ---------- eltérítés és vadászgépek ----------
    _hijackTick(dt) {
        this.timers.hijack -= dt;
        if (this.timers.hijack > 0) return;
        this.timers.hijack = rand(900, 1500);
        if (this.aircraft.some((a) => a.hijacked)) return;
        const candidates = this.aircraft.filter((a) => (a.kind === 'arr' || a.kind === 'transit') && a.state === 'airborne'
            && !a.emergency && !a.vip && !a.fogged && dist([a.x, a.y], this._airportPos(a.home)) > 10);
        if (!candidates.length) {
            this.timers.hijack = 45;
            return;
        }
        const a = pick(candidates);
        a.hijacked = true;
        a.route = [];
        a.hold = false;
        a.targetSpd = a.cruise;
        this._event('incident', `ELTÉRÍTÉS: ${a.callsign} nem válaszol, és ${this._airportCode(a.home)} felé fordult! Indíts vadászgépeket (F)!`, a.id, 'hijack');
    }

    _cmdScramble(a) {
        if (!a || !(a.hijacked || a.vip)) return [false, 'Vadászgépet csak eltérített gép ellen vagy VIP kísérethez lehet indítani.'];
        if (a.scrambled) return [false, 'A vadászgépek már úton vannak.'];
        a.scrambled = true;
        const base = this._airportPos(a.home);
        for (let i = 0; i < 2; i++) {
            const f = this._base('mil');
            f.cls = 'fighter';
            f.cruise = CLASSES.fighter.cruise;
            f.spd = 300;
            f.targetSpd = f.cruise;
            f.callsign = `GRIPEN${i + 1}`;
            const start = fromBearing(base, bearing(base, [a.x, a.y]) + (i ? 25 : -25), 1);
            f.x = start[0];
            f.y = start[1];
            f.hdg = bearing(start, [a.x, a.y]);
            f.alt = 3000;
            f.targetAlt = a.alt;
            f.fuel = 1e9;
            f.interceptId = a.id;
            f.mission = a.vip ? 'escort' : 'intercept';
            f.escortLeft = a.vip ? 1e9 : 0;
            f.home = a.home;
            this.aircraft.push(f);
        }
        return [true, a.vip ? `Gripenek felszálltak ${a.callsign} kíséretére.` : `Vadászgépek riasztva ${a.callsign} elfogására.`];
    }

    _updateHijacked(a, dt) {
        const target = this._airportPos(a.home);
        this._turnToward(a, bearing([a.x, a.y], target), dt);
        a.targetAlt = Math.min(a.targetAlt, 4000);
        this._approachSpeedAndAlt(a, dt);
        this._move(a, dt);
        if (dist([a.x, a.y], target) < HIJACK_REACH_NM && !this.gameOver) {
            this._incident(a, `az eltérített gép elérte ${this._airportCode(a.home)} repteret`);
            this.gameOver = { reason: `${a.callsign} eltérített gép elérte ${this._airportCode(a.home)} repteret.`, callsign: a.callsign };
        }
    }

    _updateFighter(f, dt) {
        const t = this.find(f.interceptId);
        f.spd = Math.min(f.targetSpd, f.spd + ACCEL * 3 * dt);
        if (f.mission === 'intercept' && t && t.hijacked) {
            // előretartó üldözés: oda célzunk, ahol a cél lesz, mire odaérünk
            const d = dist([f.x, f.y], [t.x, t.y]);
            const tti = d / Math.max(0.05, f.spd * KT_TO_NMPS);
            const lead = fromBearing([t.x, t.y], t.hdg, t.spd * KT_TO_NMPS * Math.min(tti, 20));
            f.hdg = norm360(f.hdg + clamp(angleDiff(f.hdg, bearing([f.x, f.y], lead)), -TURN_RATE * 2 * dt, TURN_RATE * 2 * dt));
            f.targetAlt = t.alt;
            if (d < INTERCEPT_NM) this._intercept(t);
        } else if (f.mission !== 'leave' && t && (t.state === 'airborne' || t.state === 'final') && f.escortLeft > 0) {
            // kísérés: a gép mögött-mellett repül
            f.escortLeft -= dt;
            const side = f.id % 2 ? 90 : -90;
            const spot = fromBearing(fromBearing([t.x, t.y], t.hdg + 180, 0.8), t.hdg + side, 0.5);
            f.hdg = norm360(f.hdg + clamp(angleDiff(f.hdg, bearing([f.x, f.y], spot)), -TURN_RATE * 2 * dt, TURN_RATE * 2 * dt));
            const gap = dist([f.x, f.y], spot);
            f.targetSpd = gap > 2 ? CLASSES.fighter.cruise : clamp(t.spd + (gap > 0.3 ? 60 : 0), 160, CLASSES.fighter.cruise);
            f.targetAlt = t.alt + 500;
        } else {
            // hazatérés: a legközelebbi légtérszél felé
            f.mission = 'leave';
            f.targetSpd = CLASSES.fighter.cruise;
            const out = Math.abs(f.x) / this.airspace.hw > Math.abs(f.y) / this.airspace.hh
                ? [Math.sign(f.x || 1) * (this.airspace.hw + 3), f.y] : [f.x, Math.sign(f.y || 1) * (this.airspace.hh + 3)];
            f.hdg = norm360(f.hdg + clamp(angleDiff(f.hdg, bearing([f.x, f.y], out)), -TURN_RATE * 2 * dt, TURN_RATE * 2 * dt));
        }
        if (f.targetAlt > f.alt) f.alt = Math.min(f.targetAlt, f.alt + CLIMB_RATE * 2 * dt);
        else f.alt = Math.max(f.targetAlt, f.alt - DESCENT_RATE * 2 * dt);
        this._move(f, dt);
        if (!this._inside(f.x, f.y, 1)) this._remove(f);
    }

    _intercept(a) {
        a.hijacked = false;
        a.kind = 'arr';
        a.exitGate = null;
        a.exitAlt = 0;
        a.route = [];
        a.emergency = true;
        a.emergencyLeft = EMERGENCY_TIME;
        a.fuel = Math.max(a.fuel, EMERGENCY_TIME + 60);
        a.runway = this._bestRunwayFor([a.x, a.y], a.home);
        a.targetAlt = ALT.approach;
        this._declarePriority(a);
        for (const f of this.aircraft) {
            if (f.kind === 'mil' && f.interceptId === a.id) {
                f.mission = 'escort';
                f.escortLeft = 90;
            }
        }
        this._addPoints(POINTS.intercept);
        this._event('good', `ELFOGVA: ${a.callsign} – a vadászgépek kényszerleszállásra kísérik ${this._airportCode(a.home)} reptérre.`, a.id, 'good');
    }

    // ---------- VIP (államfői) gép ----------
    _vipTick(dt) {
        this.timers.vip -= dt;
        if (this.timers.vip > 0) return;
        this.timers.vip = rand(1200, 1800);
        if (this.aircraft.some((a) => a.vip)) return;
        const a = this._spawnArrival();
        if (!a) {
            this.timers.vip = 30;
            return;
        }
        this.usedCallsigns.delete(a.callsign);
        a.callsign = `VIP${String(Math.floor(rand(1, 99))).padStart(2, '0')}`;
        a.cls = 'wide';
        a.cruise = CLASSES.wide.cruise;
        a.vip = true;
        a.escortDue = VIP_ESCORT_DUE;
        a.fuel = Math.max(a.fuel, 900 * this.fuelScale);
        this._declarePriority(a);
        // az eredeti belépési üzenet helyett a VIP riasztás
        this.events = this.events.filter((e) => e.aircraftId !== a.id);
        this._event('incident', `VIP GÉP: ${a.callsign} (államfői gép) érkezik ${this._airportCode(a.home)} reptérre! Tartsd tisztán a kifutókat, és indítsd a Gripeneket (F) ${VIP_ESCORT_DUE} mp-en belül!`, a.id, 'vip');
    }

    // ---------- értékelés és fejlesztések ----------
    _reviewTick() {
        if (this.rules.noPerks || this.review) return;
        if (this._moves() < this.nextReviewMoves && this.time < this.nextReviewTime) return;
        this.nextReviewMoves = this._moves() + Rules.REVIEW_EVERY_MOVES;
        this.nextReviewTime = this.time + Rules.REVIEW_EVERY_SECONDS;
        const left = Object.keys(Rules.PERKS).filter((k) => !this.perks.has(k));
        if (!left.length) return;
        const options = [];
        while (options.length < Math.min(3, left.length)) {
            const k = pick(left);
            if (!options.includes(k)) options.push(k);
        }
        this.review = { options };
        this._event('good', 'ÉRTÉKELÉS: jól dolgoztatok! Válasszatok egy fejlesztést.', null, 'review');
    }

    _cmdChoosePerk({ perk }) {
        if (!this.review || !this.review.options.includes(perk)) return [false, 'Most nincs választható fejlesztés.'];
        this.perks.add(perk);
        this.review = null;
        return [true, `Új fejlesztés: ${Rules.PERKS[perk].label}.`];
    }

    _cmdChangeExit(a, { gate }) {
        if (!this.hasPerk('flexExit')) return [false, 'Kijáratcseréhez a „Rugalmas kijárat” fejlesztés kell.'];
        if (!a || !(a.kind === 'dep' || a.kind === 'transit') || a.state !== 'airborne') return [false, 'Csak levegőben lévő induló vagy átrepülő kijárata cserélhető.'];
        const g = this._gate(gate);
        if (!g || g.letter === a.exitGate) return [false, null];
        if (this.time < this.flexReadyAt) return [false, `Kijáratcsere ${Math.ceil(this.flexReadyAt - this.time)} mp múlva lehetséges újra.`];
        a.exitGate = g.letter;
        a.routedToGate = false;
        if (a.kind === 'dep' && a.exitAlt && a.exitAlt > a.alt) a.exitAlt = Math.max(a.alt, Math.min(a.exitAlt, this._reachableExitLevel(a)));
        this.flexReadyAt = this.time + FLEX_EXIT_COOLDOWN;
        return [true, `${a.callsign} új kijárata: ${g.letter} (${g.name}).`];
    }

    // a jogosultság-ellenőrzéshez szükséges adatok (szerver és kliens ugyanígy számolja)
    ruleView(a) {
        return {
            k: a.kind, st: a.state, x: a.x, y: a.y, ap: a.home, ow: a.controller,
            tz: ['ground', 'takeoff', 'final', 'rollout'].includes(a.state) || dist([a.x, a.y], this._airportPos(a.home)) < Rules.TWR_ZONE_NM,
            em: a.emergency ? 1 : null, pr: !!a.priority, vp: !!a.vip
        };
    }

    // „Sorrendjelzés”: várható földet érés / kilépés és sorszám kifutónként
    _sequencing() {
        const out = new Map();
        const byRunway = new Map();
        for (const a of this.aircraft) {
            if (a.kind === 'mil' || !(a.state === 'airborne' || a.state === 'final')) continue;
            const v = Math.max(120, a.spd) * KT_TO_NMPS;
            let remaining;
            if (a.kind === 'arr' && a.runway != null) {
                const rw = this.runways[a.runway];
                if (a.state === 'final') remaining = Math.max(0, this._alongAndCross(a, rw).along);
                else {
                    const faf = fromBearing(this.threshold(rw), norm360(this.landingHeading(rw) + 180), FAF_DISTANCE);
                    let d = 0;
                    let prev = [a.x, a.y];
                    for (const p of a.route) { d += dist(prev, p); prev = p; }
                    remaining = d + dist(prev, faf) + FAF_DISTANCE;
                }
                const eta = remaining / v;
                out.set(a.id, { eta });
                if (!byRunway.has(a.runway)) byRunway.set(a.runway, []);
                byRunway.get(a.runway).push({ id: a.id, eta });
            } else if (a.exitGate) {
                out.set(a.id, { eta: dist([a.x, a.y], this._gate(a.exitGate).pos) / v });
            }
        }
        for (const list of byRunway.values()) {
            list.sort((p, q) => p.eta - q.eta);
            list.forEach((e, i) => {
                const o = out.get(e.id);
                o.sq = i + 1;
                o.gp = i ? e.eta - list[i - 1].eta : null;
            });
        }
        return out;
    }

    // ---------- kifutó-ellenőrzések ----------
    _constraintTick(dt) {
        this.timers.constraint -= dt;
        if (this.timers.constraint > 0) return;
        this.timers.constraint = rand(360, 540);
        // csak olyan kifutót zárunk le, amelynek repterén marad másik nyitott kifutó
        const open = this.runways.filter((r) => this.runwayOpen(r) && r.closingIn <= 0
            && this.runways.some((o) => o !== r && o.airport === r.airport && this.runwayOpen(o) && o.closingIn <= 0));
        if (!open.length) return;
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
                a.runway = this._bestRunwayFor(this._gate(a.exitGate).pos, a.home);
            }
        }
    }

    // ---------- mozgás ----------
    _turnToward(a, targetHdg, dt) {
        const diff = angleDiff(a.hdg, targetHdg);
        const maxTurn = this._turnRate() * dt;
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
            if (a.queued) {
                const rw = this.runways[a.runway];
                if (!this.runwayOpen(rw)) a.queued = false;
                else if (!this.runwayBusy(a.runway) && !this._vipBlocks(a.home)) {
                    const [ok, text] = this._doTakeoff(a);
                    if (ok) this._event('dep', `${text} (a sorból)`, a.id);
                    return;
                }
            }
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
            a.spd = Math.max(25, a.spd - 5 * TIME_SCALE * dt * (this.hasPerk('rapidExit') ? 1.2 : 1));
            this._move(a, dt);
            a.rollTime = (a.rollTime || 0) + dt;
            if (a.rollTime > (this.hasPerk('rapidExit') ? 14 * 5 / 6 : 14) || dist([a.x, a.y], a.rollEnd) < 0.15) {
                this.stats.landed += 1;
                this._addPoints(POINTS.landed);
                if (a.vip) {
                    const ok = a.scrambled && !a.escortMissed;
                    if (ok) this._addPoints(POINTS.vip);
                    this._event('good', `${a.callsign} VIP gép biztonságban leszállt${ok ? ' – kísérettel, +30 pont' : ''}.`, a.id, 'good');
                }
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
        if (a.vip && !a.scrambled && !a.escortMissed) {
            a.escortDue -= dt;
            if (a.escortDue <= 0) {
                a.escortMissed = true;
                this._incident(a, 'a VIP gép kíséret nélkül repült be');
            }
        }
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

        if (a.kind === 'mil') {
            this._updateFighter(a, dt);
            return;
        }
        if (a.hijacked) {
            this._updateHijacked(a, dt);
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

        // kényszerleszállás vége: az automatikus körözés feloldása
        if (a.autoHold && !this._priorityBlocks(a)) {
            a.hold = false;
            a.autoHold = false;
        }

        let target = null;
        let approachHdg = null;
        if (a.hold) {
            a.hdg = norm360(a.hdg + this._turnRate() * dt);
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
                const blocked = this._priorityBlocks(a);
                if (!blocked && this._canJoinFinal(a, rw)) {
                    a.state = 'final';
                    this._flyFinal(a, dt);
                    return;
                }
                const faf = fromBearing(this.threshold(rw), norm360(this.landingHeading(rw) + 180), FAF_DISTANCE);
                if (blocked && dist([a.x, a.y], faf) < 2.5) {
                    // kényszerleszállás miatt a megközelítési pontnál kör
                    a.hold = true;
                    a.autoHold = true;
                }
                target = this._approachTarget(a, rw);
                if (a.appPhase === 'intercept') {
                    // ráfordulás legfeljebb 30°-os szögben, és lassítás a kisebb fordulóív miatt
                    approachHdg = this.landingHeading(rw);
                    a.targetSpd = Math.min(a.targetSpd, Math.max(CLASSES[a.cls].approach + 30, 190));
                }
            } else if (a.exitGate && (!this.rules.manualRouting || a.routedToGate)) {
                const gate = this._gate(a.exitGate);
                // messziről a kapura, közelről a kapun túli pontra célzunk
                target = dist([a.x, a.y], gate.pos) > 3 ? gate.pos : this._gateExitTarget(gate);
            }
        }
        if (target) {
            let desired = bearing([a.x, a.y], target);
            if (approachHdg != null) {
                const off = angleDiff(approachHdg, desired);
                if (Math.abs(off) > 30) desired = norm360(approachHdg + Math.sign(off) * 30);
            }
            this._turnToward(a, desired, dt);
        }
        // magasság nélküli játékban az indulók és átrepülők maguktól a kilépési szintre emelkednek
        if (!this.rules.altitude && a.kind !== 'arr') a.targetAlt = Math.max(a.targetAlt, 9000);
        this._approachSpeedAndAlt(a, dt);
        this._move(a, dt);

        this._checkExit(a);
    }

    // kilépés a légtérből
    _checkExit(a) {
        if (!this._inside(a.x, a.y, 0.5)) {
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

    // végső megközelítés csak akkor kezdődik, ha a gép közel van a tengelyhez és nagyjából a kifutó felé néz
    _canJoinFinal(a, rw) {
        const { along, cross } = this._alongAndCross(a, rw);
        const hdgOk = Math.abs(angleDiff(a.hdg, this.landingHeading(rw))) < 40;
        return along > 3.5 && along < 18 && Math.abs(cross) < 0.8 && hdgOk;
    }

    // a megközelítés két lépése a végső megközelítés előtt:
    // 1) ha a gép rossz oldalról vagy rossz szögből jön, előbb a tengely 9 nm-es belépési pontjára repül;
    // 2) onnan (vagy ha eleve jó irányból jön, azonnal) legfeljebb ~30°-os szögben ráfordul a tengelyre.
    _approachTarget(a, rw) {
        const { along, cross } = this._alongAndCross(a, rw);
        const lhdg = this.landingHeading(rw);
        const back = norm360(lhdg + 180);
        const onAxis = (d) => fromBearing(this.threshold(rw), back, d);
        const entry = onAxis(FAF_DISTANCE + 3);
        if (a.appRunway !== rw.index) {
            a.appRunway = rw.index;
            a.appPhase = null;
        }
        if (!a.appPhase) {
            const goodSide = along > FAF_DISTANCE + 1 && Math.abs(cross) < 6;
            const towardRunway = Math.abs(angleDiff(a.hdg, bearing([a.x, a.y], this.threshold(rw)))) < 100;
            a.appPhase = goodSide && towardRunway ? 'intercept' : 'entry';
        }
        if (a.appPhase === 'entry') {
            if (dist([a.x, a.y], entry) < 1.5) a.appPhase = 'intercept';
            else return entry;
        }
        return onAxis(Math.max(FAF_DISTANCE - 1, along - (Math.abs(cross) * 1.8 + 1.2)));
    }

    _flyFinal(a, dt) {
        const rw = this.runways[a.runway];
        const { along, cross } = this._alongAndCross(a, rw);
        const lhdg = this.landingHeading(rw);
        // pálya-tengelyre vezetés: a tengely egy előrébb lévő pontját követjük; az oldaltávolsággal arányosan
        // messzebbit, és legfeljebb 30°-os ráfordulással, hogy ne lőjön túl a tengelyen
        const ahead = Math.max(1.0, Math.abs(cross) * 1.5);
        const aim = fromBearing(this.threshold(rw), norm360(lhdg + 180), Math.max(0, along - ahead));
        let desired = bearing([a.x, a.y], aim);
        const off = angleDiff(lhdg, desired);
        if (Math.abs(off) > 30) desired = norm360(lhdg + Math.sign(off) * 30);
        this._turnToward(a, desired, dt);
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

    // a gép tervezett útja (legfeljebb ~10 nm): jelenlegi hely → útpontok → kapu / megközelítési pont
    _plannedPath(a, maxLen = 10) {
        const pts = [[a.x, a.y]];
        if (a.state === 'final' && a.runway != null) {
            pts.push(this.threshold(this.runways[a.runway]));
        } else if (a.hold) {
            return pts;
        } else {
            pts.push(...a.route);
            const end = this._routeEndpoint(a);
            if (end && !(a.kind !== 'arr' && this.rules.manualRouting && !a.route.length && !a.routedToGate)) pts.push(end);
            if (pts.length === 1) pts.push(fromBearing([a.x, a.y], a.hdg, maxLen));
        }
        // levágás a megadott hosszra
        const out = [pts[0]];
        let len = 0;
        for (let i = 1; i < pts.length && len < maxLen; i++) {
            const seg = dist(pts[i - 1], pts[i]);
            if (len + seg > maxLen) {
                const t = (maxLen - len) / seg;
                out.push([pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]);
                break;
            }
            out.push(pts[i]);
            len += seg;
        }
        return out;
    }

    // keresztezi-e egymást két gép tervezett útja
    _pathsCross(a, b) {
        const pa = this._plannedPath(a);
        const pb = this._plannedPath(b);
        for (let i = 0; i < pa.length - 1; i++) {
            for (let j = 0; j < pb.length - 1; j++) {
                if (segmentsIntersect(pa[i], pa[i + 1], pb[j], pb[j + 1])) return true;
            }
        }
        return false;
    }

    // végső megközelítésen (bármilyen távolságban) vagy felszállás közben lévő gép
    _runwayProtected(a) {
        if (a.state === 'takeoff') return true;
        if (a.state !== 'final' || a.runway == null) return false;
        return true;
    }

    // leszálló gép: érkező, amely már kifutót kapott (megközelítésen vagy végső megközelítésen)
    _landing(a) {
        return a.kind === 'arr' && a.runway != null && (a.state === 'airborne' || a.state === 'final') && !a.hold;
    }

    // közelednek-e egymáshoz (a relatív sebesség a másik felé mutat)
    _closing(a, b) {
        const va = [Math.sin(toRad(a.hdg)) * a.spd, Math.cos(toRad(a.hdg)) * a.spd];
        const vb = [Math.sin(toRad(b.hdg)) * b.spd, Math.cos(toRad(b.hdg)) * b.spd];
        const rx = b.x - a.x;
        const ry = b.y - a.y;
        return rx * (vb[0] - va[0]) + ry * (vb[1] - va[1]) < 0;
    }

    _checkSeparation() {
        const air = this.aircraft.filter((a) => a.kind !== 'mil' && (a.state === 'airborne' || a.state === 'final' || (a.state === 'takeoff' && a.alt > 0)));
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
                // a leszállási és felszállási sávban (végső megközelítés, felszállás) a gépeket a pálya
                // vezeti egymás mögött vagy párhuzamosan: ott nincs figyelmeztetés és incidens, csak ütközés
                if (this._runwayProtected(a) && this._runwayProtected(b) && d > SEPARATION.crashNm) continue;
                // két leszálló (kifutóval rendelkező érkező) egymáshoz képest: nincs jelzés, csak ütközés
                if (this._landing(a) && this._landing(b) && d > SEPARATION.crashNm) continue;
                // figyelmeztetés csak valódi veszélynél: nagyon közel vannak, vagy közelednek / keresztezik egymás útját
                if (d < SEPARATION.lossNm || this._closing(a, b) || this._pathsCross(a, b)) {
                    a.conflict = true;
                    b.conflict = true;
                }
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
                if ((a.vip || b.vip) && d < SEPARATION.lossNm && v < SEPARATION.lossFt && !this.gameOver) {
                    const vip = a.vip ? a : b;
                    const other = a.vip ? b : a;
                    this.gameOver = { reason: `Diplomáciai botrány: ${other.callsign} túl közel repült a ${vip.callsign} VIP géphez.`, callsign: vip.callsign };
                }
            }
        }
        this.lossPairs = activePairs;
        // „Korai radar”: ha 5 mp múlva konfliktus lenne, már most sárgán jelez
        for (const a of this.aircraft) a.predicted = false;
        if (this.hasPerk('earlyRadar')) {
            const ahead = (p) => fromBearing([p.x, p.y], p.hdg, p.spd * KT_TO_NMPS * 5);
            for (let i = 0; i < air.length; i++) {
                for (let j = i + 1; j < air.length; j++) {
                    const a = air[i];
                    const b = air[j];
                    if (a.conflict && b.conflict) continue;
                    const v = useAlt ? Math.abs(a.alt - b.alt) : 0;
                    if (v >= SEPARATION.warnFt) continue;
                    if (dist(ahead(a), ahead(b)) < SEPARATION.warnNm) {
                        a.predicted = true;
                        b.predicted = true;
                    }
                }
            }
        }
        for (const a of crashed) this._remove(a);
    }

    // ---------- kimenet ----------
    snapshot() {
        const r1 = (v) => Math.round(v * 10) / 10;
        const seq = this.hasPerk('sequencing') ? this._sequencing() : null;
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
                ap: a.home,
                hj: !!a.hijacked,
                sc: !!a.scrambled,
                pr: !!a.priority,
                sw: !!a.stormWarn,
                ae: a.kind === 'arr' && a.runway != null && a.state === 'airborne' && a.appPhase === 'entry' && a.appRunway === a.runway,
                vp: !!a.vip,
                ed: a.vip && !a.scrambled && !a.escortMissed ? Math.max(0, Math.ceil(a.escortDue)) : null,
                pc: !!a.predicted,
                q: !!a.queued,
                ow: a.controller == null ? null : a.controller,
                tz: this.ruleView(a).tz,
                eta: seq && seq.has(a.id) ? Math.round(seq.get(a.id).eta) : null,
                sq: seq && seq.has(a.id) && seq.get(a.id).sq ? seq.get(a.id).sq : null,
                gp: seq && seq.has(a.id) && seq.get(a.id).gp != null ? Math.round(seq.get(a.id).gp) : null
            })),
            perks: [...this.perks],
            review: this.review,
            nextReview: this.rules.noPerks ? null : {
                moves: Math.max(0, this.nextReviewMoves - this._moves()),
                seconds: Math.max(0, Math.ceil(this.nextReviewTime - this.time))
            },
            flexIn: this.hasPerk('flexExit') ? Math.max(0, Math.ceil(this.flexReadyAt - this.time)) : null,
            incoming: this.incoming.map((i) => ({ id: i.id, k: i.kind, g: i.gate, t: Math.ceil(i.t) })),
            runways: this.runways.map((r) => ({ e: r.activeEnd, w: Math.ceil(r.closingIn), c: Math.ceil(r.closedFor) })),
            fogs: this.fogs.map((f) => ({ id: f.id, x: Math.round(f.x * 100) / 100, y: Math.round(f.y * 100) / 100, r: r1(f.r) })),
            storms: this.storms.map((s) => ({ hu: !!s.hurricane, id: s.id, x: Math.round(s.x * 100) / 100, y: Math.round(s.y * 100) / 100, r: r1(s.r), core: r1(this._stormCore(s)), h: Math.round(s.hdg) }))
        };
    }

    staticInfo() {
        return {
            icao: this.airport.icao,
            name: this.airport.name,
            airspace: this.airspace,
            timeScale: TIME_SCALE,
            fafDistance: FAF_DISTANCE,
            windFrom: this.windFrom,
            gates: this.gates,
            runways: this.runways.map((r) => ({ index: r.index, airport: r.airport, names: r.names, ends: r.ends })),
            airports: this.airports,
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
