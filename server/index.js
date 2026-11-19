'use strict';
// Légtér – HTTP + WebSocket szerver. A szimuláció itt fut, a böngészők csak megjelenítenek és parancsot küldenek.
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { WebSocketServer } = require('ws');
const { Sim, AIRPORTS } = require('../shared/sim');
const Rules = require('../shared/rules');

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 100;
const BROADCAST_EVERY = 2; // tick-enként -> 5 Hz
const PLAYER_COLORS = ['#4fd1c5', '#f6ad55', '#b794f4', '#68d391', '#f687b3', '#63b3ed'];
const SPEEDS = [0.5, 1, 1.5, 2, 4];
const RECONNECT_GRACE_MS = 90 * 1000;   // ennyi ideig várjuk vissza a kiesett játékost
// gyorsüzenetek (a kliens a sorszámot küldi)
const QUICK_MESSAGES = ['Vedd át!', 'Tartsd vissza az indulókat!', 'Segítség kell!', 'Figyelj, időjárás jön!', 'Rendben!', 'Köszi!'];
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200;
const MAX_MESSAGES_PER_SECOND = 40;

const app = express();
app.disable('x-powered-by');
app.use(compression());
const staticOptions = { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0, index: false };

// Verzióazonosító: minden telepítésnél más, így a böngésző nem keveri a régi és az új fájlokat.
const fs = require('fs');
const BUILD_ID = (process.env.RENDER_GIT_COMMIT || String(Date.now())).slice(0, 12);
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')
    .replace(/(src|href)="(\/?(?:shared\/)?[\w-]+\.(?:js|css))"/g, `$1="$2?v=${BUILD_ID}"`);
app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(INDEX_HTML);
});
app.use(express.static(path.join(__dirname, '..', 'public'), staticOptions));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared'), staticOptions));
app.get('/api/airports', (req, res) => {
    res.json(Object.values(AIRPORTS).map((a) => ({
        icao: a.icao, name: a.name, runways: a.runways.filter((r) => !r.airport).length,
        airports: (a.airports || []).map((x) => ({ icao: x.icao, name: x.name }))
    })));
});
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

const rooms = new Map();
let nextPlayerId = 1;

function makeCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code;
    do {
        code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
    const data = JSON.stringify(msg);
    for (const p of room.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(data);
}

function publicPlayers(room) {
    return [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, role: p.role, sector: p.sector, airport: p.airport, selected: p.selected,
        online: !!p.ws
    }));
}

function roomInfo(room) {
    return {
        code: room.code,
        hostId: room.hostId,
        settings: room.settings,
        started: !!room.sim,
        paused: room.paused,
        speed: room.speed,
        players: publicPlayers(room)
    };
}

function sendRoom(room) {
    broadcast(room, { t: 'room', room: roomInfo(room) });
}

