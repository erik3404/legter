'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Sim, AIRPORTS, AIRSPACE } = require('../shared/sim');
const Rules = require('../shared/rules');

const QUIET = { storms: false, emergencies: false, constraints: false };

function makeSim(icao, rules = {}, extra = {}) {
    const sim = new Sim(icao, Object.assign({ rules: Object.assign({}, QUIET, rules) }, extra));
    sim.timers.arrival = sim.timers.departure = sim.timers.transit = 1e9;
    return sim;
}

function run(sim, seconds) {
    for (let t = 0; t < seconds * 10 && (sim.aircraft.length || sim.storms.length); t++) sim.step(0.1);
}

test('minden reptér betölthető, a kapuk a légtér szélén vannak', () => {
    for (const icao of Object.keys(AIRPORTS)) {
        const sim = new Sim(icao);
        assert.strictEqual(sim.gates.length, 6, icao);
        for (const g of sim.gates) {
            const onEdge = Math.abs(Math.abs(g.pos[0]) - AIRSPACE.hw) < 0.05 || Math.abs(Math.abs(g.pos[1]) - AIRSPACE.hh) < 0.05;
            assert.ok(onEdge, `${icao} ${g.letter} ${g.pos}`);
        }
        assert.deepStrictEqual(sim.gates.map((g) => g.letter), ['A', 'B', 'C', 'D', 'E', 'F']);
        assert.strictEqual(sim.aircraft.filter((a) => a.state === 'ground').length, 3, icao);
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

test('zivatar: a piros magba repülés incidens', () => {
    const sim = makeSim('LOWW', { storms: true });
    sim.aircraft = [];
    sim.timers.storm = 1e9;
    sim.storms.push({ id: 1, x: 0, y: 0, r: 5, hdg: 0, spd: 0, age: 0, life: 1000, turnIn: 1e9 });
    const a = sim._spawnTransit();
    Object.assign(a, { x: -4, y: 0, hdg: 90, route: [[4, 0]] });
    for (let i = 0; i < 300; i++) sim.step(0.1);
    assert.strictEqual(sim.incidentLog.filter((x) => /zivatar/.test(x.reason)).length, 1);
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
