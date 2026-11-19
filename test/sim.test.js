'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Sim, AIRPORTS, AIRSPACE } = require('../shared/sim');
const Rules = require('../shared/rules');

const QUIET = { storms: false, fog: false, emergencies: false, constraints: false, security: false };

function makeSim(icao, rules = {}, extra = {}) {
    const sim = new Sim(icao, Object.assign({ rules: Object.assign({}, QUIET, rules) }, extra));
    sim.timers.arrival = sim.timers.departure = sim.timers.transit = 1e9;
    return sim;
}

function run(sim, seconds) {
    for (let t = 0; t < seconds * 10 && (sim.aircraft.length || sim.storms.length); t++) sim.step(0.1);
}

test('minden pálya betölthető, a kapuk a légtér szélén vannak', () => {
    for (const icao of Object.keys(AIRPORTS)) {
        const sim = new Sim(icao);
        const as = sim.airspace;
        assert.strictEqual(sim.gates.length, 6, icao);
        for (const g of sim.gates) {
            const onEdge = Math.abs(Math.abs(g.pos[0]) - as.hw) < 0.05 || Math.abs(Math.abs(g.pos[1]) - as.hh) < 0.05;
            assert.ok(onEdge, `${icao} ${g.letter} ${g.pos}`);
        }
        assert.deepStrictEqual(sim.gates.map((g) => g.letter), ['A', 'B', 'C', 'D', 'E', 'F']);
        assert.ok(sim.aircraft.filter((a) => a.state === 'ground').length >= 3, icao);
        for (const a of sim.aircraft) assert.strictEqual(sim.runways[a.runway].airport, a.home, icao);
    }
});

test('véletlen kapuk: 4–6 kapu a szélen', () => {
    for (let i = 0; i < 20; i++) {
        const sim = makeSim('EDDF', { randomGates: true });
        assert.ok(sim.gates.length >= 4 && sim.gates.length <= 6);
    }
});

test('érkező gép kifutó-kijelölés után leszáll', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    const a = sim._spawnArrival();
    assert.ok(sim.command({ type: 'runway', id: a.id, runway: 0 })[0]);
    run(sim, 900);
    assert.strictEqual(sim.stats.landed, 1, JSON.stringify(sim.incidentLog));
    assert.strictEqual(sim.stats.incidents, 0);
    assert.strictEqual(sim.stats.score, Math.round(10 * sim.multiplier));
});

test('induló gép felszáll és a kapunál elhagyja a légteret', () => {
    const sim = makeSim('EGLL');
    const dep = sim.aircraft.find((a) => a.state === 'ground');
    sim.aircraft = [dep];
    const [ok, msg] = sim.command({ type: 'takeoff', id: dep.id });
    assert.ok(ok, msg);
    run(sim, 900);
    assert.strictEqual(sim.stats.departed, 1, JSON.stringify(sim.incidentLog));
});

test('átrepülő gép a kijelölt kapunál távozik', () => {
    const sim = makeSim('EDDF');
    sim.aircraft = [];
    sim._spawnTransit();
    run(sim, 900);
    assert.strictEqual(sim.stats.transited, 1, JSON.stringify(sim.incidentLog));
});

test('kézi útvonal: útpont nélkül az átrepülő nem találja a kapuját', () => {
    const sim = makeSim('EDDF', { manualRouting: true });
    sim.aircraft = [];
    const a = sim._spawnTransit();
    // a célkapu a belépési kapu szomszédja, így az egyenesen repülő gép biztosan nem azon lép ki
    const idx = sim.gates.findIndex((g) => g.letter === a.entryGate);
    a.exitGate = sim.gates[(idx + 1) % sim.gates.length].letter;
    run(sim, 900);
    assert.strictEqual(sim.stats.transited, 0);
    assert.strictEqual(sim.stats.incidents, 1);
});

test('kézi útvonal: a kapu elé tett útpont után a kapura fordul', () => {
    const sim = makeSim('EDDF', { manualRouting: true });
    sim.aircraft = [];
    const a = sim._spawnTransit();
    const gate = sim.gates.find((g) => g.letter === a.exitGate);
    sim.command({ type: 'addWaypoint', id: a.id, x: gate.pos[0] * 0.8, y: gate.pos[1] * 0.8 });
    run(sim, 900);
    assert.strictEqual(sim.stats.transited, 1, JSON.stringify(sim.incidentLog));
});