function freeColor(room) {
    const used = new Set([...room.players.values()].map((p) => p.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
}

// posztok újraosztása módváltáskor vagy létszámváltozáskor
function reassignRoles(room) {
    const set = Rules.MODES[room.settings.mode].roles;
    if (!set) return;
    const players = [...room.players.values()];
    const defaults = Rules.DEFAULT_ROLES[set][Math.min(3, Math.max(1, players.length))] || [];
    players.forEach((p, i) => { p.role = defaults[i] || 'all'; });
}

function assignDefaultRole(room, player) {
    const set = Rules.MODES[room.settings.mode].roles;
    if (!set) {
        player.role = 'all';
        return;
    }
    const others = [...room.players.values()].filter((p) => p !== player);
    const defaults = Rules.DEFAULT_ROLES[set][Math.min(3, others.length + 1)] || [];
    // két főnél az első játékos az összevont posztra vált, hogy minden poszt foglalt legyen
    if (others.length === 1 && Rules.DEFAULT_ROLES[set][2]) others[0].role = Rules.DEFAULT_ROLES[set][2][0];
    if (others.length === 2 && Rules.DEFAULT_ROLES[set][3]) others.forEach((p, i) => { p.role = Rules.DEFAULT_ROLES[set][3][i]; });
    player.role = defaults.find((r) => !others.some((p) => p.role === r)) || defaults[defaults.length - 1] || 'all';
}

function freeAirport(room) {
    const used = new Set([...room.players.values()].map((p) => p.airport));
    for (let i = 0; i < 3; i++) if (!used.has(i)) return i;
    return 0;
}

function freeSector(room) {
    const used = new Set([...room.players.values()].map((p) => p.sector));
    for (let i = 0; i < 6; i++) if (!used.has(i)) return i;
    return 0;
}

function cleanName(name) {
    return String(name || '').replace(/[<>]/g, '').trim().slice(0, 16) || 'Irányító';
}

function addPlayer(room, ws, name) {
    const player = {
        id: nextPlayerId++,
        token: crypto.randomBytes(16).toString('hex'),   // ezzel lehet visszacsatlakozni
        ws,
        name: cleanName(name),
        color: freeColor(room),
        role: 'all',
        sector: freeSector(room),
        airport: freeAirport(room),
        selected: null
    };
    // szerepalapú módban az új játékos a következő szabad posztot kapja
    assignDefaultRole(room, player);
    room.players.set(player.id, player);
    if (!room.hostId) room.hostId = player.id;
    ws.roomCode = room.code;
    ws.playerId = player.id;
    send(ws, { t: 'joined', you: player.id, token: player.token, room: roomInfo(room) });
    if (room.sim) send(ws, { t: 'static', info: room.sim.staticInfo() });
    sendRoom(room);
    if (room.players.size > 1) broadcast(room, { t: 'log', kind: 'info', text: `${player.name} csatlakozott.` });
    return player;
}

// végleges kilépés (gomb, új szoba, vagy a visszacsatlakozási idő lejárt)
function removePlayerById(room, playerId) {
    const player = room.players.get(playerId);
    if (!player) return;
    clearTimeout(player.dropTimer);
    room.players.delete(playerId);
    if (player.ws) {
        player.ws.roomCode = null;
        player.ws.playerId = null;
    }
    if (room.players.size === 0) {
        clearInterval(room.interval);
        rooms.delete(room.code);
        return;
    }
    if (room.hostId === playerId) {
        // a gazda szerepét lehetőleg egy éppen kapcsolódó játékos veszi át
        const next = [...room.players.values()].find((p) => p.ws) || room.players.values().next().value;
        room.hostId = next.id;
    }
    if (!room.sim) reassignRoles(room);
    broadcast(room, { t: 'log', kind: 'info', text: `${player.name} kilépett.` });
    sendRoom(room);
}

function removePlayer(ws) {
    const room = rooms.get(ws.roomCode);
    if (room) removePlayerById(room, ws.playerId);
}

// megszakadt kapcsolat: a játékos helye 90 mp-ig megmarad, addig visszacsatlakozhat
function onDisconnect(ws) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.get(ws.playerId);
    if (!player || player.ws !== ws) return;     // már új kapcsolattal visszajött
    player.ws = null;
    player.dropTimer = setTimeout(() => removePlayerById(room, player.id), RECONNECT_GRACE_MS);
    broadcast(room, { t: 'log', kind: 'warn', text: `${player.name} kapcsolata megszakadt – várjuk vissza…` });
    sendRoom(room);
}

function resumePlayer(ws, code, token) {
    const room = rooms.get(String(code || '').toUpperCase());
    const player = room && [...room.players.values()].find((p) => p.token === token);
    if (!player) return send(ws, { t: 'resumeFailed', text: 'A korábbi szoba már nem létezik (például mert a szerver újraindult).' });
    clearTimeout(player.dropTimer);
    if (player.ws && player.ws !== ws) {
        // ugyanaz a játékos új lapon/kapcsolattal: a régit lezárjuk
        const old = player.ws;
        old.roomCode = null;
        old.playerId = null;
        old.close();
    }
    if (ws.roomCode && (ws.roomCode !== room.code || ws.playerId !== player.id)) removePlayer(ws);
    player.ws = ws;
    ws.roomCode = room.code;
    ws.playerId = player.id;
    send(ws, { t: 'joined', you: player.id, token: player.token, room: roomInfo(room), resumed: true });
    if (room.sim) send(ws, { t: 'static', info: room.sim.staticInfo() });
    broadcast(room, { t: 'log', kind: 'good', text: `${player.name} visszacsatlakozott.` });
    sendRoom(room);
}

function createRoom(settings) {
    const room = {
        code: makeCode(),
        hostId: null,
        players: new Map(),
        settings: {
            airport: AIRPORTS[settings.airport] ? settings.airport : 'LHBP',
            // létszám: ennyien játszhatnak, és ennyi reptér él (legfeljebb 3)
            size: settings.solo ? 1 : Math.max(1, Math.min(6, Math.round(Number(settings.size) || 2))),
            solo: !!settings.solo,
            mode: Rules.MODES[settings.mode] ? settings.mode : 'free',
            sectorOffset: 0,
            shift: Rules.normalizeShift(settings.shift)
        },
        sim: null,
        paused: false,
        speed: 1,
        tick: 0
    };
    room.interval = setInterval(() => tickRoom(room), TICK_MS);
    rooms.set(room.code, room);
    return room;
}

// indítás előtti ellenőrzés; hibaüzenetet ad vissza, ha valami nem stimmel
function checkStart(room) {
    const mode = Rules.MODES[room.settings.mode];
    const n = room.players.size;
    if (n > mode.maxPlayers) return `A(z) „${mode.label}” módban legfeljebb ${mode.maxPlayers} fő játszhat.`;
    if (n > room.settings.size) return `Többen vagytok (${n}), mint a beállított létszám (${room.settings.size}).`;
    const roleIssue = Rules.roleProblems(room.settings.mode, publicPlayers(room));
    if (roleIssue) return `Posztok: ${roleIssue}`;
    return null;
}

function startGame(room) {
    // ahány fő a létszám, annyi reptér él (legfeljebb 3, és amennyi a pályán van)
    const count = Math.min(room.settings.size, 3, AIRPORTS[room.settings.airport].airports.length);
    const opts = { aspect: room.aspect, players: room.players.size, airportCount: count };
    if (room.settings.mode === 'airports') {
        // mindenki más repteret kapjon: ütközés vagy túl nagy szám esetén sorban újraosztjuk
        const players = [...room.players.values()];
        const seen = new Set();
        const valid = players.every((p) => p.airport < count && !seen.has(p.airport) && seen.add(p.airport));
        if (!valid) players.forEach((p, i) => { p.airport = i % count; });
    }
    room.sim = new Sim(room.settings.airport, room.settings.shift, opts);
    room.paused = false;
    room.queued = [];
    // csak automatikus teszthez: LEGTER_TEST_WEATHER=1 azonnal zivatart és ködöt hoz
    if (process.env.LEGTER_TEST_WEATHER) {
        room.sim.timers.storm = 2;
        room.sim.timers.fog = 1;
        if (process.env.LEGTER_TEST_WEATHER === 'events') {
            room.sim.forceHurricane = true;
            room.sim.forceForcedLanding = true;
            room.sim.timers.hijack = 6;
            room.sim.timers.emergency = 9;
        }
        if (process.env.LEGTER_TEST_WEATHER === 'vip') {
            room.sim.timers.vip = 4;
            room.sim.timers.hijack = 1e9;
            room.sim.nextReviewTime = 8;
        }
        if (process.env.LEGTER_TEST_WEATHER === 'gameover') {
            const sim = room.sim;
            setTimeout(() => { if (room.sim === sim) sim.gameOver = { reason: 'TESZT123 berepült a zivatar piros magjába.' }; }, 3000);
        }
    }
    broadcast(room, { t: 'static', info: room.sim.staticInfo() });
    broadcast(room, { t: 'log', kind: 'info', text: `Műszak indul: ${room.sim.airport.name}. Az első induló gépek már várnak.` });
    sendRoom(room);
}

function endGame(room, gameOver) {
    broadcast(room, { t: 'state', s: room.sim.snapshot(), ev: room.sim.drainEvents() });
    broadcast(room, {
        t: 'ended',
        stats: room.sim.stats,
        incidents: room.sim.incidentLog,
        time: room.sim.time,
        multiplier: room.sim.multiplier,
        gameOver: gameOver || null
    });
    room.sim = null;
    room.queued = [];
    sendRoom(room);
}

function tickRoom(room) {
    if (!room.sim) return;
    if (!room.paused) room.sim.step((TICK_MS / 1000) * room.speed);
    if (room.sim.gameOver) {
        endGame(room, room.sim.gameOver);
        return;
    }
    room.tick += 1;
    if (room.tick % BROADCAST_EVERY === 0) {
        broadcast(room, { t: 'state', s: room.sim.snapshot(), ev: room.sim.drainEvents() });
    }
}

function runCommand(room, player, cmd, reply) {
    const [ok, text] = room.sim.command(cmd);
    if (reply) send(player.ws, { t: 'cmdResult', ok, text: ok ? null : text });
    if (ok && text) broadcast(room, { t: 'log', kind: 'radio', text, by: player.name, color: player.color });
}

// a jogosultsághoz szükséges adatok ugyanúgy, ahogy a kliens a pillanatképből látja
function compactForRules(room, ac) {
    return room.sim.ruleView(ac);
}

function handle(ws, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'create') {
        if (rooms.size >= MAX_ROOMS) return send(ws, { t: 'error', text: 'A szerver most tele van, próbáld újra később.' });
        if (ws.roomCode) removePlayer(ws);
        const room = createRoom(msg.settings || {});
        addPlayer(room, ws, msg.name);
        return;
    }
    if (msg.t === 'resume') {
        resumePlayer(ws, msg.code, String(msg.token || ''));
        return;
    }
    if (msg.t === 'join') {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room) return send(ws, { t: 'error', text: 'Nincs ilyen szoba. Ellenőrizd a kódot.' });
        const max = Math.min(Rules.MODES[room.settings.mode].maxPlayers, room.settings.size);
        if (room.players.size >= max) return send(ws, { t: 'error', text: `A szoba megtelt (${max} fős).` });
        if (ws.roomCode) removePlayer(ws);
        addPlayer(room, ws, msg.name);
        return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.get(ws.playerId);
    if (!player) return;
    const isHost = room.hostId === player.id;

    switch (msg.t) {
        case 'leave':
            removePlayerById(room, player.id);
            break;
        // jelölés a térképen: felvillan a társaknál
        case 'ping': {
            const now = Date.now();
            if (now - (player.lastPing || 0) < 700) return;
            player.lastPing = now;
            const x = Number(msg.x);
            const y = Number(msg.y);
            if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100 || Math.abs(y) > 100) return;
            broadcast(room, { t: 'ping', x, y, by: player.name, color: player.color, pid: player.id });
            break;
        }
        // gyorsüzenet: előre megírt szövegek, opcionálisan egy géphez kötve
        case 'quick': {
            const now = Date.now();
            if (now - (player.lastQuick || 0) < 800) return;
            player.lastQuick = now;
            const text = QUICK_MESSAGES[msg.i];
            if (!text) return;
            const ac = room.sim && msg.id != null ? room.sim.find(msg.id) : null;
            broadcast(room, {
                t: 'chat', text: ac ? `${text} (${ac.callsign})` : text, by: player.name, color: player.color, pid: player.id, id: ac ? ac.id : null
            });
            break;
        }
        case 'settings': {
            if (!isHost) return;
            const s = msg.settings || {};
            if (!room.sim && AIRPORTS[s.airport]) room.settings.airport = s.airport;
            if (!room.sim && s.shift) room.settings.shift = Rules.normalizeShift(s.shift);
            if (Rules.MODES[s.mode]) {
                const changed = room.settings.mode !== s.mode;
                room.settings.mode = s.mode;
                if (changed) reassignRoles(room);
                // a létszám nem lehet több, mint amit a mód enged
                room.settings.size = Math.min(room.settings.size, Rules.MODES[s.mode].maxPlayers);
            }
            if (Number.isInteger(s.size) && !room.settings.solo && !room.sim) {
                room.settings.size = Math.max(Math.max(1, room.players.size), Math.min(Rules.MODES[room.settings.mode].maxPlayers, s.size));
            }
            if (typeof s.sectorOffset === 'number') room.settings.sectorOffset = ((Math.round(s.sectorOffset) % 360) + 360) % 360;
            sendRoom(room);
            break;
        }
        case 'player': {
            const target = msg.targetId && isHost ? room.players.get(msg.targetId) : player;
            if (!target) return;
            if (Rules.ROLES[msg.role] || Rules.POSITIONS[msg.role]) target.role = msg.role;
            if (Number.isInteger(msg.sector) && msg.sector >= 0 && msg.sector < 6) target.sector = msg.sector;
            if (Number.isInteger(msg.airport) && msg.airport >= 0 && msg.airport < 3) target.airport = msg.airport;
            if (msg.name && target === player) target.name = cleanName(msg.name);
            sendRoom(room);
            break;
        }
        case 'start': {
            if (!isHost || room.sim) break;
            const problem = checkStart(room);
            if (problem) return send(ws, { t: 'error', text: problem });
            // a szobagazda radarjának méretaránya: ehhez igazodik a légtér alakja
            if (Number.isFinite(msg.aspect)) room.aspect = Math.max(0.5, Math.min(3, msg.aspect));
            startGame(room);
            break;
        }
        case 'end':
            if (isHost && room.sim) endGame(room, null);
            break;
        case 'pause':
            if (isHost) {
                room.paused = typeof msg.value === 'boolean' ? msg.value : !room.paused;
                // szünetben gyűjtött parancsok végrehajtása
                if (!room.paused && room.sim && room.queued.length) {
                    for (const q of room.queued) runCommand(room, q.player, q.cmd, false);
                    room.queued = [];
                    broadcast(room, { t: 'queued', count: 0 });
                }
                sendRoom(room);
            }
            break;
        case 'speed':
            if (isHost && SPEEDS.includes(msg.value)) {
                room.speed = msg.value;
                sendRoom(room);
            }
            break;
        case 'select':
            player.selected = Number.isInteger(msg.id) ? msg.id : null;
            sendRoom(room);
            break;
        // gépátadás: „Átadom neki” vagy „Átvétel kérése”; a címzett elfogadja vagy elutasítja
        case 'handoff': {
            if (!room.sim) return;
            const ac = room.sim.find(msg.id);
            if (!ac || ac.kind === 'mil') return;
            const players = publicPlayers(room);
            const view = compactForRules(room, ac);
            const mine = Rules.canControl(view, player, room.settings, players);
            // „Közösbe dobom”: mindenki más megkapja, aki elsőként elfogadja, azé lesz
            const pool = mine && msg.to === 'all';
            let targets;
            if (pool) targets = [...room.players.values()].filter((p) => p !== player);
            else if (mine) targets = [room.players.get(Number(msg.to))].filter(Boolean);
            else targets = [room.players.get(Rules.ownersOf(view, room.settings, players).map((p) => p.id)[0])].filter(Boolean);
            targets = targets.filter((p) => p !== player);
            if (!targets.length) return send(ws, { t: 'cmdResult', ok: false, text: 'Nincs kinek átadni.' });
            const reqId = room.nextReqId = (room.nextReqId || 0) + 1;
            room.requests = room.requests || new Map();
            room.requests.set(reqId, { id: ac.id, from: player.id, to: targets.map((p) => p.id), give: mine, pool, at: Date.now() });
            for (const to of targets) {
                send(to.ws, {
                    t: 'handoffReq', reqId, id: ac.id, cs: ac.callsign, from: player.name, color: player.color, give: mine, pool
                });
            }
            send(ws, {
                t: 'log',
                kind: 'info',
                text: pool ? `${ac.callsign}: bedobva a közösbe – aki elsőként elfogadja, átveszi.`
                    : mine ? `${ac.callsign}: átadási kérés elküldve ${targets[0].name} részére.` : `${ac.callsign}: átvételi kérés elküldve ${targets[0].name} részére.`
            });
            break;
        }
        case 'handoffReply': {
            const req = room.requests && room.requests.get(msg.reqId);
            if (!req || !req.to.includes(player.id) || !room.sim) return;
            const ac = room.sim.find(req.id);
            const from = room.players.get(req.from);
            const closeFor = (ids) => ids.forEach((pid) => { const p = room.players.get(pid); if (p) send(p.ws, { t: 'handoffClosed', reqId: msg.reqId }); });
            if (!ac) { room.requests.delete(msg.reqId); closeFor(req.to); return; }
            if (Date.now() - req.at > 30000) {
                room.requests.delete(msg.reqId);
                closeFor(req.to);
                return send(ws, { t: 'cmdResult', ok: false, text: 'A kérés lejárt.' });
            }
            if (msg.accept) {
                room.requests.delete(msg.reqId);
                closeFor(req.to.filter((pid) => pid !== player.id));
                ac.controller = req.give ? player.id : req.from;
                const owner = room.players.get(ac.controller);
                broadcast(room, { t: 'log', kind: 'info', text: `${ac.callsign} mostantól ${owner ? owner.name : '?'} irányítása alatt.` });
            } else {
                req.to = req.to.filter((pid) => pid !== player.id);
                if (!req.to.length) {
                    room.requests.delete(msg.reqId);
                    if (from) send(from.ws, { t: 'log', kind: 'warn', text: req.pool ? `${ac.callsign}: senki sem vette át.` : `${player.name} elutasította: ${ac.callsign}.` });
                }
            }
            break;
        }
        case 'cmd': {
            if (!room.sim) return;
            const cmd = msg.cmd || {};
            if (cmd.type === 'flipRunway' && !isHost && room.settings.mode !== 'free') {
                return send(ws, { t: 'cmdResult', ok: false, text: 'Az üzemi irányt csak a szobagazda fordíthatja.' });
            }
            // vadászgépet bárki indíthat, akármelyik gépet térítették el
            if (cmd.id != null && cmd.type !== 'scramble') {
                const ac = room.sim.find(cmd.id);
                if (!ac) return send(ws, { t: 'cmdResult', ok: false, text: 'Ez a gép már nincs a légtérben.' });
                const players = publicPlayers(room);
                if (!Rules.canControl(compactForRules(room, ac), player, room.settings, players)) {
                    const owners = Rules.ownersOf(compactForRules(room, ac), room.settings, players).map((p) => p.name);
                    return send(ws, {
                        t: 'cmdResult',
                        ok: false,
                        text: `${ac.callsign} nem a te géped${owners.length ? ` – ${owners.join(', ')} irányítja` : ''}.`
                    });
                }
            }
            if (room.paused && room.sim.rules.pauseQueue) {
                const last = room.queued[room.queued.length - 1];
                // húzás közben csak az utolsó helyzet számít
                if (last && cmd.type === 'moveWaypoint' && last.cmd.type === 'moveWaypoint' && last.cmd.id === cmd.id && last.cmd.index === cmd.index) {
                    last.cmd = cmd;
                } else if (room.queued.length < 200) {
                    room.queued.push({ player, cmd });
                }
                send(ws, { t: 'cmdResult', ok: true, text: null, queued: true });
                broadcast(room, { t: 'queued', count: room.queued.length });
                return;
            }
            runCommand(room, player, cmd, true);
            break;
        }
        default:
            break;
    }
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.msgWindow = { start: Date.now(), count: 0 };
    ws.on('message', (data) => {
        // egyszerű elárasztás elleni védelem
        const now = Date.now();
        if (now - ws.msgWindow.start > 1000) ws.msgWindow = { start: now, count: 0 };
        ws.msgWindow.count += 1;
        if (ws.msgWindow.count > MAX_MESSAGES_PER_SECOND) return;
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            return;
        }
        try {
            handle(ws, msg);
        } catch (e) {
            console.error('Hiba az üzenet feldolgozásakor:', e);
        }
    });
    ws.on('close', () => onDisconnect(ws));
});

setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Légtér fut: http://localhost:${PORT}`);
});

function shutdown() {
    console.log('Leállás…');
    for (const ws of wss.clients) ws.close(1001, 'Szerver újraindul');
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { server };
