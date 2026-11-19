// Légtér – multiplayer jogosultsági szabályok. Szerveren és böngészőben is fut.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.LegterRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MODES = {
        free: { label: 'Szabad', desc: 'Mindenki minden gépet irányíthat, közös pontszám.' },
        sector: { label: 'Szektoros', desc: 'A légteret szeletekre osztjuk, mindenki a saját szeletét kezeli. A reptér körüli torony-zóna közös.' },
        roles: { label: 'Repteres (Fel/Le)', desc: 'Szerepek: az induló a felszállókat, az érkező a leszállókat irányítja. Az átrepülőket mindenki.' }
    };

    const ROLES = {
        all: 'Mindkettő',
        dep: 'Induló (felszállók)',
        arr: 'Érkező (leszállók)'
    };

    const TOWER_RADIUS = 4;

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
        const mode = settings.mode || 'free';
        if (mode === 'free' || !player) return true;
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

    return { MODES, ROLES, TOWER_RADIUS, sectorCount, sectorOf, inTowerZone, canControl, ownersOf };
}));