test('magasság be: az induló csak a kilépési szinten adható át', () => {
    const sim = makeSim('EGLL', { altitude: true });
    const dep = sim.aircraft[0];
    sim.aircraft = [dep];
    sim.command({ type: 'takeoff', id: dep.id });
    run(sim, 900);
    assert.strictEqual(sim.stats.departed, 0);
    assert.match(sim.incidentLog[0].reason, /magasságon/);

    const sim2 = makeSim('EGLL', { altitude: true });
    const dep2 = sim2.aircraft[0];
    sim2.aircraft = [dep2];
    sim2.command({ type: 'takeoff', id: dep2.id });
    while (dep2.targetAlt < dep2.exitAlt) sim2.command({ type: 'altitude', id: dep2.id, delta: 1000 });
    run(sim2, 900);
    assert.strictEqual(sim2.stats.departed, 1, JSON.stringify(sim2.incidentLog));
});

test('magasság ki: a magassági parancs nem elérhető, az elkülönítés csak vízszintes', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    const a = sim._spawnTransit();
    const b = sim._spawnTransit();
    assert.strictEqual(sim.command({ type: 'altitude', id: a.id, delta: 1000 })[0], false);
    Object.assign(a, { x: -1, y: 0, hdg: 90, alt: 15000, targetAlt: 15000, route: [[5, 0]] });
    Object.assign(b, { x: 1, y: 0, hdg: 270, alt: 10000, targetAlt: 10000, route: [[-5, 0]] });
    sim.step(0.1);
    assert.ok(a.conflict && b.conflict);
});

test('útpont beszúrása a legkisebb kerülővel', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    const a = sim._spawnTransit();
    sim.command({ type: 'addWaypoint', id: a.id, x: 0, y: 0 });
    sim.command({ type: 'addWaypoint', id: a.id, x: a.x * 0.5, y: a.y * 0.5 });
    assert.deepStrictEqual(a.route.map((p) => p.map((v) => Math.round(v))), [[Math.round(a.x * 0.5), Math.round(a.y * 0.5)], [0, 0]]);
});

test('egymással szembe repülő gépek ütköznek', () => {
    const sim = makeSim('LOWW', { altitude: true });
    sim.aircraft = [];
    const a = sim._spawnTransit();
    const b = sim._spawnTransit();
    Object.assign(a, { x: -2, y: 0, hdg: 90, alt: 10000, targetAlt: 10000, route: [[5, 0]] });
    Object.assign(b, { x: 2, y: 0, hdg: 270, alt: 10000, targetAlt: 10000, route: [[-5, 0]] });
    for (let i = 0; i < 600; i++) sim.step(0.1);
    assert.ok(sim.stats.incidents >= 2);
    assert.strictEqual(sim.aircraft.length, 0);
});

test('zivatar: előbb figyelmeztet, a piros magba repülés a műszak végét jelenti', () => {
    const sim = makeSim('LOWW', { storms: true });
    sim.aircraft = [];
    sim.timers.storm = 1e9;
    sim.storms.push({ id: 1, x: 0, y: 0, r: 3, hdg: 0, spd: 0, age: 100, life: 1000, turnIn: 1e9 });
    const a = sim._spawnTransit();
    Object.assign(a, { x: -5, y: 0, hdg: 90, route: [[4, 0]] });
    let warned = false;
    for (let i = 0; i < 600 && !sim.gameOver; i++) {
        sim.step(0.1);
        if (a.stormWarn) warned = true;
    }
    assert.ok(warned, 'nem figyelmeztetett');
    assert.ok(sim.gameOver);
    assert.match(sim.gameOver.reason, /zivatar/);
});

test('zivatar: a külső rétegen átrepülni szabad', () => {
    const sim = makeSim('LOWW', { storms: true });
    sim.aircraft = [];
    sim.timers.storm = 1e9;
    sim.storms.push({ id: 1, x: 0, y: 0, r: 3, hdg: 0, spd: 0, age: 100, life: 1000, turnIn: 1e9 });
    const a = sim._spawnTransit();
    Object.assign(a, { x: -5, y: 2, hdg: 90, route: [[5, 2]] });
    for (let i = 0; i < 600; i++) sim.step(0.1);
    assert.strictEqual(sim.gameOver, null);
});

