'use strict';
// Légtér – szerveroldali szimuláció.
// Koordináták tengeri mérföldben (nm): x kelet, y észak. Irány fokban, 0 = észak, óramutató szerint.
// Magasság lábban, a reptér szintjéhez képest (AGL).

const AIRPORTS = require('./airports.json');

const AIRSPACE_RADIUS = 18;
const GATE_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
const GATE_BEARINGS = [60, 120, 180, 240, 300, 0];
const FAF_DISTANCE = 6;
const GLIDE_FT_PER_NM = 318;
// A játék gyorsított időben fut: a mozgás TIME_SCALE-szer gyorsabb a valóságosnál,
// az üzemanyag- és várakozási idők viszont valódi másodpercek.
const TIME_SCALE = 2.5;
const TURN_RATE = 3 * TIME_SCALE;            // fok/s
const CLIMB_RATE = (2000 / 60) * TIME_SCALE; // láb/s
const DESCENT_RATE = (2200 / 60) * TIME_SCALE;
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
    arrivalDefault: 6000,
    departureDefault: 8000,
    transit: [13000, 17000],
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

function pointSegmentDistance(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0, 1);
    return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}

class Sim {
    constructor(airportIcao = 'LOWW', options = {}) {
        const ap = AIRPORTS[airportIcao] || AIRPORTS.LOWW;
        this.airport = ap;
        this.options = Object.assign({ traffic: 'normal' }, options);
        this.time = 0;
        this.aircraft = [];
        this.events = [];
        this.stats = { landed: 0, departed: 0, transited: 0, incidents: 0 };
        this.incidentLog = [];
        this.nextId = 1;
        this.usedCallsigns = new Set();
        this.lossPairs = new Set();
        this.timers = { arrival: 8, departure: 0, transit: 40 };
        this.gates = this._buildGates();
        this.runways = ap.runways.map((r, i) => ({
            index: i,
            names: r.names,
            ends: r.ends,
            activeEnd: 0,
            length: dist(r.ends[0], r.ends[1])
        }));
        this._chooseRunwayEndsForWind(rand(0, 360));
        for (let i = 0; i < 3; i++) this._spawnDeparture();
    }

