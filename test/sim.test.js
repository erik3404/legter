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

// ---------- fejlesztések ----------
test('értékelés: 30 lekezelt gép vagy 8 perc után 3 fejlesztésből lehet választani', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    sim.stats.landed = 30;
    sim.step(0.1);
    assert.ok(sim.review && sim.review.options.length === 3);
    const pick = sim.review.options[1];
    assert.strictEqual(sim.command({ type: 'choosePerk', perk: 'nincs-ilyen' })[0], false);
    assert.ok(sim.command({ type: 'choosePerk', perk: pick })[0]);
    assert.ok(sim.hasPerk(pick) && sim.review === null);
    sim.step(0.1);
    assert.strictEqual(sim.review, null, 'a következő csak újabb 30 gép után');
    sim.time = 1000;
    sim.step(0.1);
    assert.ok(sim.review && !sim.review.options.includes(pick), 'idő alapján is jön, a meglévő nem ajánlható újra');
});

test('Fejlesztések nélkül szabály: nincs értékelés', () => {
    const sim = makeSim('LOWW', { noPerks: true });
    sim.stats.landed = 100;
    sim.time = 5000;
    sim.step(0.1);
    assert.strictEqual(sim.review, null);
    assert.ok(Math.abs(sim.multiplier / makeSim('LOWW').multiplier - 1.1) < 0.02);
});

test('Fürge szárnyak: 25%-kal gyorsabb fordulás', () => {
    const turnIn = (perk) => {
        const sim = makeSim('LOWW');
        sim.aircraft = [];
        if (perk) sim.perks.add('agile');
        const a = sim._spawnTransit();
        Object.assign(a, { x: 0, y: 0, hdg: 0, route: [[10, 0]] });
        sim.step(1);
        return a.hdg;
    };
    assert.ok(Math.abs(turnIn(true) / turnIn(false) - 1.25) < 0.01);
});

test('Felszállási sor: foglalt kifutónál sorba áll, és magától felszáll', () => {
    const sim = makeSim('EGLL');
    const [d1, d2] = sim.aircraft.filter((a) => a.state === 'ground');
    sim.aircraft = [d1, d2];
    d2.runway = d1.runway;
    assert.ok(sim.command({ type: 'takeoff', id: d1.id })[0]);
    assert.strictEqual(sim.command({ type: 'takeoff', id: d2.id })[0], false, 'fejlesztés nélkül nem áll sorba');
    sim.perks.add('takeoffQueue');
    const [ok, msg] = sim.command({ type: 'takeoff', id: d2.id });
    assert.ok(ok && d2.queued, msg);
    for (let i = 0; i < 600 && d2.state === 'ground'; i++) sim.step(0.1);
    assert.strictEqual(d2.state, 'takeoff');
});

test('Pontos sebesség és Rugalmas kijárat csak fejlesztéssel, kijáratcsere 2 percenként', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    const a = sim._spawnTransit();
    assert.strictEqual(sim.command({ type: 'speed', id: a.id, value: 200 })[0], false);
    sim.perks.add('exactSpeed');
    assert.ok(sim.command({ type: 'speed', id: a.id, value: 999 })[0]);
    assert.strictEqual(a.targetSpd, Math.round(a.cruise * 1.2));
    const other = sim.gates.find((g) => g.letter !== a.exitGate);
    assert.strictEqual(sim.command({ type: 'changeExit', id: a.id, gate: other.letter })[0], false);
    sim.perks.add('flexExit');
    assert.ok(sim.command({ type: 'changeExit', id: a.id, gate: other.letter })[0]);
    assert.strictEqual(a.exitGate, other.letter);
    const third = sim.gates.find((g) => g.letter !== a.exitGate);
    assert.strictEqual(sim.command({ type: 'changeExit', id: a.id, gate: third.letter })[0], false, 'várakozási idő');
});