test('köd: a benne lévő gép egyenesen repül és nem irányítható, kiérve folytatja az útvonalat', () => {
    const sim = makeSim('LOWW', { fog: true });
    sim.aircraft = [];
    sim.timers.fog = 1e9;
    sim.fogs.push({ id: 1, x: 0, y: 0, r: 2, hdg: 0, spd: 0, age: 0, life: 1e9, turnIn: 1e9 });
    const a = sim._spawnTransit();
    Object.assign(a, { x: -1, y: 0, hdg: 90, route: [[0, -8]] });
    sim.step(0.1);
    assert.ok(a.fogged);
    const hdg = a.hdg;
    for (let i = 0; i < 20; i++) sim.step(0.1);
    assert.strictEqual(a.hdg, hdg, 'ködben nem fordulhat');
    const [ok, msg] = sim.command({ type: 'addWaypoint', id: a.id, x: 5, y: 5 });
    assert.strictEqual(ok, false);
    assert.match(msg, /köd/);
    for (let i = 0; i < 400 && a.fogged; i++) sim.step(0.1);
    assert.ok(!a.fogged);
    for (let i = 0; i < 30; i++) sim.step(0.1);
    assert.notStrictEqual(Math.round(a.hdg), Math.round(hdg), 'kiérve az útvonal felé fordul');
    assert.ok(sim.command({ type: 'speed', id: a.id, delta: 10 })[0]);
});

test('időjárás: ritka, kicsi, és egyszerre legfeljebb egy zivatar és egy köd', () => {
    const sim = new Sim('EDDF', { rules: { storms: true, fog: true, emergencies: false, constraints: false } });
    let maxStorms = 0;
    let maxFogs = 0;
    let stormsSeen = new Set();
    for (let i = 0; i < 36000 && !sim.gameOver; i++) {
        sim.step(0.1);
        maxStorms = Math.max(maxStorms, sim.storms.length);
        maxFogs = Math.max(maxFogs, sim.fogs.length);
        for (const st of sim.storms) {
            stormsSeen.add(st.id);
            assert.ok(st.r <= 3.5 && st.spd <= 0.014);
        }
    }
    assert.ok(maxStorms <= 1 && maxFogs <= 1);
    assert.ok(stormsSeen.size >= 1 && stormsSeen.size <= 12, `${stormsSeen.size} zivatar egy óra alatt`);
});

test('kifutó-ellenőrzés: lezárás után nem lehet felszállni, az érkező elveszti a kifutót', () => {
    const sim = makeSim('EDDF', { constraints: true });
    sim.timers.constraint = 0;
    const arr = sim._spawnArrival();
    sim.step(0.1);
    const rw = sim.runways.find((r) => r.closingIn > 0);
    assert.ok(rw);
    sim.command({ type: 'runway', id: arr.id, runway: rw.index });
    for (let i = 0; i < 620; i++) sim.step(0.1);
    assert.ok(rw.closedFor > 0);
    assert.strictEqual(arr.runway, null);
    assert.strictEqual(sim.command({ type: 'runway', id: arr.id, runway: rw.index })[0], false);
    for (const d of sim.aircraft.filter((a) => a.state === 'ground')) assert.notStrictEqual(d.runway, rw.index);
});

test('vészhelyzet: időben leszállva bónuszpont', () => {
    const sim = makeSim('LOWW', { emergencies: true });
    sim.aircraft = [];
    const a = sim._spawnArrival();
    Object.assign(a, { x: a.x / 2, y: a.y / 2 });
    sim.timers.emergency = 0;
    sim.step(0.1);
    assert.ok(a.emergency);
    sim.timers.emergency = 1e9;
    sim.command({ type: 'runway', id: a.id, runway: 0 });
    run(sim, 900);
    assert.strictEqual(sim.stats.landed, 1, JSON.stringify(sim.incidentLog));
    assert.strictEqual(sim.stats.emergencies, 1);
    assert.strictEqual(sim.stats.score, Math.round(25 * sim.multiplier));
});

