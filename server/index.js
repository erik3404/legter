'use strict';
// Légtér – HTTP + WebSocket szerver. A szimuláció itt fut, a böngészők csak megjelenítenek és parancsot küldenek.
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Sim, AIRPORTS } = require('../shared/sim');
const Rules = require('../shared/rules');

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 100;
const BROADCAST_EVERY = 2; // tick-enként -> 5 Hz
const PLAYER_COLORS = ['#4fd1c5', '#f6ad55', '#b794f4', '#68d391', '#f687b3', '#63b3ed'];
const SPEEDS = [0.5, 1, 1.5, 2, 4];

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.get('/api/airports', (req, res) => {
    res.json(Object.values(AIRPORTS).map((a) => ({ icao: a.icao, name: a.name, runways: a.runways.length })));
});
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg) {
    const data = JSON.stringify(msg);
    for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(data);
}

function publicPlayers(room) {
    return [...room.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, role: p.role, sector: p.sector, selected: p.selected
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
        ws,
        name: cleanName(name),
        color: freeColor(room),
        role: 'all',
        sector: freeSector(room),
        selected: null
    };
    // a repteres módban az új játékos a még üres szerepet kapja
    const roles = [...room.players.values()].map((p) => p.role);
    player.role = ['dep', 'arr'].find((r) => !roles.includes(r)) || 'all';
    room.players.set(player.id, player);
    if (!room.hostId) room.hostId = player.id;
    ws.roomCode = room.code;
    ws.playerId = player.id;
    send(ws, { t: 'joined', you: player.id, room: roomInfo(room) });
    if (room.sim) send(ws, { t: 'static', info: room.sim.staticInfo() });
    sendRoom(room);
    if (room.players.size > 1) broadcast(room, { t: 'log', kind: 'info', text: `${player.name} csatlakozott.` });
    return player;
}

function removePlayer(ws) {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const player = room.players.get(ws.playerId);
    room.players.delete(ws.playerId);
    if (room.players.size === 0) {
        clearInterval(room.interval);
        rooms.delete(room.code);
        return;
    }
    if (room.hostId === ws.playerId) room.hostId = room.players.keys().next().value;
    if (player) broadcast(room, { t: 'log', kind: 'info', text: `${player.name} kilépett.` });
    sendRoom(room);
}

function createRoom(settings) {
    const room = {
        code: makeCode(),
        hostId: null,
        players: new Map(),
        settings: {
            airport: AIRPORTS[settings.airport] ? settings.airport : 'LOWW',
            mode: Rules.MODES[settings.mode] ? settings.mode : 'free',
            traffic: ['light', 'normal', 'busy'].includes(settings.traffic) ? settings.traffic : 'normal',
            sectorOffset: 0
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

function startGame(room) {
    room.sim = new Sim(room.settings.airport, { traffic: room.settings.traffic });
    room.paused = false;
    broadcast(room, { t: 'static', info: room.sim.staticInfo() });
    broadcast(room, { t: 'log', kind: 'info', text: `Műszak indul: ${room.sim.airport.name}. Az első induló gépek már várnak.` });
    sendRoom(room);
}

function tickRoom(room) {
    if (!room.sim) return;
    if (!room.paused) room.sim.step((TICK_MS / 1000) * room.speed);
    room.tick += 1;
    if (room.tick % BROADCAST_EVERY === 0) {
        broadcast(room, { t: 'state', s: room.sim.snapshot(), ev: room.sim.drainEvents() });
    }
}

function compactForRules(ac) {
    return { k: ac.kind, st: ac.state, x: ac.x, y: ac.y };
}

function handle(ws, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'create') {
        if (ws.roomCode) removePlayer(ws);
        const room = createRoom(msg.settings || {});
        addPlayer(room, ws, msg.name);
        return;
    }
    if (msg.t === 'join') {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room) return send(ws, { t: 'error', text: 'Nincs ilyen szoba. Ellenőrizd a kódot.' });
        if (room.players.size >= 6) return send(ws, { t: 'error', text: 'A szoba megtelt (max. 6 fő).' });
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
        case 'settings': {
            if (!isHost) return;
            const s = msg.settings || {};
            if (!room.sim && AIRPORTS[s.airport]) room.settings.airport = s.airport;
            if (!room.sim && ['light', 'normal', 'busy'].includes(s.traffic)) room.settings.traffic = s.traffic;
            if (Rules.MODES[s.mode]) room.settings.mode = s.mode;
            if (typeof s.sectorOffset === 'number') room.settings.sectorOffset = ((Math.round(s.sectorOffset) % 360) + 360) % 360;
            sendRoom(room);
            break;
        }
        case 'player': {
            const target = msg.targetId && isHost ? room.players.get(msg.targetId) : player;
            if (!target) return;
            if (Rules.ROLES[msg.role]) target.role = msg.role;
            if (Number.isInteger(msg.sector) && msg.sector >= 0 && msg.sector < 6) target.sector = msg.sector;
            if (msg.name && target === player) target.name = cleanName(msg.name);
            sendRoom(room);
            break;
        }
        case 'start':
            if (isHost && !room.sim) startGame(room);
            break;
        case 'restart':
            if (isHost) startGame(room);
            break;
        case 'end':
            if (isHost && room.sim) {
                broadcast(room, { t: 'ended', stats: room.sim.stats, incidents: room.sim.incidentLog, time: room.sim.time });
                room.sim = null;
                sendRoom(room);
            }
            break;
        case 'pause':
            if (isHost) {
                room.paused = typeof msg.value === 'boolean' ? msg.value : !room.paused;
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
        case 'cmd': {
            if (!room.sim) return;
            const cmd = msg.cmd || {};
            if (cmd.type === 'flipRunway' && !isHost && room.settings.mode !== 'free') {
                return send(ws, { t: 'cmdResult', ok: false, text: 'Az üzemi irányt csak a szobagazda fordíthatja.' });
            }
            if (cmd.id != null) {
                const ac = room.sim.find(cmd.id);
                if (!ac) return send(ws, { t: 'cmdResult', ok: false, text: 'Ez a gép már nincs a légtérben.' });
                const players = publicPlayers(room);
                if (!Rules.canControl(compactForRules(ac), player, room.settings, players)) {
                    const owners = Rules.ownersOf(compactForRules(ac), room.settings, players).map((p) => p.name);
                    return send(ws, {
                        t: 'cmdResult',
                        ok: false,
                        text: `${ac.callsign} nem a te géped${owners.length ? ` – ${owners.join(', ')} irányítja` : ''}.`
                    });
                }
            }
            const [ok, text] = room.sim.command(cmd);
            send(ws, { t: 'cmdResult', ok, text: ok ? null : text });
            if (ok && text) broadcast(room, { t: 'log', kind: 'radio', text, by: player.name, color: player.color });
            break;
        }
        default:
            break;
    }
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data) => {
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
    ws.on('close', () => removePlayer(ws));
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

server.listen(PORT, () => {
    console.log(`Légtér fut: http://localhost:${PORT}`);
});

module.exports = { server };