test('Korábbi átvétel: a belépő gép 6 mp-cel előbb jelzésként látszik', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    sim.perks.add('earlyHandoff');
    sim.timers.arrival = 0;
    sim.step(0.1);
    sim.timers.arrival = 1e9;
    assert.strictEqual(sim.incoming.length, 1);
    assert.strictEqual(sim.aircraft.length, 0);
    for (let i = 0; i < 61; i++) sim.step(0.1);
    assert.strictEqual(sim.incoming.length, 0);
    assert.strictEqual(sim.aircraft.filter((a) => a.kind === 'arr').length, 1);
});

test('Sorrendjelzés: sorszám és távköz kifutónként', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    sim.perks.add('sequencing');
    const a = sim._spawnArrival();
    const b = sim._spawnArrival() || sim._spawnArrival();
    sim.command({ type: 'runway', id: a.id, runway: 0 });
    sim.command({ type: 'runway', id: b.id, runway: 0 });
    Object.assign(a, { x: a.x / 3, y: a.y / 3 });
    const snap = sim.snapshot();
    const sa = snap.aircraft.find((x) => x.id === a.id);
    const sb = snap.aircraft.find((x) => x.id === b.id);
    assert.deepStrictEqual([sa.sq, sb.sq].sort(), [1, 2]);
    assert.ok((sa.sq === 2 ? sa.gp : sb.gp) >= 0);
    assert.ok(sa.eta > 0);
});

// ---------- VIP ----------
test('VIP gép: kifutók zárva, kíséret nélkül incidens, kísérettel leszállva +30 pont', () => {
    const sim = makeSim('LOWW', { security: true });
    sim.timers.hijack = 1e9;
    const dep = sim.aircraft.find((a) => a.state === 'ground');
    sim.aircraft = [dep];
    sim.timers.vip = 0;
    sim.step(0.1);
    const vip = sim.aircraft.find((a) => a.vip);
    assert.ok(vip && vip.priority);
    const [ok, msg] = sim.command({ type: 'takeoff', id: dep.id });
    assert.strictEqual(ok, false);
    assert.match(msg, /VIP/);
    assert.ok(sim.command({ type: 'scramble', id: vip.id })[0]);
    assert.strictEqual(sim.aircraft.filter((a) => a.kind === 'mil').length, 2);
    sim.command({ type: 'runway', id: vip.id, runway: 0 });
    const before = sim.stats.base;
    for (let i = 0; i < 9000 && sim.aircraft.includes(vip); i++) sim.step(0.1);
    assert.strictEqual(sim.stats.landed, 1, JSON.stringify(sim.incidentLog));
    assert.strictEqual(sim.stats.base - before, 10 + 30);
    assert.ok(sim.command({ type: 'takeoff', id: dep.id })[0], 'utána lehet felszállni');

    const late = makeSim('LOWW', { security: true });
    late.timers.hijack = 1e9;
    late.aircraft = [];
    late.timers.vip = 0;
    for (let i = 0; i < 650; i++) late.step(0.1);
    assert.ok(late.incidentLog.some((x) => /kíséret nélkül/.test(x.reason)));
});

test('VIP gép: ha valaki túl közel repül hozzá, vége a műszaknak', () => {
    const sim = makeSim('LOWW', { security: true });
    sim.timers.hijack = 1e9;
    sim.aircraft = [];
    sim.timers.vip = 0;
    sim.step(0.1);
    sim.timers.vip = 1e9;
    const vip = sim.aircraft.find((a) => a.vip);
    const t = sim._spawnTransit();
    Object.assign(vip, { x: -1, y: 0, hdg: 90, route: [[5, 0]] });
    Object.assign(t, { x: 1, y: 0, hdg: 270, route: [[-5, 0]] });
    for (let i = 0; i < 50 && !sim.gameOver; i++) sim.step(0.1);
    assert.ok(sim.gameOver);
    assert.match(sim.gameOver.reason, /Diplomáciai/);
});