test('gyakorló mód: csak érkezők', () => {
    const sim = new Sim('KORD', { practice: 'arr', rules: QUIET });
    for (let i = 0; i < 3000; i++) sim.step(0.1);
    assert.ok(sim.aircraft.length > 0);
    assert.ok(sim.aircraft.every((a) => a.kind === 'arr'));
});

test('hosszú, irányítás nélküli futás minden eseménnyel sem dob hibát', () => {
    const sim = new Sim('KORD', { rules: Rules.PRESETS.hard.rules, traffic: 150 });
    for (let i = 0; i < 36000; i++) sim.step(0.1);
    assert.ok(sim.time > 3599);
});

test('szorzó és beállítások ellenőrzése', () => {
    const shift = Rules.normalizeShift({ rules: { altitude: true, storms: 'igen' }, traffic: 125, practice: 'x' });
    assert.strictEqual(shift.rules.altitude, true);
    assert.strictEqual(shift.rules.storms, true);
    assert.strictEqual(shift.traffic, 125);
    assert.strictEqual(shift.practice, 'all');
    assert.strictEqual(Rules.scoreMultiplier(Rules.defaultShift()), 1);
    assert.strictEqual(Rules.scoreMultiplier(shift), 1.5);
    assert.strictEqual(Rules.presetOf(Rules.PRESETS.hard.rules), 'hard');
    assert.strictEqual(Rules.presetOf(shift.rules), 'custom');
});

test('jogosultságok: szerepek és szektorok', () => {
    const players = [{ id: 1, role: 'dep', sector: 0 }, { id: 2, role: 'arr', sector: 1 }];
    const arr = { k: 'arr', st: 'airborne', x: 0, y: 20 };
    const dep = { k: 'dep', st: 'ground', x: 0, y: 0 };
    assert.ok(!Rules.canControl(arr, players[0], { mode: 'roles' }, players));
    assert.ok(Rules.canControl(arr, players[1], { mode: 'roles' }, players));
    assert.ok(Rules.canControl(dep, players[0], { mode: 'roles' }, players));
    const east = { k: 'arr', st: 'airborne', x: 20, y: 1 };
    assert.ok(Rules.canControl(east, players[0], { mode: 'sector' }, players));
    assert.ok(!Rules.canControl(east, players[1], { mode: 'sector' }, players));
    assert.ok(Rules.canControl(dep, players[1], { mode: 'sector' }, players));
    assert.ok(Rules.canControl(east, players[1], { mode: 'free' }, players));
});

// ---------- többrepteres pálya ----------
test('többrepteres pálya: a repterek száma a játékosok számától függ, a gépek felváltva oszlanak el', () => {
    const two = new Sim('LONDON', { rules: QUIET }, { airportCount: 2 });
    assert.strictEqual(two.airports.length, 2);
    assert.ok(two.runways.every((r) => r.airport < 2));
    const three = new Sim('LONDON', { rules: QUIET }, { airportCount: 3 });
    assert.strictEqual(three.airports.length, 3);
    three.aircraft = [];
    const homes = [];
    for (let i = 0; i < 6; i++) {
        const a = three._spawnArrival() || three._spawnTransit();
        homes.push(a.home);
        three.aircraft = [];
    }
    assert.deepStrictEqual(new Set(homes), new Set([0, 1, 2]));
});

test('többrepteres pálya: csak a saját reptér kifutójára lehet leszállni, és oda le is száll', () => {
    const sim = new Sim('NEWYORK', { rules: QUIET }, { airportCount: 2 });
    sim.timers.arrival = sim.timers.departure = sim.timers.transit = 1e9;
    sim.aircraft = [];
    const a = sim._spawnArrival();
    const foreign = sim.runways.find((r) => r.airport !== a.home);
    const own = sim.runways.find((r) => r.airport === a.home);
    assert.strictEqual(sim.command({ type: 'runway', id: a.id, runway: foreign.index })[0], false);
    assert.ok(sim.command({ type: 'runway', id: a.id, runway: own.index })[0]);
    run(sim, 900);
    assert.strictEqual(sim.stats.landed, 1, JSON.stringify(sim.incidentLog));
});