    // ---------- felépítés ----------
    _buildGates() {
        const used = new Set();
        return GATE_BEARINGS.map((brg, i) => {
            const pos = fromBearing([0, 0], brg, AIRSPACE_RADIUS);
            let best = null;
            for (const f of this.airport.fixes) {
                if (used.has(f.name)) continue;
                const diff = Math.abs(angleDiff(brg, bearing([0, 0], f.pos)));
                if (diff < 22 && (!best || diff < best.diff)) best = { name: f.name, diff };
            }
            const name = best ? best.name : `${GATE_LETTERS[i]}GATE`;
            used.add(name);
            return { letter: GATE_LETTERS[i], name, bearing: brg, pos };
        });
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
            route: [],
            runway: null,
            exitGate: null,
            entryGate: null,
            state: 'airborne', // 'ground' | 'takeoff' | 'airborne' | 'final' | 'rollout'
            hold: false,
            fuel: 0,
            groundFuel: 0,
            conflict: false,
            spawnedAt: this.time
        };
    }

    _gateClear(gate) {
        return !this.aircraft.some((a) => a.state === 'airborne' && dist([a.x, a.y], gate.pos) < 5);
    }

    _spawnArrival() {
        const gates = this.gates.filter((g) => this._gateClear(g));
        if (!gates.length) return null;
        const gate = pick(gates);
        const a = this._base('arr');
        const inward = fromBearing(gate.pos, norm360(gate.bearing + 180), 0.5);
        a.x = inward[0];
        a.y = inward[1];
        a.hdg = norm360(gate.bearing + 180 + rand(-15, 15));
        a.alt = Math.round(rand(...ALT.arrivalSpawn) / 1000) * 1000;
        a.targetAlt = ALT.arrivalDefault;
        a.entryGate = gate.letter;
        a.fuel = FUEL.arrival * (a.cls === 'turboprop' ? 0.85 : 1);
        this.aircraft.push(a);
        this._event('info', `${a.callsign} belépett ${gate.letter} (${gate.name}) felől, leszállásra vár.`, a.id);
        return a;
    }

    _spawnTransit() {
        const gates = this.gates.filter((g) => this._gateClear(g));
        if (!gates.length) return null;
        const entry = pick(gates);
        const exits = this.gates.filter((g) => Math.abs(angleDiff(g.bearing, entry.bearing)) >= 100);
        const exit = pick(exits);
        const a = this._base('transit');
        const inward = fromBearing(entry.pos, norm360(entry.bearing + 180), 0.5);
        a.x = inward[0];
        a.y = inward[1];
        a.hdg = bearing(inward, exit.pos);
        a.alt = Math.round(rand(...ALT.transit) / 1000) * 1000;
        a.targetAlt = a.alt;
        a.entryGate = entry.letter;
        a.exitGate = exit.letter;
        a.fuel = FUEL.transit;
        this.aircraft.push(a);
        this._event('info', `${a.callsign} átrepülő: ${entry.letter} → ${exit.letter}.`, a.id);
        return a;
    }

    _spawnDeparture() {
        const a = this._base('dep');
        const gate = pick(this.gates);
        a.state = 'ground';
        a.spd = 0;
        a.targetSpd = 0;
        a.alt = 0;
        a.targetAlt = ALT.departureDefault;
        a.exitGate = gate.letter;
        a.groundFuel = FUEL.departureGround;
        a.fuel = FUEL.departureAir;
        a.runway = this._bestRunwayFor(gate.pos);
        this.aircraft.push(a);
        return a;
    }

    _bestRunwayFor(pos) {
        const target = bearing([0, 0], pos);
        let best = 0;
        let bestDiff = 999;
        for (const rw of this.runways) {
            const diff = Math.abs(angleDiff(this.landingHeading(rw), target));
            if (diff < bestDiff) { bestDiff = diff; best = rw.index; }
        }
        return best;
    }

    _trafficLevel() {
        const minutes = this.time / 60;
        const factor = { light: 1.5, normal: 1, busy: 0.7 }[this.options.traffic] || 1;
        return {
            arrival: Math.max(28, 55 - minutes * 1.5) * factor,
            departure: Math.max(32, 60 - minutes * 1.2) * factor,
            transit: Math.max(60, 110 - minutes * 2) * factor
        };
    }

    _spawnTick(dt) {
        const level = this._trafficLevel();
        for (const key of ['arrival', 'departure', 'transit']) {
            this.timers[key] -= dt;
            if (this.timers[key] > 0) continue;
            let ok;
            if (key === 'arrival') ok = this._spawnArrival();
            else if (key === 'transit') ok = this._spawnTransit();
            else ok = this.aircraft.filter((a) => a.state === 'ground').length < 6 ? this._spawnDeparture() : true;
            this.timers[key] = ok ? level[key] * rand(0.8, 1.2) : 5;
        }
    }

    // ---------- események ----------
    _event(kind, text, aircraftId = null) {
        this.events.push({ t: Math.round(this.time), kind, text, aircraftId });
    }

    _incident(a, reason) {
        this.stats.incidents += 1;
        this.incidentLog.push({ t: Math.round(this.time), callsign: a ? a.callsign : '', reason });
        this._event('incident', `INCIDENS: ${a ? `${a.callsign} – ` : ''}${reason}`, a ? a.id : null);
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
        if (a.exitGate) return this.gates.find((g) => g.letter === a.exitGate).pos;
        return null;
    }

    _cmdAddWaypoint(a, { x, y, index }) {
        if (!a || a.state === 'rollout') return [false, 'Ennek a gépnek most nem adható útpont.'];
        const p = [clamp(x, -AIRSPACE_RADIUS, AIRSPACE_RADIUS), clamp(y, -AIRSPACE_RADIUS, AIRSPACE_RADIUS)];
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
        a.hold = false;
        return [true, null];
    }

    _cmdMoveWaypoint(a, { index, x, y }) {
        if (!a || !a.route[index]) return [false, null];
        a.route[index] = [clamp(x, -AIRSPACE_RADIUS, AIRSPACE_RADIUS), clamp(y, -AIRSPACE_RADIUS, AIRSPACE_RADIUS)];
        return [true, null];
    }

    _cmdRemoveWaypoint(a, { index }) {
        if (!a || !a.route[index]) return [false, null];
        a.route.splice(index, 1);
        return [true, null];
    }

    _cmdReplaceRoute(a, { x, y }) {
        if (!a || a.state === 'rollout') return [false, null];
        if (a.state === 'final') a.state = 'airborne';
        a.route = [[x, y]];
        a.hold = false;
        return [true, null];
    }

    _cmdRunway(a, { runway }) {
        if (!a) return [false, 'Nincs kijelölt gép.'];
        const rw = this.runways[runway];
        if (!rw) return [false, 'Nincs ilyen kifutó.'];
        if (a.kind === 'transit') return [false, `${a.callsign} átrepülő, nem száll le.`];
        if (a.kind === 'dep') {
            if (a.state !== 'ground') return [false, `${a.callsign} már a levegőben van.`];
            a.runway = runway;
            return [true, `${a.callsign} felszálláshoz: ${this.runwayName(rw)}.`];
        }
        if (a.state === 'rollout') return [false, null];
        a.runway = runway;
        if (a.state === 'final') a.state = 'airborne';
        // a megközelítéshez automatikusan süllyed (a játékos utána módosíthatja)
        if (a.targetAlt > 3000) a.targetAlt = 3000;
        return [true, `${a.callsign} leszállásra engedélyezve: ${this.runwayName(rw)}.`];
    }

    _cmdTakeoff(a) {
        if (!a || a.kind !== 'dep' || a.state !== 'ground') return [false, 'Csak földön váró induló szállhat fel.'];
        const rw = this.runways[a.runway];
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
        else a.targetSpd = clamp(a.targetSpd + (delta || 0), lo, hi);
        return [true, null];
    }

    _cmdAltitude(a, { delta, to }) {
        if (!this._isAirborneControllable(a) || a.state === 'final') return [false, 'A magasság most automatikus.'];
        const max = a.kind === 'arr' ? 12000 : ALT.max;
        if (to === 'max') a.targetAlt = max;
        else if (to === 'min') a.targetAlt = ALT.min + (a.kind === 'arr' ? 1000 : 2000);
        else a.targetAlt = clamp(a.targetAlt + (delta || 0), ALT.min, max);
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
        a.route = [p1, p2, p3];
        a.targetAlt = 3000;
        a.targetSpd = a.cruise;
        a.hold = false;
        this._event('warn', `${a.callsign} átstartol (${reason}).`, a.id);
    }

    // ---------- lépés ----------
    step(dt) {
        this.time += dt;
        this._spawnTick(dt);
        for (const a of [...this.aircraft]) this._updateAircraft(a, dt);
        this._checkSeparation();
    }

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
            if (a.alt > 0 && dist([a.x, a.y], a.takeoffEnd) < 0.2 + a.spd * KT_TO_NMPS * dt) {
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
                this._event('good', `${a.callsign} leszállt.`, a.id);
                this._remove(a);
            }
            return;
        }

        // levegőben
        a.fuel -= dt;
        if (a.fuel <= 0) {
            this._incident(a, 'kifogyott az üzemanyag-tartalék, kitérő reptérre ment');
            this._remove(a);
            return;
        }

        if (a.state === 'final') {
            this._flyFinal(a, dt);
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
            } else if (a.exitGate) {
                target = this.gates.find((g) => g.letter === a.exitGate).pos;
            }
        }
        if (target) this._turnToward(a, bearing([a.x, a.y], target), dt);
        this._approachSpeedAndAlt(a, dt);
        this._move(a, dt);

        // kilépés a légtérből
        const r = Math.hypot(a.x, a.y);
        if (r > AIRSPACE_RADIUS + 0.5) {
            if ((a.kind === 'dep' || a.kind === 'transit') && a.exitGate) {
                const gate = this.gates.find((g) => g.letter === a.exitGate);
                if (dist([a.x, a.y], gate.pos) < 4) {
                    if (a.kind === 'dep') this.stats.departed += 1;
                    else this.stats.transited += 1;
                    this._event('good', `${a.callsign} átadva ${gate.letter} (${gate.name}) kapun.`, a.id);
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
        for (let i = 0; i < air.length; i++) {
            for (let j = i + 1; j < air.length; j++) {
                const a = air[i];
                const b = air[j];
                const d = dist([a.x, a.y], [b.x, b.y]);
                const v = Math.abs(a.alt - b.alt);
                if (d < SEPARATION.warnNm && v < SEPARATION.warnFt) {
                    // két gép ugyanarra a kifutóra a végső megközelítésen 2 nm-nél közelebb is lehet egymás mögött
                    const sameFinal = a.state === 'final' && b.state === 'final' && a.runway === b.runway;
                    if (sameFinal && d > 1.0) continue;
                    a.conflict = true;
                    b.conflict = true;
                    const key = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
                    if (d < SEPARATION.crashNm && v < SEPARATION.crashFt) {
                        crashed.add(a);
                        crashed.add(b);
                        this._incident(a, `ütközött: ${b.callsign}`);
                        this.stats.incidents += 1;
                        this.incidentLog.push({ t: Math.round(this.time), callsign: b.callsign, reason: `ütközött: ${a.callsign}` });
                    } else if (d < SEPARATION.lossNm && v < SEPARATION.lossFt) {
                        activePairs.add(key);
                        if (!this.lossPairs.has(key)) this._incident(a, `elkülönítés elveszett ${b.callsign} géppel`);
                    }
                }
            }
        }
        this.lossPairs = activePairs;
        for (const a of crashed) this._remove(a);
    }

    // ---------- kimenet ----------
    snapshot() {
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
                h: Math.round(a.hdg),
                s: Math.round(a.spd),
                ts: Math.round(a.targetSpd),
                al: Math.round(a.alt),
                ta: Math.round(a.targetAlt),
                st: a.state,
                rw: a.runway,
                eg: a.exitGate,
                ig: a.entryGate,
                r: a.route.map((p) => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]),
                hd: a.hold,
                f: Math.round(a.fuel),
                gf: Math.round(a.groundFuel),
                cf: a.conflict
            })),
            runways: this.runways.map((r) => r.activeEnd)
        };
    }

    staticInfo() {
        return {
            icao: this.airport.icao,
            name: this.airport.name,
            radius: AIRSPACE_RADIUS,
            fafDistance: FAF_DISTANCE,
            windFrom: this.windFrom,
            gates: this.gates,
            runways: this.runways.map((r) => ({ index: r.index, names: r.names, ends: r.ends })),
            classes: CLASSES
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
    AIRSPACE_RADIUS,
    CLASSES,
    geometry: { bearing, dist, fromBearing, angleDiff, pointSegmentDistance }
};