// ---------- posztok és átadás ----------
test('Bevezető – Torony – Kivezető: a zónától függ, ki irányít', () => {
    const players = [{ id: 1, role: 'app' }, { id: 2, role: 'twr' }, { id: 3, role: 'dep' }];
    const s = { mode: 'positions' };
    const arrFar = { k: 'arr', st: 'airborne', x: 15, y: 0, tz: false };
    const arrZone = { k: 'arr', st: 'final', x: 3, y: 0, tz: true };
    const depFar = { k: 'dep', st: 'airborne', x: 10, y: 0, tz: false };
    assert.deepStrictEqual(Rules.ownersOf(arrFar, s, players).map((p) => p.id), [1]);
    assert.deepStrictEqual(Rules.ownersOf(arrZone, s, players).map((p) => p.id), [2]);
    assert.deepStrictEqual(Rules.ownersOf(depFar, s, players).map((p) => p.id), [3]);
    const two = [{ id: 1, role: 'apptwr' }, { id: 3, role: 'dep' }];
    assert.deepStrictEqual(Rules.ownersOf(arrZone, s, two).map((p) => p.id), [1]);
    assert.strictEqual(Rules.roleProblems('positions', players), null);
    assert.match(Rules.roleProblems('positions', [{ role: 'app' }, { role: 'app' }]), /Senki/);
});

test('Érkező – Induló – Ügyeletes: különleges esetek az ügyeletesé', () => {
    const players = [{ id: 1, role: 'arr' }, { id: 2, role: 'dep' }, { id: 3, role: 'duty' }];
    const s = { mode: 'roles' };
    assert.deepStrictEqual(Rules.ownersOf({ k: 'arr', st: 'airborne' }, s, players).map((p) => p.id), [1]);
    assert.deepStrictEqual(Rules.ownersOf({ k: 'arr', st: 'airborne', em: 1 }, s, players).map((p) => p.id), [3]);
    assert.deepStrictEqual(Rules.ownersOf({ k: 'arr', st: 'airborne', vp: true }, s, players).map((p) => p.id), [3]);
    assert.deepStrictEqual(Rules.ownersOf({ k: 'transit', st: 'airborne' }, s, players).map((p) => p.id), [3]);
    const two = players.slice(0, 2);
    assert.deepStrictEqual(Rules.ownersOf({ k: 'arr', st: 'airborne', em: 1 }, s, two).map((p) => p.id), [1], 'ügyeletes nélkül az érkezőé');
});

test('átadás: a megkapott gépet csak az új gazdája irányítja', () => {
    const players = [{ id: 1, role: 'arr' }, { id: 2, role: 'dep' }];
    const ac = { k: 'arr', st: 'airborne', ow: 2 };
    assert.deepStrictEqual(Rules.ownersOf(ac, { mode: 'roles' }, players).map((p) => p.id), [2]);
    assert.deepStrictEqual(Rules.ownersOf({ k: 'arr', st: 'airborne', ow: 9 }, { mode: 'roles' }, players).map((p) => p.id), [1], 'kilépett gazda');
});

test('a légtér a képernyő arányához igazodik, multiban nagyobb', () => {
    const wide = new Sim('LOWW', { rules: QUIET }, { aspect: 2 });
    assert.ok(Math.abs(wide.airspace.hw / wide.airspace.hh - 2) < 0.05);
    const tall = new Sim('LOWW', { rules: QUIET }, { aspect: 0.6 });
    assert.ok(tall.airspace.hh > tall.airspace.hw);
    const solo = new Sim('LOWW', { rules: QUIET }, { aspect: 1.7, players: 1 });
    const trio = new Sim('LOWW', { rules: QUIET }, { aspect: 1.7, players: 3 });
    const area = (x) => x.airspace.hw * x.airspace.hh;
    assert.ok(Math.abs(area(trio) / area(solo) - 1.3) < 0.05);
    for (const g of trio.gates) {
        const as = trio.airspace;
        assert.ok(Math.abs(Math.abs(g.pos[0]) - as.hw) < 0.05 || Math.abs(Math.abs(g.pos[1]) - as.hh) < 0.05);
    }
});

