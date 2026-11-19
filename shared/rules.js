// Légtér – multiplayer jogosultsági szabályok és a műszak-beállítások leírása. Szerveren és böngészőben is fut.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.LegterRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // A multi menü sorrendje: a két fő mód elöl.
    const MODES = {
        airports: {
            label: 'Saját reptér (2–3 fő)', maxPlayers: 3, needsCluster: true,
            desc: 'Egy pálya több repülőtérrel: ahányan vagytok (legfeljebb 3), annyi reptér él, és mindenki csak a saját repterének gépeit irányítja.'
        },
        roles: {
            label: 'Leszállás + felszállás (2 fő)', maxPlayers: 2,
            desc: 'Egy reptér, két irányító: az egyik a leszálló, a másik a felszálló gépekért felel. Az átrepülőket mindketten irányíthatják.'
        },
        free: { label: 'Szabad (közös irányítás)', maxPlayers: 6, desc: 'Mindenki minden gépet irányíthat, közös pontszám.' },
        sector: { label: 'Szektoros', maxPlayers: 6, desc: 'A légteret szeletekre osztjuk, mindenki a saját szeletét kezeli. A reptér körüli torony-zóna közös.' }
    };

    const ROLES = {
        arr: 'Leszállók (érkezők)',
        dep: 'Felszállók (indulók)',
        all: 'Mindkettő'
    };

    const TOWER_RADIUS = 4;

    // ---------- műszak-szabályok ----------
    const RULE_GROUPS = [
        { key: 'workload', label: 'Munkaterhelés' },
        { key: 'events', label: 'Események' },
        { key: 'help', label: 'Segítség' }
    ];

    const RULE_DEFS = [
        {
            key: 'altitude', group: 'workload', label: 'Magasság',
            desc: 'A magasság is számít: az érkezőket süllyesztened, az indulókat és átrepülőket emelned kell. 1000 láb különbség is elég az elkülönítéshez.',
            off: 1, on: 1.2
        },
        {
            key: 'manualRouting', group: 'workload', label: 'Indulók és átrepülők útvonala kézzel',
            desc: 'Felszállás és belépés után egyenesen repülnek, amíg útpontot nem adsz nekik a kapujuk felé.',
            off: 1, on: 1.2
        },
        {
            key: 'pauseQueue', group: 'workload', label: 'Szünetben a parancsok várnak',
            desc: 'Szünet közben is tervezhetsz, de a parancsok csak a folytatáskor lépnek életbe.',
            off: 1, on: 1.05
        },
        {
            key: 'randomGates', group: 'workload', label: 'Véletlen kapuk',
            desc: 'Minden műszakban 4–6 kapu, új helyen, valódi fixpontokról elnevezve.',
            off: 1, on: 1.1
        },
        {
            key: 'constraints', group: 'events', label: 'Kifutó-ellenőrzések',
            desc: 'Időnként egy kifutót egy perc figyelmeztetés után néhány percre lezárnak.',
            off: 0.9, on: 1
        },
        {
            key: 'emergencies', group: 'events', label: 'Vészhelyzetek és kényszerleszállás',
            desc: 'Egy érkező vészhelyzetet jelenthet: lassabb, és 6 percen belül le kell szállnia. Kényszerleszállásnál amíg le nem száll, a repterén senki más nem szállhat le.',
            off: 0.95, on: 1
        },
        {
            key: 'storms', group: 'events', label: 'Zivatarok és hurrikán',
            desc: 'Ritkán egy kis zivatar sodródik lassan a légtérben. A zöld és sárga rész átrepülhető, de ha egy gép a piros magba repül, vége a műszaknak. 1% eséllyel hurrikán lesz belőle: sokkal nagyobb és gyorsabb.',
            off: 0.9, on: 1
        },
        {
            key: 'fog', group: 'events', label: 'Köd',
            desc: 'Ritkán egy kis ködfolt sodródik a légtérben. A benne repülő gép nem tudja, hol jár: egyenesen repül tovább, és amíg ki nem ér, nem irányítható.',
            off: 0.95, on: 1
        },
        {
            key: 'security', group: 'events', label: 'Eltérítések',
            desc: 'Ritkán egy gépet eltérítenek: nem válaszol, és egy reptér felé fordul. Indíts vadászgépeket (F), hogy elfogják és leszállásra kísérjék, mielőtt odaér.',
            off: 0.95, on: 1
        },
        {
            key: 'showAllRoutes', group: 'help', label: 'Minden útvonal látszik',
            desc: 'Az összes gép tervezett útvonala halványan kirajzolódik, nem csak a kijelölté.',
            off: 1, on: 0.6
        }
    ];

    const PRESETS = {
        classic: {
            label: 'Klasszikus',
            rules: { altitude: false, manualRouting: false, pauseQueue: false, randomGates: false, constraints: true, emergencies: true, storms: true, fog: true, security: true, showAllRoutes: false }
        },
        hard: {
            label: 'Nehéz',
            rules: { altitude: true, manualRouting: true, pauseQueue: true, randomGates: true, constraints: true, emergencies: true, storms: true, fog: true, security: true, showAllRoutes: false }
        }
    };

    const TRAFFIC_LEVELS = { 50: 0.5, 75: 0.75, 100: 1, 125: 1.25, 150: 1.5 };

    const PRACTICE = {
        all: 'Teljes forgalom',
        arr: 'Csak érkezők',
        dep: 'Csak indulók',
        transit: 'Csak átrepülők'
    };

    const OPENINGS = {
        busy: { label: 'Gyors kezdés', desc: 'Három induló vár, és az első percben sorban jönnek az érkezők.' },
        gentle: { label: 'Lassú kezdés', desc: 'Egy induló, a forgalom fokozatosan erősödik.' }
    };

    function defaultShift() {
        return {
            rules: Object.assign({}, PRESETS.classic.rules),
            traffic: 100,
            practice: 'all',
            opening: 'busy'
        };
    }

    // a klienstől jövő beállítások ellenőrzése
    function normalizeShift(input) {
        const out = defaultShift();
        if (!input || typeof input !== 'object') return out;
        if (input.rules && typeof input.rules === 'object') {
            for (const def of RULE_DEFS) {
                if (typeof input.rules[def.key] === 'boolean') out.rules[def.key] = input.rules[def.key];
            }
        }
        if (TRAFFIC_LEVELS[input.traffic]) out.traffic = Number(input.traffic);
        if (PRACTICE[input.practice]) out.practice = input.practice;
        if (OPENINGS[input.opening]) out.opening = input.opening;
        return out;
    }

    function presetOf(rules) {
        for (const [key, p] of Object.entries(PRESETS)) {
            if (RULE_DEFS.every((d) => !!rules[d.key] === !!p.rules[d.key])) return key;
        }
        return 'custom';
    }

    function scoreMultiplier(shift) {
        let m = TRAFFIC_LEVELS[shift.traffic] || 1;
        for (const def of RULE_DEFS) m *= shift.rules[def.key] ? def.on : def.off;
        return Math.round(m * 100) / 100;
    }

    // ---------- jogosultságok ----------
    function sectorCount(players) {
        let max = 1;
        for (const p of players) max = Math.max(max, (p.sector || 0) + 1);
        return Math.max(2, Math.min(6, Math.max(max, players.length)));
    }

    // 0 = észak, óramutató szerint. A szektorok határa: offset + i * (360 / n)
    function sectorOf(x, y, count, offset) {
        const brg = ((Math.atan2(x, y) * 180 / Math.PI) - (offset || 0) + 720) % 360;
        return Math.floor(brg / (360 / count));
    }

    function inTowerZone(ac) {
        return ac.st === 'ground' || ac.st === 'takeoff' || ac.st === 'rollout' || Math.hypot(ac.x, ac.y) < TOWER_RADIUS;
    }

    // ac: kompakt pillanatkép-objektum (k, st, x, y), player: {role, sector}
    function canControl(ac, player, settings, players) {
        if (ac.k === 'mil') return false;           // a vadászgépek önállóan repülnek
        const mode = settings.mode || 'free';
        if (mode === 'free' || !player || players.length < 2) return true;
        if (mode === 'airports') return (ac.ap || 0) === (player.airport || 0);
        if (mode === 'roles') {
            const role = player.role || 'all';
            if (role === 'all' || ac.k === 'transit') return true;
            return role === ac.k;
        }
        if (mode === 'sector') {
            if (inTowerZone(ac)) return true;
            const n = sectorCount(players);
            return sectorOf(ac.x, ac.y, n, settings.sectorOffset || 0) === (player.sector || 0);
        }
        return true;
    }

    // ki irányítja most a gépet (megjelenítéshez)
    function ownersOf(ac, settings, players) {
        return players.filter((p) => canControl(ac, p, settings, players));
    }

    return {
        MODES, ROLES, TOWER_RADIUS,
        RULE_GROUPS, RULE_DEFS, PRESETS, TRAFFIC_LEVELS, PRACTICE, OPENINGS,
        defaultShift, normalizeShift, presetOf, scoreMultiplier,
        sectorCount, sectorOf, inTowerZone, canControl, ownersOf
    };
}));
