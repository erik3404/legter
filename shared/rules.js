// Légtér – multiplayer jogosultsági szabályok és a műszak-beállítások leírása. Szerveren és böngészőben is fut.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.LegterRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // A multi menü sorrendje: a két fő mód elöl.
    const MODES = {
        airports: {
            label: 'Saját reptér (2–3 fő)', maxPlayers: 3,
            desc: 'Ahányan vagytok, annyi reptér él a pályán (a fő reptér és a közeli társrepterei), és mindenki csak a saját repterének gépeit irányítja.'
        },
        positions: {
            label: 'Bevezető – Torony – Kivezető (2–3 fő)', maxPlayers: 3, roles: 'positions',
            desc: 'Mint a valódi légiirányításban: a bevezető hozza be az érkezőket, a torony kezeli a reptér körüli zónát (felszállás, végső megközelítés, leszállás), a kivezető viszi ki az indulókat és az átrepülőket. A gép magától kerül át a következő irányítóhoz.'
        },
        roles: {
            label: 'Érkező – Induló – Ügyeletes (2–3 fő)', maxPlayers: 3, roles: 'roles',
            desc: 'Egy reptér: az érkező a leszállókat, az induló a felszállókat irányítja. A harmadik, az ügyeletes viszi az átrepülőket és a különleges eseteket (vészhelyzet, kényszerleszállás, VIP gép).'
        },
        free: { label: 'Szabad (közös irányítás)', maxPlayers: 6, desc: 'Mindenki minden gépet irányíthat, közös pontszám.' },
        sector: { label: 'Szektoros', maxPlayers: 6, desc: 'A légteret szeletekre osztjuk, mindenki a saját szeletét kezeli. A reptér körüli torony-zóna közös.' }
    };

    // posztok módonként: a lobbiban mindenki választ egyet
    const ROLES = {
        arr: 'Érkező (leszállók)',
        dep: 'Induló (felszállók)',
        duty: 'Ügyeletes (átrepülők, különleges esetek)',
        all: 'Mindent visz'
    };
    const POSITIONS = {
        app: 'Bevezető (érkezők a zónáig)',
        twr: 'Torony (reptér körüli zóna)',
        dep: 'Kivezető (indulók, átrepülők)',
        apptwr: 'Bevezető + Torony'
    };
    const ROLE_SETS = { roles: ROLES, positions: POSITIONS };
    // alapértelmezett posztkiosztás a csatlakozás sorrendjében (2 és 3 főre)
    const DEFAULT_ROLES = {
        roles: { 1: ['all'], 2: ['arr', 'dep'], 3: ['arr', 'dep', 'duty'] },
        positions: { 1: ['apptwr'], 2: ['apptwr', 'dep'], 3: ['app', 'twr', 'dep'] }
    };

    const TOWER_RADIUS = 4;
    const TWR_ZONE_NM = 5;   // a torony zónája a reptér körül

    // ---------- fejlesztések (perkek) ----------
    const PERKS = {
        agile: { label: 'Fürge szárnyak', desc: 'A gépek 25%-kal gyorsabban fordulnak, a várakozó körben is.' },
        earlyRadar: { label: 'Korai radar', desc: 'A kialakuló konfliktust 5 másodperccel korábban, sárgán jelzi.' },
        spacing: { label: 'Érkezési távköz', desc: 'Két érkező között 3 másodperccel több idő telik el, zsúfolt légtérben pedig még több.' },
        rapidExit: { label: 'Gyors kigurulás', desc: 'A leszálló gépek egyhatodával hamarabb hagyják el a kifutót.' },
        earlyHandoff: { label: 'Korábbi átvétel', desc: 'A belépő gépeket 6 másodperccel korábban látod a kapunál, és ez nem fogy az üzemanyagukból.' },
        exactSpeed: { label: 'Pontos sebesség', desc: 'Pontos sebességet adhatsz meg az utazósebesség ±20%-án belül.' },
        takeoffQueue: { label: 'Felszállási sor', desc: 'Foglalt kifutónál az induló beállhat a sorba (kifutónként egy), és magától felszáll, amint szabad.' },
        sequencing: { label: 'Sorrendjelzés', desc: 'Látszik a várható földet érés, a leszállási sorszám és a távolság az előző géptől.' },
        flexExit: { label: 'Rugalmas kijárat', desc: 'Kétpercenként egy levegőben lévő induló vagy átrepülő kilépési kapuja megváltoztatható.' }
    };
    const REVIEW_EVERY_MOVES = 30;
    const REVIEW_EVERY_SECONDS = 480;

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
            key: 'security', group: 'events', label: 'Eltérítés és VIP gép',
            desc: 'Ritkán egy gépet eltérítenek: indíts vadászgépeket (F), hogy elfogják, mielőtt egy reptérhez ér. Néha államfői VIP gép érkezik: a repterén minden kifutót tisztán kell tartani, és Gripen-kíséretet kell küldeni elé.',
            off: 0.95, on: 1
        },
        {
            key: 'showAllRoutes', group: 'help', label: 'Minden útvonal látszik',
            desc: 'Az összes gép tervezett útvonala halványan kirajzolódik, nem csak a kijelölté.',
            off: 1, on: 0.6
        },
        {
            key: 'noPerks', group: 'help', label: 'Fejlesztések nélkül',
            desc: `Nincs értékelés, így fejlesztést sem kapsz. Értékelés egyébként ${REVIEW_EVERY_MOVES} lekezelt gépenként vagy ${REVIEW_EVERY_SECONDS / 60} percenként jön: 3 fejlesztésből választhatsz egyet.`,
            off: 1, on: 1.1
        }
    ];

    const PRESETS = {
        classic: {
            label: 'Klasszikus',
            rules: { altitude: false, manualRouting: false, pauseQueue: false, randomGates: false, constraints: true, emergencies: true, storms: true, fog: true, security: true, showAllRoutes: false, noPerks: false }
        },
        hard: {
            label: 'Nehéz',
            rules: { altitude: true, manualRouting: true, pauseQueue: true, randomGates: true, constraints: true, emergencies: true, storms: true, fog: true, security: true, showAllRoutes: false, noPerks: false }
        }
    };

    const TRAFFIC_LEVELS = { 25: 0.3, 50: 0.5, 75: 0.75, 100: 1, 125: 1.25, 150: 1.5 };

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

    // Melyik poszt felel a gépért? (roles és positions módban)
    function neededRole(ac, mode) {
        if (mode === 'positions') {
            if (ac.tz) return 'twr';
            return ac.k === 'arr' ? 'app' : 'dep';
        }
        const special = ac.em != null || ac.pr || ac.vp;
        if (special || ac.k === 'transit') return 'duty';
        return ac.k;
    }

    // a játékos posztja lefedi-e a szükséges posztot
    function roleCovers(role, needed) {
        if (role === 'all' || role === needed) return true;
        if (role === 'apptwr') return needed === 'app' || needed === 'twr';
        return false;
    }

    // ac: kompakt pillanatkép-objektum (k, st, x, y, ap, tz, em, pr, vp, ow), player: {id, role, sector, airport}
    function canControl(ac, player, settings, players) {
        if (ac.k === 'mil') return false;           // a vadászgépek önállóan repülnek
        const mode = settings.mode || 'free';
        if (mode === 'free' || !player || players.length < 2) return true;
        // átadással kapott gép: csak az új gazdája irányítja
        if (ac.ow != null && players.some((p) => p.id === ac.ow)) return player.id === ac.ow;
        if (mode === 'airports') {
            // gazdátlan reptér gépeit bárki irányíthatja
            if (!players.some((p) => (p.airport || 0) === (ac.ap || 0))) return true;
            return (ac.ap || 0) === (player.airport || 0);
        }
        if (mode === 'roles' || mode === 'positions') {
            let needed = neededRole(ac, mode);
            // ha senkinél nincs ügyeletes poszt, a különleges gép a típusa szerinti irányítóé
            if (mode === 'roles' && needed === 'duty' && !players.some((p) => roleCovers(p.role, 'duty'))) {
                needed = ac.k === 'transit' ? null : ac.k;
            }
            if (needed == null) return true;
            // ha a szükséges posztot senki nem vállalta, bárki irányíthatja
            if (!players.some((p) => roleCovers(p.role, needed))) return true;
            return roleCovers(player.role || 'all', needed);
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

    // lobbi-ellenőrzés: minden poszt foglalt-e, és nincs-e ütközés
    function roleProblems(mode, players) {
        const set = ROLE_SETS[(MODES[mode] || {}).roles];
        if (!set || players.length < 2) return null;
        const needed = mode === 'positions' ? ['app', 'twr', 'dep'] : ['arr', 'dep'];
        const missing = needed.filter((n) => !players.some((p) => roleCovers(p.role, n)));
        const counts = {};
        for (const p of players) counts[p.role] = (counts[p.role] || 0) + 1;
        const dup = Object.keys(counts).filter((r) => counts[r] > 1 && r !== 'all');
        if (missing.length) return `Senki nem vállalta: ${missing.map((m) => set[m]).join(', ')}.`;
        if (dup.length) return `Ketten választották: ${dup.map((m) => set[m]).join(', ')}.`;
        return null;
    }

    return {
        MODES, ROLES, POSITIONS, ROLE_SETS, DEFAULT_ROLES, TOWER_RADIUS, TWR_ZONE_NM,
        PERKS, REVIEW_EVERY_MOVES, REVIEW_EVERY_SECONDS,
        RULE_GROUPS, RULE_DEFS, PRESETS, TRAFFIC_LEVELS, PRACTICE, OPENINGS,
        defaultShift, normalizeShift, presetOf, scoreMultiplier,
        sectorCount, sectorOf, inTowerZone, canControl, ownersOf, neededRole, roleCovers, roleProblems
    };
}));