test('körözés: útpont, útpont-húzás vagy kifutó után abbahagyja', () => {
    const sim = makeSim('LOWW');
    sim.aircraft = [];
    const a = sim._spawnArrival();
    for (const [cmd, extra] of [['addWaypoint', { x: 3, y: 3 }], ['runway', { runway: 0 }], ['replaceRoute', { x: 2, y: 2 }]]) {
        sim.command({ type: 'hold', id: a.id });
        assert.ok(a.hold);
        assert.ok(sim.command(Object.assign({ type: cmd, id: a.id }, extra))[0], cmd);
        assert.ok(!a.hold, `${cmd} után nem köröz`);
    }
    a.route = [[1, 1]];
    sim.command({ type: 'hold', id: a.id });
    sim.command({ type: 'moveWaypoint', id: a.id, index: 0, x: 4, y: 4 });
    assert.ok(!a.hold, 'húzás után nem köröz');
});

test('felszálló: számgombbal kifutó, felszállás előtt útpont, a kifutó vége után fordul', () => {
    const sim = makeSim('EDDF');
    const d = sim.aircraft.find((a) => a.state === 'ground');
    sim.aircraft = [d];
    const other = sim.runways.find((r) => r.airport === d.home && r.index !== d.runway);
    assert.ok(sim.command({ type: 'runway', id: d.id, runway: other.index })[0]);
    assert.strictEqual(d.runway, other.index);
    const gate = sim.gates.find((g) => g.letter === d.exitGate);
    assert.ok(sim.command({ type: 'addWaypoint', id: d.id, x: gate.pos[0] / 2, y: gate.pos[1] / 2 })[0], 'földön is adható útpont');
    sim.command({ type: 'takeoff', id: d.id });
    const rw = sim.runways[d.runway];
    const hdg = sim.landingHeading(rw);
    const far = sim.threshold(rw, 1 - rw.activeEnd);
    // amíg a kifutó vége után 1 nm-t meg nem tett, nem fordul el
    for (let i = 0; i < 3000 && d.state === 'takeoff'; i++) {
        sim.step(0.1);
        assert.ok(Math.abs(((d.hdg - hdg + 540) % 360) - 180) < 1, 'felszállás közben egyenesen');
    }
    const along = Math.hypot(d.x - far[0], d.y - far[1]);
    assert.ok(along > 0.6, 'a kifutó vége után fordul');
    run(sim, 900);
    assert.strictEqual(sim.stats.departed, 1, JSON.stringify(sim.incidentLog));
});

test('konfliktusjelzés: párhuzamosan vagy távolodva nem sípol, egymás felé vagy keresztező úttal igen', () => {
    const setup = (ra, rb, pa, pb) => {
        const sim = makeSim('LOWW');
        sim.aircraft = [];
        const a = sim._spawnTransit();
        const b = sim._spawnTransit();
        Object.assign(a, pa, { route: ra, spd: 220 });
        Object.assign(b, pb, { route: rb, spd: 220 });
        sim._checkSeparation();
        return a.conflict;
    };
    // párhuzamosan, 2 nm-re egymás mellett, ugyanarra
    assert.strictEqual(setup([[0, 10]], [[2, 10]], { x: 0, y: 0, hdg: 0 }, { x: 2, y: 0, hdg: 0 }), false, 'párhuzamos');
    // 2,5 nm-re, egymástól el
    assert.strictEqual(setup([[-10, 0]], [[10, 0]], { x: -1.2, y: 0, hdg: 270 }, { x: 1.2, y: 0, hdg: 90 }), false, 'távolodnak');
    // egymás felé
    assert.strictEqual(setup([[10, 0]], [[-10, 0]], { x: -1.2, y: 0, hdg: 90 }, { x: 1.2, y: 0, hdg: 270 }), true, 'egymás felé');
    // most távolodnak, de az útjuk keresztezi egymást
    assert.strictEqual(setup([[-3, 0], [3, 5]], [[3, 0], [-3, 5]], { x: -1.2, y: 0, hdg: 270 }, { x: 1.2, y: 0, hdg: 90 }), true, 'keresztező út');
    // nagyon közel: mindig jelez
    assert.strictEqual(setup([[0, 10]], [[1, 10]], { x: 0, y: 0, hdg: 0 }, { x: 1, y: 0, hdg: 0 }), true, 'nagyon közel');
});

