'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Sim, AIRPORTS } = require('../shared/sim');
const Rules = require('../shared/rules');

function run(sim, seconds, onStep) {
    for (let t = 0; t < seconds * 10; t++) {
        sim.step(0.1);
        if (onStep) onStep(sim);
    }
}

test('minden reptér betölthető, 6 kapuval', () => {
    for (const icao of Object.keys(AIRPORTS)) {
        const sim = new Sim(icao);
        assert.strictEqual(sim.gates.length, 6, icao);
        assert.ok(sim.runways.length > 0, icao);
        assert.strictEqual(sim.aircraft.filter((a) => a.state === 'ground').length, 3, icao);
    }
});

test('érkező gép kifutó-kijelölés után leszáll', () => {
    const sim = new Sim('LOWW');
    sim.aircraft = [];
    sim.timers = { arrival: 1e9, departure: 1e9, transit: 1e9 };
    const a = sim._spawnArrival();
    assert.ok(a);
    const [ok] = sim.command({ type: 'runway', id: a.id, runway: 0 });
    assert.ok(ok);
    run(sim, 900);
    assert.strictEqual(sim.stats.landed, 1, JSON.stringify(sim.incidentLog));
    assert.strictEqual(sim.stats.incidents, 0);
});

test('induló gép felszáll és a kapunál elhagyja a légteret', () => {
    const sim = new Sim('EGLL');
    sim.timers = { arrival: 1e9, departure: 1e9, transit: 1e9 };
    const dep = sim.aircraft.find((a) => a.state === 'ground');
    sim.aircraft = [dep];
    const [ok, msg] = sim.command({ type: 'takeoff', id: dep.id });
    assert.ok(ok, msg);
    run(sim, 900);
    assert.strictEqual(sim.stats.departed, 1, JSON.stringify(sim.incidentLog));
});

test('átrepülő gép a kijelölt kapunál távozik', () => {
    const sim = new Sim('EDDF');
    sim.aircraft = [];
    sim.timers = { arrival: 1e9, departure: 1e9, transit: 1e9 };
    sim._spawnTransit();
    run(sim, 900);
    assert.strictEqual(sim.stats.transited, 1, JSON.stringify(sim.incidentLog));
});

test('útpont beszúrása a legkisebb kerülővel', () => {
    const sim = new Sim('LOWW');
    sim.aircraft = [];
    sim.timers = { arrival: 1e9, departure: 1e9, transit: 1e9 };
    const a = sim._spawnTransit();
    sim.command({ type: 'addWaypoint', id: a.id, x: 0, y: 0 });
    sim.command({ type: 'addWaypoint', id: a.id, x: a.x * 0.5, y: a.y * 0.5 });
    assert.deepStrictEqual(a.route.map((p) => p.map((v) => Math.round(v))), [[Math.round(a.x * 0.5), Math.round(a.y * 0.5)], [0, 0]]);
});

test('egymással szembe repülő gépek ütköznek', () => {
    const sim = new Sim('LOWW');
    sim.aircraft = [];
    sim.timers = { arrival: 1e9, departure: 1e9, transit: 1e9 };
    const a = sim._spawnTransit();
    const b = sim._spawnTransit();
    Object.assign(a, { x: -2, y: 0, hdg: 90, alt: 10000, targetAlt: 10000, route: [[5, 0]] });
    Object.assign(b, { x: 2, y: 0, hdg: 270, alt: 10000, targetAlt: 10000, route: [[-5, 0]] });
    run(sim, 60);
    assert.ok(sim.stats.incidents >= 2);
    assert.strictEqual(sim.aircraft.length, 0);
});

test('hosszú, irányítás nélküli futás nem dob hibát', () => {
    const sim = new Sim('KORD');
    run(sim, 1800);
    assert.ok(sim.time > 1799);
});

test('jogosultságok: szerepek és szektorok', () => {
    const players = [{ id: 1, role: 'dep', sector: 0 }, { id: 2, role: 'arr', sector: 1 }];
    const arr = { k: 'arr', st: 'airborne', x: 0, y: 20 };
    const dep = { k: 'dep', st: 'ground', x: 0, y: 0 };
    assert.ok(!Rules.canControl(arr, players[0], { mode: 'roles' }, players));
    assert.ok(Rules.canControl(arr, players[1], { mode: 'roles' }, players));
    assert.ok(Rules.canControl(dep, players[0], { mode: 'roles' }, players));
    // két szektor: 0 = kelet (0–180°), 1 = nyugat
    const east = { k: 'arr', st: 'airborne', x: 20, y: 1 };
    assert.ok(Rules.canControl(east, players[0], { mode: 'sector' }, players));
    assert.ok(!Rules.canControl(east, players[1], { mode: 'sector' }, players));
    assert.ok(Rules.canControl(dep, players[1], { mode: 'sector' }, players));
    assert.ok(Rules.canControl(east, players[1], { mode: 'free' }, players));
});