test('Saját reptér mód: mindenki csak a saját repterének gépeit irányítja', () => {
    const players = [{ id: 1, airport: 0 }, { id: 2, airport: 1 }, { id: 3, airport: 2 }];
    const ac = { k: 'arr', st: 'airborne', x: 3, y: 3, ap: 1 };
    const settings = { mode: 'airports' };
    assert.ok(!Rules.canControl(ac, players[0], settings, players));
    assert.ok(Rules.canControl(ac, players[1], settings, players));
    assert.ok(!Rules.canControl({ k: 'mil', st: 'airborne', x: 0, y: 0 }, players[1], settings, players));
});

// ---------- új események ----------
test('kényszerleszállás: a reptéren senki más nem száll le, amíg a gép le nem száll', () => {
    const sim = makeSim('LOWW', { emergencies: true });
    sim.aircraft = [];
    const em = sim._spawnArrival();
    const other = sim._spawnArrival();
    sim.forceForcedLanding = true;
    sim.timers.emergency = 0;
    // csak az első gép lehet jelölt: a másik kevés üzemanyaggal nem jelölt
    other.fuel = 150;
    sim.step(0.1);
    other.fuel = 600;
    sim.timers.emergency = 1e9;
    assert.ok(em.priority, 'kényszerleszállás');
    sim.command({ type: 'runway', id: other.id, runway: 0 });
    sim.command({ type: 'runway', id: em.id, runway: 1 });
    Object.assign(other, { x: other.x / 3, y: other.y / 3 });
    let otherLandedFirst = false;
    for (let i = 0; i < 9000 && sim.aircraft.includes(em); i++) {
        sim.step(0.1);
        if (other.state === 'final' || other.state === 'rollout') otherLandedFirst = true;
    }
    assert.ok(!otherLandedFirst, 'a másik gép nem kezdhet leszállni');
    assert.strictEqual(sim.stats.landed, 1, JSON.stringify(sim.incidentLog));
    run(sim, 900);
    assert.strictEqual(sim.stats.landed, 2, 'utána a másik is leszáll: ' + JSON.stringify(sim.incidentLog));
});

test('eltérítés: a vadászgépek elfogják, a gép kényszerleszállást hajt végre', () => {
    const sim = makeSim('LOWW', { security: true });
    sim.aircraft = [];
    const a = sim._spawnTransit();
    Object.assign(a, { x: 0, y: -13, hdg: 0 });
    sim.timers.hijack = 0;
    sim.step(0.1);
    sim.timers.hijack = 1e9;
    assert.ok(a.hijacked);
    assert.strictEqual(sim.command({ type: 'speed', id: a.id, delta: 10 })[0], false);
    assert.ok(sim.command({ type: 'scramble', id: a.id })[0]);
    assert.strictEqual(sim.command({ type: 'scramble', id: a.id })[0], false);
    for (let i = 0; i < 1200 && a.hijacked && !sim.gameOver; i++) sim.step(0.1);
    assert.ok(!a.hijacked && !sim.gameOver, 'elfogás');
    assert.strictEqual(a.kind, 'arr');
    assert.ok(a.priority && a.runway != null);
    run(sim, 900);
    assert.strictEqual(sim.stats.landed, 1, JSON.stringify(sim.incidentLog));
    assert.ok(!sim.aircraft.some((x) => x.kind === 'mil'), 'a vadászgépek hazamennek');
});

test('eltérítés: ha senki nem indít vadászgépet, a műszak véget ér', () => {
    const sim = makeSim('LOWW', { security: true });
    sim.aircraft = [];
    const a = sim._spawnTransit();
    Object.assign(a, { x: 0, y: -13, hdg: 0 });
    sim.timers.hijack = 0;
    for (let i = 0; i < 3000 && !sim.gameOver; i++) sim.step(0.1);
    assert.ok(sim.gameOver);
    assert.match(sim.gameOver.reason, /eltérített/);
});

test('hurrikán: nagyobb zivatar, a magja a műszak végét jelenti', () => {
    const sim = makeSim('LOWW', { storms: true });
    sim.forceHurricane = true;
    sim.timers.storm = 0;
    sim.step(0.1);
    assert.strictEqual(sim.storms.length, 1);
    assert.ok(sim.storms[0].hurricane && sim.storms[0].r >= 6);
});