test('leszállási sáv: párhuzamos végső megközelítésen nincs sípolás és incidens', () => {
    const sim = makeSim('LHBP');
    sim.aircraft = [];
    const a = sim._spawnArrival();
    const b = sim._spawnArrival() || sim._spawnArrival();
    // a két párhuzamos kifutóra, egyszerre végső megközelítésen
    const [r0, r1] = sim.runways;
    for (const [ac, rw] of [[a, r0], [b, r1]]) {
        const thr = sim.threshold(rw);
        const back = (sim.landingHeading(rw) + 180) % 360;
        const p = [thr[0] + Math.sin(back * Math.PI / 180) * 5, thr[1] + Math.cos(back * Math.PI / 180) * 5];
        Object.assign(ac, { x: p[0], y: p[1], hdg: sim.landingHeading(rw), alt: 1500, state: 'final', runway: rw.index, route: [] });
    }
    let warned = false;
    for (let i = 0; i < 400 && sim.aircraft.length; i++) {
        sim.step(0.1);
        if (a.conflict || b.conflict) warned = true;
    }
    assert.ok(!warned, 'nem sípol');
    assert.strictEqual(sim.stats.incidents, 0, JSON.stringify(sim.incidentLog));
});

test('két leszálló gép között nincs jelzés és incidens, csak ütközés számít', () => {
    const sim = makeSim('KORD');
    sim.aircraft = [];
    const a = sim._spawnArrival();
    const b = sim._spawnArrival() || sim._spawnArrival();
    Object.assign(a, { x: 5, y: 1, hdg: 270, runway: 0, state: 'airborne', route: [] });
    Object.assign(b, { x: 5, y: -0.2, hdg: 270, runway: 1, state: 'airborne', route: [[-10, 3]] });
    sim._checkSeparation();
    assert.ok(!a.conflict && !b.conflict);
    assert.strictEqual(sim.stats.incidents, 0);
    // egy indulóval szemben viszont jelez
    const d = sim._spawnTransit();
    Object.assign(d, { x: 3, y: 1, hdg: 90, kind: 'dep', route: [[10, 1]] });
    sim._checkSeparation();
    assert.ok(a.conflict && d.conflict);
});

test('megközelítés: a gép a kifutó tengelyén marad (Chicago és Budapest, minden kapuból, minden kifutóra)', () => {
    for (const icao of ['KORD', 'LHBP']) {
        const base = makeSim(icao);
        for (const rw0 of base.runways) {
            for (let g = 0; g < 6; g++) {
                const sim = makeSim(icao);
                sim.aircraft = [];
                const gates = sim.gates;
                sim.gates = [gates[g]];
                const a = sim._spawnArrival();
                sim.gates = gates;
                sim.command({ type: 'runway', id: a.id, runway: rw0.index });
                const rw = sim.runways[rw0.index];
                let maxCross = 0;
                for (let i = 0; i < 9000 && sim.aircraft.length; i++) {
                    sim.step(0.1);
                    if (a.state === 'final') {
                        const { along, cross } = sim._alongAndCross(a, rw);
                        if (along < 4) maxCross = Math.max(maxCross, Math.abs(cross));
                    }
                }
                assert.strictEqual(sim.stats.landed, 1, `${icao} ${sim.runwayName(rw)} kapu ${gates[g].letter}`);
                assert.ok(maxCross < 0.3, `${icao} ${sim.runwayName(rw)} kapu ${gates[g].letter}: ${maxCross.toFixed(2)} nm eltérés`);
            }
        }
    }
});
