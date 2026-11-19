/* Légtér – böngészős kliens: megjelenítés, egér és billentyűzet, lobby. */
(function () {
    'use strict';

    const Rules = window.LegterRules;
    const $ = (id) => document.getElementById(id);
    const KIND_LABEL = { arr: 'ÉRK', dep: 'IND', transit: 'ÁTR' };
    const KIND_NAME = { arr: 'Érkező', dep: 'Induló', transit: 'Átrepülő' };
    const COLORS = {
        arr: '#ff6f7d', dep: '#5fa8ff', transit: '#f5c451', bad: '#ff4d5e',
        grid: 'rgba(120,150,190,0.07)', ring: 'rgba(120,150,190,0.16)', airspace: 'rgba(79,209,197,0.35)',
        runway: '#9fb0c6', text: '#c9d4e3', muted: '#6f7f96', accent: '#4fd1c5'
    };

    // ---------- állapot ----------
    const state = {
        ws: null,
        me: null,
        room: null,
        info: null,          // statikus reptéradat
        snap: null,          // legutóbbi pillanatkép
        acById: new Map(),
        trails: new Map(),
        selected: null,
        lastTrailT: 0,
        cycleIndex: 0,
        drag: null,
        localRoute: null,    // húzás közbeni helyi útvonal
        map: null,           // háttértérkép
        view: { zoom: 1, panX: 0, panY: 0 },
        logs: [],
        firstAirspaceSeen: new Map()
    };
    let soloPending = false;

    // ---------- hálózat ----------
    function connect() {
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
        const ws = new WebSocket(url);
        state.ws = ws;
        ws.onmessage = (e) => onMessage(JSON.parse(e.data));
        ws.onclose = () => { $('disconnected').hidden = false; };
        return new Promise((resolve) => { ws.onopen = resolve; });
    }

    function send(msg) {
        if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg));
    }

    function cmd(type, extra = {}) {
        send({ t: 'cmd', cmd: Object.assign({ type }, extra) });
    }

    function onMessage(m) {
        switch (m.t) {
            case 'joined':
                state.me = m.you;
                state.room = m.room;
                if (m.room && m.room.code) {
                    try { history.replaceState(null, '', `?room=${m.room.code}`); } catch (e) { /* nem baj */ }
                }
                renderLobby();
                if (soloPending) {
                    soloPending = false;
                    send({ t: 'start' });
                }
                break;
            case 'room':
                state.room = m.room;
                renderLobby();
                renderPlayers();
                renderTopbar();
                break;
            case 'static':
                state.info = m.info;
                state.snap = null;
                state.trails.clear();
                state.selected = null;
                state.view = { zoom: 1, panX: 0, panY: 0 };
                $('summary').hidden = true;
                renderLobby();
                $('wind').textContent = `SZÉL ${String(m.info.windFrom).padStart(3, '0')}°`;
                loadMap(m.info.icao);
                break;
            case 'state':
                onState(m.s);
                for (const ev of m.ev) addLog(ev.kind, ev.text, ev.t);
                break;
            case 'log':
                addLog(m.kind, m.text, null, m.by, m.color);
                break;
            case 'cmdResult':
                if (!m.ok && m.text) addLog('warn', m.text);
                break;
            case 'error':
                $('lobby-error').textContent = m.text;
                break;
            case 'ended':
                showSummary(m);
                break;
            default:
                break;
        }
    }

    function onState(s) {
        state.snap = s;
        state.acById.clear();
        for (const a of s.aircraft) {
            state.acById.set(a.id, a);
            if (!state.firstAirspaceSeen.has(a.id) && a.st !== 'ground') state.firstAirspaceSeen.set(a.id, s.t);
        }
        if (s.t - state.lastTrailT >= 2 || s.t < state.lastTrailT) {
            state.lastTrailT = s.t;
            for (const a of s.aircraft) {
                if (a.st === 'ground') continue;
                const tr = state.trails.get(a.id) || [];
                tr.push([a.x, a.y]);
                if (tr.length > 6) tr.shift();
                state.trails.set(a.id, tr);
            }
            for (const id of state.trails.keys()) if (!state.acById.has(id)) state.trails.delete(id);
        }
        if (state.selected != null && !state.acById.has(state.selected)) select(null);
        renderTopbar();
        renderLists();
        renderSelected();
    }

    // ---------- segédek ----------
    const myPlayer = () => state.room && state.room.players.find((p) => p.id === state.me);
    const isHost = () => state.room && state.room.hostId === state.me;
    const canControl = (ac) => !state.room || Rules.canControl(ac, myPlayer(), state.room.settings, state.room.players);
    const fmtTime = (sec) => {
        const s = Math.max(0, Math.floor(sec));
        const h = Math.floor(s / 3600);
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const runwayLabel = (idx) => {
        if (!state.info || idx == null) return '–';
        const rw = state.info.runways[idx];
        const end = state.snap ? state.snap.runways[idx] : 0;
        return rw ? rw.names[end] : '–';
    };
    const fl = (alt) => String(Math.round(alt / 100)).padStart(3, '0');

    function addLog(kind, text, t, by, color) {
        const entry = { kind, text, t: t != null ? t : (state.snap ? Math.round(state.snap.t) : 0), by, color };
        state.logs.push(entry);
        if (state.logs.length > 200) state.logs.shift();
        const last = $('log-last');
        last.className = kind;
        last.innerHTML = (by ? `<span class="by" style="color:${color}">${esc(by)}:</span>` : '') + esc(text);
        if (!$('log-history').hidden) renderLogHistory();
    }

    function renderLogHistory() {
        $('log-history').innerHTML = state.logs.slice(-40).reverse().map((l) => `
            <div class="log-line ${l.kind}"><span class="t">${fmtTime(l.t)}</span>${l.by ? `<span class="by" style="color:${l.color}">${esc(l.by)}:</span>` : ''}${esc(l.text)}</div>`).join('');
    }

    // ---------- kijelölés ----------
    function select(id) {
        if (state.selected === id) return;
        state.selected = id;
        state.localRoute = null;
        send({ t: 'select', id });
        renderLists();
        renderSelected();
    }

    // ---------- felső sáv ----------
    function renderTopbar() {
        const r = state.room;
        $('tb-airport').textContent = state.info ? `${state.info.icao} · ${state.info.name}` : '–';
        $('tb-room').textContent = r ? r.code : '–';
        if (state.snap) {
            $('tb-clock').textContent = fmtTime(state.snap.t);
            $('st-landed').textContent = state.snap.stats.landed;
            $('st-departed').textContent = state.snap.stats.departed;
            $('st-transited').textContent = state.snap.stats.transited;
            $('st-incidents').textContent = state.snap.stats.incidents;
        }
        if (r) {
            for (const b of document.querySelectorAll('#speed-seg button')) {
                b.classList.toggle('on', Number(b.dataset.speed) === r.speed);
                b.disabled = !isHost();
            }
            $('btn-pause').textContent = r.paused ? '▶ Folytatás' : 'Ⅱ Szünet';
            $('btn-pause').disabled = !isHost() || !r.started;
            $('btn-end').disabled = !isHost() || !r.started;
        }
    }

    // ---------- listák ----------
    function renderLists() {
        const list = state.snap ? state.snap.aircraft : [];
        const deps = list.filter((a) => a.st === 'ground');
        const air = list.filter((a) => a.st !== 'ground')
            .sort((a, b) => (state.firstAirspaceSeen.get(b.id) || 0) - (state.firstAirspaceSeen.get(a.id) || 0));
        $('dep-count').textContent = String(deps.length).padStart(2, '0');
        $('air-count').textContent = String(air.length).padStart(2, '0');
        $('dep-list').innerHTML = deps.length ? deps.map((a) => rowHtml(a, true)).join('')
            : '<div class="empty-list">Nincs várakozó induló.</div>';
        $('air-list').innerHTML = air.length ? air.map((a) => rowHtml(a, false)).join('')
            : '<div class="empty-list">Csend van. Hamarosan jön a forgalom.</div>';
    }

    function rowHtml(a, ground) {
        const cls = state.info ? state.info.classes[a.c].short : '';
        const locked = !canControl(a);
        let right;
        if (ground) {
            right = `<div class="timer ${a.gf < 60 ? 'low' : ''}">FÖLD ${a.gf}s</div>`;
        } else {
            right = `<div class="timer ${a.f < 90 ? 'low' : ''}">${a.st === 'final' ? 'VÉGSŐ' : a.st === 'rollout' ? 'GURUL' : `${a.f}s`}</div>`;
        }
        const target = a.k === 'arr' ? (a.rw != null ? `RWY ${runwayLabel(a.rw)}` : 'nincs kifutó')
            : `<span class="gate-chip">${a.eg}</span>${a.k === 'dep' ? `RWY ${runwayLabel(a.rw)}` : `${a.ig} → ${a.eg}`}`;
        return `<div class="ac-row k-${a.k} ${state.selected === a.id ? 'sel' : ''} ${locked ? 'locked' : ''}" data-id="${a.id}">
            <span class="badge" style="color:${COLORS[a.k]}">${KIND_LABEL[a.k]}</span>
            <div><div class="cs">${a.cs}</div><div class="meta">${cls} · ${target}</div></div>
            ${right}</div>`;
    }

    // ---------- kijelölt gép ----------
    function renderSelected() {
        const card = $('sel-card');
        const a = state.selected != null ? state.acById.get(state.selected) : null;
        if (!a || !state.info) {
            if (!card.querySelector('.empty-sel')) {
                card.innerHTML = `<div class="empty-sel"><div class="kicker">Te vagy az irányító</div><h2>Válassz ki egy gépet.</h2>
                <p>Kattints egy gépre a térképen vagy a listában. Utána kattints a térképre útpontért,
                nyomd meg a kifutó számát (1–9) a leszálláshoz, vagy az <kbd>X</kbd>-et a felszálláshoz.</p></div>`;
            }
            return;
        }
        const c = state.info.classes[a.c];
        const fuelMax = a.st === 'ground' ? 300 : (a.k === 'transit' ? 520 : 600);
        const fuel = a.st === 'ground' ? a.gf : a.f;
        const pct = Math.max(0, Math.min(100, (fuel / fuelMax) * 100));
        const locked = !canControl(a);
        let status;
        if (a.st === 'ground') status = `Földön vár · felszállás: ${runwayLabel(a.rw)} · kijárat: ${a.eg}`;
        else if (a.st === 'takeoff') status = `Felszáll · ${runwayLabel(a.rw)}`;
        else if (a.st === 'final') status = `Végső megközelítés · ${runwayLabel(a.rw)}`;
        else if (a.st === 'rollout') status = `Kigurul · ${runwayLabel(a.rw)}`;
        else if (a.k === 'arr') status = a.rw != null ? `Megközelítés · ${runwayLabel(a.rw)}` : 'Kifutóra vár – nyomd meg a számát';
        else status = `Kijárat: ${a.eg} kapu`;
        if (a.hd) status += ' · körözik';

        const rwButtons = state.info.runways.map((rw, i) => `<button class="btn rw-btn ${a.rw === i ? 'active' : ''}" data-act="runway" data-rw="${i}">${runwayLabel(i)}<kbd>${i + 1}</kbd></button>`).join('');
        let actions = '';
        if (a.st === 'ground') {
            actions = `<div class="btn-row">${rwButtons}</div><div class="btn-row"><button class="btn primary" data-act="takeoff">Felszállás<kbd>X</kbd></button></div>`;
        } else if (a.st === 'airborne' || a.st === 'final') {
            actions = `${a.k === 'arr' ? `<div class="btn-row">${rwButtons}</div>` : ''}
                <div class="btn-row">
                    <button class="btn" data-act="alt" data-d="-1000">▼ 1000<kbd>D</kbd></button>
                    <button class="btn" data-act="alt" data-d="1000">▲ 1000<kbd>C</kbd></button>
                    <button class="btn" data-act="spd" data-d="-10">− 10 kt<kbd>S</kbd></button>
                    <button class="btn" data-act="spd" data-d="10">+ 10 kt<kbd>W</kbd></button>
                </div>
                <div class="btn-row">
                    <button class="btn" data-act="hold">${a.hd ? 'Körözés vége' : 'Körözés'}<kbd>R</kbd></button>
                    ${a.st === 'final' ? '<button class="btn" data-act="goaround">Átstartolás<kbd>G</kbd></button>' : ''}
                    ${a.r.length ? '<button class="btn ghost" data-act="clearroute">Útpontok törlése</button>' : ''}
                </div>`;
        }
        let ownerNote = '';
        if (locked) {
            const owners = Rules.ownersOf(a, state.room.settings, state.room.players).map((p) => p.name);
            ownerNote = `<div class="owner-note">Nem a te géped${owners.length ? ` – ${esc(owners.join(', '))} irányítja` : ''}.</div>`;
        }
        card.innerHTML = `
            <div class="sel-head"><span class="cs" style="color:${COLORS[a.k]}">${a.cs}</span><span class="badge" style="color:${COLORS[a.k]}">${KIND_LABEL[a.k]}</span></div>
            <div class="sel-sub">${KIND_NAME[a.k]} · ${c.label}</div>
            <div class="sel-grid">
                <div><div class="tb-label">Állapot</div><div style="font-size:13px">${status}</div></div>
                <div><div class="tb-label">${a.st === 'ground' ? 'Földi idő' : 'Üzemanyag'}</div><div class="v">${fuel}s</div>
                    <div class="fuel-bar"><i class="${pct < 20 ? 'low' : ''}" style="width:${pct}%"></i></div></div>
                <div><div class="tb-label">Magasság</div><div class="v">${fl(a.al)}${a.ta !== a.al ? ` → ${fl(a.ta)}` : ''}</div></div>
                <div><div class="tb-label">Sebesség</div><div class="v">${a.s}${a.ts !== a.s ? ` → ${a.ts}` : ''} kt</div></div>
            </div>
            ${locked ? '' : actions}
            ${ownerNote}`;
    }

    // ---------- játékosok ----------
    function playerRoleText(p) {
        const s = state.room.settings;
        if (s.mode === 'roles') return Rules.ROLES[p.role] || '';
        if (s.mode === 'sector') return `${p.sector + 1}. szektor`;
        return '';
    }

    function renderPlayers() {
        if (!state.room) return;
        $('mode-label').textContent = Rules.MODES[state.room.settings.mode].label;
        $('players-list').innerHTML = state.room.players.map((p) => `
            <div class="player"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}
            ${p.id === state.me ? '<span class="me">(te)</span>' : ''}${p.id === state.room.hostId ? '<span class="me">★</span>' : ''}
            <span class="role">${playerRoleText(p)}</span></div>`).join('');
    }

    // ---------- lobby ----------
    let airportsCache = [];
    async function loadAirports() {
        try {
            airportsCache = await (await fetch('/api/airports')).json();
        } catch (e) {
            airportsCache = [{ icao: 'LOWW', name: 'Bécs – Schwechat', runways: 2 }];
        }
        const opts = airportsCache.map((a) => `<option value="${a.icao}">${a.icao} · ${esc(a.name)} (${a.runways} kifutó)</option>`).join('');
        $('in-airport').innerHTML = opts;
        $('rs-airport').innerHTML = opts;
        const modeOpts = Object.entries(Rules.MODES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
        $('in-mode').innerHTML = modeOpts;
        $('rs-mode').innerHTML = modeOpts;
        $('mode-desc').textContent = Rules.MODES[$('in-mode').value].desc;
    }

    function renderLobby() {
        const r = state.room;
        const lobby = $('lobby');
        if (!r) {
            lobby.hidden = false;
            $('lobby-start').hidden = false;
            $('lobby-room').hidden = true;
            return;
        }
        if (r.started && state.info) {
            lobby.hidden = true;
            return;
        }
        lobby.hidden = false;
        $('lobby-start').hidden = true;
        $('lobby-room').hidden = false;
        $('room-code').textContent = r.code;
        const host = isHost();
        for (const id of ['rs-airport', 'rs-traffic', 'rs-mode', 'rs-offset']) $(id).disabled = !host;
        $('rs-airport').value = r.settings.airport;
        $('rs-traffic').value = r.settings.traffic;
        $('rs-mode').value = r.settings.mode;
        $('rs-offset').value = r.settings.sectorOffset;
        $('rs-offset-field').style.display = r.settings.mode === 'sector' ? '' : 'none';
        $('rs-mode-desc').textContent = Rules.MODES[r.settings.mode].desc;
        $('btn-start').hidden = !host;
        $('wait-host').hidden = host;
        const n = Rules.sectorCount(r.players);
        $('room-players').innerHTML = r.players.map((p) => {
            const editable = host || p.id === state.me;
            let sel = '';
            if (r.settings.mode === 'roles') {
                sel = `<select data-pid="${p.id}" data-field="role" ${editable ? '' : 'disabled'}>${Object.entries(Rules.ROLES).map(([k, v]) => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
            } else if (r.settings.mode === 'sector') {
                sel = `<select data-pid="${p.id}" data-field="sector" ${editable ? '' : 'disabled'}>${Array.from({ length: Math.max(n, 6) }, (_, i) => `<option value="${i}" ${p.sector === i ? 'selected' : ''}>${i + 1}. szektor</option>`).join('')}</select>`;
            }
            return `<div class="rp"><span class="dot" style="background:${p.color}"></span>
                <span>${esc(p.name)}${p.id === r.hostId ? '<span class="host">GAZDA</span>' : ''}${p.id === state.me ? ' <span class="hint">(te)</span>' : ''}</span>
                ${sel}<span></span></div>`;
        }).join('');
    }

    function getName() {
        const name = $('in-name').value.trim() || 'Irányító';
        try { localStorage.setItem('legter-name', name); } catch (e) { /* nem baj */ }
        return name;
    }

    function lobbySettings() {
        return { airport: $('in-airport').value, mode: $('in-mode').value, traffic: $('in-traffic').value };
    }

    function bindLobby() {
        try { $('in-name').value = localStorage.getItem('legter-name') || ''; } catch (e) { /* nem baj */ }
        const params = new URLSearchParams(location.search);
        if (params.get('room')) $('in-code').value = params.get('room').toUpperCase();
        $('in-mode').onchange = () => { $('mode-desc').textContent = Rules.MODES[$('in-mode').value].desc; };
        $('btn-solo').onclick = () => {
            soloPending = true;
            send({ t: 'create', name: getName(), settings: Object.assign(lobbySettings(), { mode: 'free' }) });
        };
        $('btn-create').onclick = () => send({ t: 'create', name: getName(), settings: lobbySettings() });
        $('btn-join').onclick = () => {
            const code = $('in-code').value.trim().toUpperCase();
            if (code.length !== 4) {
                $('lobby-error').textContent = 'A szobakód 4 betű.';
                return;
            }
            send({ t: 'join', code, name: getName() });
        };
        $('in-code').onkeydown = (e) => { if (e.key === 'Enter') $('btn-join').click(); };
        $('btn-start').onclick = () => send({ t: 'start' });
        $('btn-leave').onclick = () => { location.href = location.pathname; };
        $('btn-copy').onclick = async () => {
            const link = `${location.origin}${location.pathname}?room=${state.room.code}`;
            try {
                await navigator.clipboard.writeText(link);
                $('btn-copy').textContent = 'Másolva ✓';
            } catch (e) {
                prompt('Másold ki a linket:', link);
            }
        };
        const pushSettings = () => send({
            t: 'settings',
            settings: {
                airport: $('rs-airport').value,
                traffic: $('rs-traffic').value,
                mode: $('rs-mode').value,
                sectorOffset: Number($('rs-offset').value)
            }
        });
        for (const id of ['rs-airport', 'rs-traffic', 'rs-mode', 'rs-offset']) $(id).onchange = pushSettings;
        $('room-players').onchange = (e) => {
            const s = e.target;
            if (!s.dataset.pid) return;
            const pid = Number(s.dataset.pid);
            const msg = { t: 'player', targetId: pid === state.me ? undefined : pid };
            if (s.dataset.field === 'role') msg.role = s.value;
            else msg.sector = Number(s.value);
            send(msg);
        };
    }
    function showSummary(m) {
        const s = m.stats;
        $('sum-title').textContent = `${fmtTime(m.time)} műszak · ${s.landed + s.departed + s.transited} mozgás`;
        $('sum-body').innerHTML = `<div class="sum-stats">
            <div><b class="arr-c">${s.landed}</b>leszállt</div><div><b class="dep-c">${s.departed}</b>felszállt</div>
            <div><b class="tr-c">${s.transited}</b>átrepült</div><div><b class="bad-c">${s.incidents}</b>incidens</div></div>
            <div class="sum-inc">${m.incidents.length ? m.incidents.map((i) => `<div>${fmtTime(i.t)} · ${esc(i.callsign)} – ${esc(i.reason)}</div>`).join('') : 'Tiszta műszak, egyetlen incidens nélkül.'}</div>`;
        $('btn-again').hidden = !isHost();
        $('summary').hidden = false;
    }

    // ---------- radar rajzolás ----------
    const canvas = $('scope');
    const ctx = canvas.getContext('2d');
    let W = 0;
    let H = 0;
    let DPR = 1;

    function resize() {
        const r = canvas.getBoundingClientRect();
        DPR = window.devicePixelRatio || 1;
        W = r.width;
        H = r.height;
        canvas.width = Math.round(W * DPR);
        canvas.height = Math.round(H * DPR);
    }

    function scale() {
        const R = state.info ? state.info.radius : 18;
        return (Math.min(W, H) / (2 * (R + 2.2))) * state.view.zoom;
    }
    function toScreen(x, y) {
        const k = scale();
        return [W / 2 + (x + state.view.panX) * k, H / 2 - (y + state.view.panY) * k];
    }
    function toWorld(sx, sy) {
        const k = scale();
        return [(sx - W / 2) / k - state.view.panX, -(sy - H / 2) / k - state.view.panY];
    }

    function routeFor(a) {
        if (state.localRoute && state.localRoute.id === a.id) return state.localRoute.route;
        return a.r;
    }

    function routeEnd(a) {
        if (!state.info) return [];
        if (a.k === 'arr' && a.rw != null) {
            const rw = state.info.runways[a.rw];
            const end = state.snap.runways[a.rw];
            const thr = rw.ends[end];
            const other = rw.ends[1 - end];
            const len = Math.hypot(other[0] - thr[0], other[1] - thr[1]);
            const ux = (thr[0] - other[0]) / len;
            const uy = (thr[1] - other[1]) / len;
            const faf = [thr[0] + ux * state.info.fafDistance, thr[1] + uy * state.info.fafDistance];
            return a.st === 'final' ? [thr] : [faf, thr];
        }
        if (a.eg) {
            const g = state.info.gates.find((x) => x.letter === a.eg);
            return g ? [g.pos] : [];
        }
        return [];
    }

    // ---------- háttértérkép ----------
    const MAP_COLORS = {
        water: '#162a3a', land: '#131c27', urban: 'rgba(150,170,200,0.07)', road: 'rgba(170,190,215,0.12)',
        roadMajor: 'rgba(170,190,215,0.2)', river: '#1d3a50', place: 'rgba(170,185,205,0.45)',
        terrainEdge: 'rgba(160,180,200,0.10)'
    };
    const bg = { canvas: document.createElement('canvas'), key: '' };

    async function loadMap(icao) {
        state.map = null;
        try {
            const res = await fetch(`/shared/maps/${icao}.json`);
            if (res.ok && state.info && state.info.icao === icao) state.map = await res.json();
        } catch (e) { /* térkép nélkül is játszható */ }
        bg.key = '';
    }

    function tracePoly(c, rings) {
        c.beginPath();
        for (const ring of rings) {
            ring.forEach((p, i) => {
                const [x, y] = toScreen(p[0], p[1]);
                if (i) c.lineTo(x, y); else c.moveTo(x, y);
            });
            c.closePath();
        }
    }

    function renderBackground(c) {
        const m = state.map;
        const k = scale();
        const R = state.info.radius;
        c.fillStyle = m && m.land.length ? MAP_COLORS.water : MAP_COLORS.land;
        c.fillRect(0, 0, W, H);
        if (m) {
            c.fillStyle = MAP_COLORS.land;
            for (const poly of m.land) { tracePoly(c, poly); c.fill('evenodd'); }
            // domborzat: magasabb terület világosabb
            const elevs = m.terrain.map((t) => t.e);
            const maxE = Math.max(1, ...elevs);
            const minE = Math.min(...elevs, maxE);
            for (const t of [...m.terrain].sort((a, b) => a.e - b.e)) {
                const f = (t.e - minE) / Math.max(1, maxE - minE);
                c.fillStyle = `rgba(150,175,200,${0.025 + f * 0.07})`;
                tracePoly(c, t.r);
                c.fill('evenodd');
                c.strokeStyle = MAP_COLORS.terrainEdge;
                c.lineWidth = 0.8;
                c.stroke();
            }
            c.fillStyle = MAP_COLORS.urban;
            for (const poly of m.urban) { tracePoly(c, poly); c.fill('evenodd'); }
            c.fillStyle = MAP_COLORS.water;
            for (const poly of m.lakes) { tracePoly(c, poly); c.fill('evenodd'); }
            c.lineCap = 'round';
            c.lineJoin = 'round';
            c.strokeStyle = MAP_COLORS.river;
            c.lineWidth = Math.max(1.5, 0.12 * k);
            for (const r of m.rivers) {
                c.beginPath();
                r.p.forEach((p, i) => { const [x, y] = toScreen(p[0], p[1]); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
                c.stroke();
            }
            for (const road of m.roads) {
                c.strokeStyle = road.m ? MAP_COLORS.roadMajor : MAP_COLORS.road;
                c.lineWidth = road.m ? 1.6 : 1;
                c.beginPath();
                road.p.forEach((p, i) => { const [x, y] = toScreen(p[0], p[1]); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
                c.stroke();
            }
            c.font = '600 11px ui-monospace, monospace';
            c.textAlign = 'center';
            c.fillStyle = MAP_COLORS.place;
            for (const pl of m.places) {
                if (Math.hypot(pl.x, pl.y) > R - 2) continue;
                const [x, y] = toScreen(pl.x, pl.y);
                c.fillRect(x - 1.5, y - 1.5, 3, 3);
                c.fillText(pl.n.toUpperCase(), x, y - 6);
            }
        }
        // finom rács
        c.fillStyle = COLORS.grid;
        for (let x = -R - 6; x <= R + 6; x += 2) {
            for (let y = -R - 6; y <= R + 6; y += 2) {
                const [sx, sy] = toScreen(x, y);
                c.fillRect(sx - 0.6, sy - 0.6, 1.2, 1.2);
            }
        }
        // a légtéren kívüli rész sötétítése
        const [cx, cy] = toScreen(0, 0);
        c.fillStyle = 'rgba(6,10,16,0.45)';
        c.beginPath();
        c.rect(0, 0, W, H);
        c.arc(cx, cy, R * k, 0, Math.PI * 2, true);
        c.fill();
    }

    function drawGrid() {
        const key = [W, H, DPR, state.view.zoom, state.view.panX, state.view.panY, state.info.icao, !!state.map].join('|');
        if (bg.key !== key) {
            bg.key = key;
            bg.canvas.width = Math.round(W * DPR);
            bg.canvas.height = Math.round(H * DPR);
            const c = bg.canvas.getContext('2d');
            c.setTransform(DPR, 0, 0, DPR, 0, 0);
            renderBackground(c);
        }
        ctx.drawImage(bg.canvas, 0, 0, W, H);
        const k = scale();
        const R = state.info.radius;
        const [cx, cy] = toScreen(0, 0);
        ctx.strokeStyle = COLORS.ring;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 6]);
        for (const r of [6, 12]) {
            ctx.beginPath();
            ctx.arc(cx, cy, r * k, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.strokeStyle = COLORS.airspace;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, R * k, 0, Math.PI * 2);
        ctx.stroke();
        // északi nyíl
        ctx.fillStyle = COLORS.muted;
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('É', W - 30, H - 70);
        ctx.strokeStyle = COLORS.muted;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(W - 30, H - 32);
        ctx.lineTo(W - 30, H - 60);
        ctx.lineTo(W - 34, H - 52);
        ctx.moveTo(W - 30, H - 60);
        ctx.lineTo(W - 26, H - 52);
        ctx.stroke();
    }

    function drawSectors() {
        const r = state.room;
        if (!r || r.settings.mode !== 'sector' || !state.info) return;
        const n = Rules.sectorCount(r.players);
        const k = scale();
        const R = state.info.radius;
        const [cx, cy] = toScreen(0, 0);
        ctx.save();
        ctx.strokeStyle = 'rgba(79,209,197,0.28)';
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, Rules.TOWER_RADIUS * k, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < n; i++) {
            const brg = (r.settings.sectorOffset + i * (360 / n)) * Math.PI / 180;
            const [x1, y1] = toScreen(Math.sin(brg) * Rules.TOWER_RADIUS, Math.cos(brg) * Rules.TOWER_RADIUS);
            const [x2, y2] = toScreen(Math.sin(brg) * R, Math.cos(brg) * R);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = '600 12px ui-monospace, monospace';
        ctx.textAlign = 'center';
        for (let i = 0; i < n; i++) {
            const mid = (r.settings.sectorOffset + (i + 0.5) * (360 / n)) * Math.PI / 180;
            const [tx, ty] = toScreen(Math.sin(mid) * R * 0.62, Math.cos(mid) * R * 0.62);
            const owners = r.players.filter((p) => p.sector === i);
            ctx.fillStyle = owners.length ? owners[0].color : COLORS.muted;
            ctx.globalAlpha = 0.55;
            ctx.fillText(`${i + 1}. SZEKTOR`, tx, ty);
            ctx.font = '11px system-ui, sans-serif';
            ctx.fillText(owners.map((p) => p.name).join(', ') || 'gazdátlan', tx, ty + 15);
            ctx.font = '600 12px ui-monospace, monospace';
            ctx.globalAlpha = 1;
        }
        ctx.fillStyle = 'rgba(79,209,197,0.5)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText('TORONY · KÖZÖS', cx, cy - Rules.TOWER_RADIUS * k - 6);
        ctx.restore();
    }

    const runwayLabelHits = [];
    const RUNWAY_WIDTH_NM = 0.03;

    function drawRunwayDesignator(name, x, y, angle, size) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.fillStyle = 'rgba(235,240,247,0.9)';
        ctx.font = `600 ${size}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, 0, 0);
        ctx.restore();
    }

    function drawRunways() {
        if (!state.info || !state.snap) return;
        runwayLabelHits.length = 0;
        const k = scale();
        const widthPx = Math.max(8, RUNWAY_WIDTH_NM * k * 1.6);
        // először a megközelítési tengelyek, hogy a kifutók fölöttük legyenek
        state.info.runways.forEach((rw, i) => {
            const end = state.snap.runways[i];
            const [a, b] = [rw.ends[end], rw.ends[1 - end]];
            const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const ux = (a[0] - b[0]) / len;
            const uy = (a[1] - b[1]) / len;
            const sa = toScreen(...a);
            const faf = toScreen(a[0] + ux * state.info.fafDistance, a[1] + uy * state.info.fafDistance);
            ctx.strokeStyle = 'rgba(255,111,125,0.35)';
            ctx.setLineDash([4, 5]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sa[0], sa[1]);
            ctx.lineTo(faf[0], faf[1]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(faf[0], faf[1], 3, 0, Math.PI * 2);
            ctx.stroke();
        });
        state.info.runways.forEach((rw, i) => {
            const end = state.snap.runways[i];
            const [a, b] = [rw.ends[end], rw.ends[1 - end]];
            const sa = toScreen(...a);
            const sb = toScreen(...b);
            const dx = sb[0] - sa[0];
            const dy = sb[1] - sa[1];
            const lenPx = Math.hypot(dx, dy);
            const ax = dx / lenPx;
            const ay = dy / lenPx;
            const px = -ay * widthPx / 2;
            const py = ax * widthPx / 2;
            const angle = Math.atan2(dy, dx);
            // aszfalt
            ctx.fillStyle = '#3a4554';
            ctx.strokeStyle = '#59677a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sa[0] + px, sa[1] + py);
            ctx.lineTo(sb[0] + px, sb[1] + py);
            ctx.lineTo(sb[0] - px, sb[1] - py);
            ctx.lineTo(sa[0] - px, sa[1] - py);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // küszöbcsíkok mindkét végen
            ctx.strokeStyle = 'rgba(235,240,247,0.85)';
            ctx.lineWidth = Math.max(1, widthPx / 9);
            const bars = widthPx >= 12 ? 6 : 3;
            for (const [ex, ey, dir] of [[sa[0], sa[1], 1], [sb[0], sb[1], -1]]) {
                const barLen = Math.min(lenPx * 0.06, widthPx * 0.9);
                for (let j = 0; j < bars; j++) {
                    const off = ((j + 0.5) / bars - 0.5) * widthPx * 0.8;
                    const ox = -ay * off;
                    const oy = ax * off;
                    ctx.beginPath();
                    ctx.moveTo(ex + ox + ax * dir * 2, ey + oy + ay * dir * 2);
                    ctx.lineTo(ex + ox + ax * dir * (2 + barLen), ey + oy + ay * dir * (2 + barLen));
                    ctx.stroke();
                }
            }
            // szaggatott középvonal
            const margin = Math.min(lenPx * 0.22, widthPx * 3.2);
            if (lenPx > margin * 2 + 10) {
                ctx.strokeStyle = 'rgba(235,240,247,0.55)';
                ctx.lineWidth = 1;
                ctx.setLineDash([Math.max(3, widthPx * 0.8), Math.max(3, widthPx * 0.6)]);
                ctx.beginPath();
                ctx.moveTo(sa[0] + ax * margin, sa[1] + ay * margin);
                ctx.lineTo(sb[0] - ax * margin, sb[1] - ay * margin);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            // pályaszámok a burkolaton (ha elég nagy a nagyítás)
            if (widthPx >= 11 && lenPx > widthPx * 5) {
                const fs = Math.min(widthPx * 0.62, 14);
                const inset = Math.min(lenPx * 0.06, widthPx * 0.9) + fs;
                drawRunwayDesignator(rw.names[end], sa[0] + ax * inset, sa[1] + ay * inset, angle + Math.PI / 2);
                drawRunwayDesignator(rw.names[1 - end], sb[0] - ax * inset, sb[1] - ay * inset, angle - Math.PI / 2);
            }
            // aktív vég: billentyűszám + név a küszöb előtt
            const lx = sa[0] - ax * (widthPx + 14);
            const ly = sa[1] - ay * (widthPx + 14);
            ctx.fillStyle = '#0e1622';
            ctx.strokeStyle = COLORS.arr;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(lx, ly, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = COLORS.text;
            ctx.font = '600 11px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), lx, ly);
            ctx.fillStyle = '#e6ecf4';
            ctx.font = '600 10px ui-monospace, monospace';
            ctx.fillText(rw.names[end], lx - ax * 20, ly - ay * 20);
            ctx.textBaseline = 'alphabetic';
            runwayLabelHits.push({ index: i, x: lx, y: ly });
        });
    }

    function drawGates() {
        if (!state.info) return;
        for (const g of state.info.gates) {
            const [sx, sy] = toScreen(...g.pos);
            ctx.fillStyle = '#0e1622';
            ctx.strokeStyle = 'rgba(201,212,227,0.55)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sx, sy, 17, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = COLORS.text;
            ctx.font = '600 15px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(g.letter, sx, sy + 1);
            ctx.textBaseline = 'alphabetic';
            // a fix neve a kör belső oldalára kerül
            const sinB = Math.sin(g.bearing * Math.PI / 180);
            const cosB = Math.cos(g.bearing * Math.PI / 180);
            ctx.fillStyle = COLORS.muted;
            ctx.font = '11px ui-monospace, monospace';
            if (sinB > 0.3) {
                ctx.textAlign = 'right';
                ctx.fillText(g.name, sx - 24, sy + cosB * 26 + 4);
            } else if (sinB < -0.3) {
                ctx.textAlign = 'left';
                ctx.fillText(g.name, sx + 24, sy + cosB * 26 + 4);
            } else {
                ctx.fillText(g.name, sx, sy + (cosB > 0 ? 32 : -26));
            }
        }
    }

    function drawPlane(sx, sy, hdg, color, size) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(hdg * Math.PI / 180);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size * 0.22, -size * 0.3);
        ctx.lineTo(size, size * 0.15);
        ctx.lineTo(size, size * 0.35);
        ctx.lineTo(size * 0.2, size * 0.15);
        ctx.lineTo(size * 0.15, size * 0.65);
        ctx.lineTo(size * 0.45, size * 0.9);
        ctx.lineTo(size * 0.45, size);
        ctx.lineTo(0, size * 0.85);
        ctx.lineTo(-size * 0.45, size);
        ctx.lineTo(-size * 0.45, size * 0.9);
        ctx.lineTo(-size * 0.15, size * 0.65);
        ctx.lineTo(-size * 0.2, size * 0.15);
        ctx.lineTo(-size, size * 0.35);
        ctx.lineTo(-size, size * 0.15);
        ctx.lineTo(-size * 0.22, -size * 0.3);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    function drawRoute(a, color) {
        const pts = [[a.x, a.y], ...routeFor(a), ...routeEnd(a)];
        const scr = pts.map((p) => toScreen(...p));
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        scr.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.setLineDash([]);
        routeFor(a).forEach((p, i) => {
            const [x, y] = toScreen(...p);
            ctx.fillStyle = '#0e1622';
            ctx.beginPath();
            ctx.arc(x, y, 7, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = color;
            ctx.font = '9px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(i + 1), x, y + 0.5);
            ctx.textBaseline = 'alphabetic';
        });
        ctx.globalAlpha = 1;
    }

    function drawAircraft(now) {
        if (!state.snap) return;
        const k = scale();
        const players = state.room ? state.room.players : [];
        const multi = players.length > 1 && state.room.settings.mode !== 'free';
        for (const a of state.snap.aircraft) {
            if (a.st === 'ground') continue;
            const [sx, sy] = toScreen(a.x, a.y);
            const color = COLORS[a.k];
            const mine = canControl(a);
            ctx.globalAlpha = multi && !mine ? 0.45 : 1;

            // nyom
            const tr = state.trails.get(a.id) || [];
            ctx.fillStyle = color;
            tr.forEach((p, i) => {
                const [tx, ty] = toScreen(...p);
                ctx.globalAlpha = (multi && !mine ? 0.45 : 1) * (0.15 + i * 0.08);
                ctx.beginPath();
                ctx.arc(tx, ty, 1.6, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.globalAlpha = multi && !mine ? 0.45 : 1;

            // konfliktus
            if (a.cf) {
                const pulse = 0.5 + 0.5 * Math.sin(now / 160);
                ctx.strokeStyle = COLORS.bad;
                ctx.lineWidth = 1.5 + pulse;
                ctx.beginPath();
                ctx.arc(sx, sy, Math.max(16, 1.5 * k), 0, Math.PI * 2);
                ctx.stroke();
            }

            // mások kijelölése
            for (const p of players) {
                if (p.id === state.me || p.selected !== a.id) continue;
                ctx.strokeStyle = p.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(sx, sy, 15, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = p.color;
                ctx.font = '10px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(p.name, sx, sy + 27);
            }

            // kijelölés
            if (state.selected === a.id) {
                drawRoute(a, color);
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(sx, sy - 19);
                ctx.lineTo(sx + 19, sy);
                ctx.lineTo(sx, sy + 19);
                ctx.lineTo(sx - 19, sy);
                ctx.closePath();
                ctx.stroke();
            }

            drawPlane(sx, sy, a.h, color, a.c === 'wide' ? 10 : a.c === 'turboprop' ? 7.5 : 8.5);

            // adatblokk
            const lines = [
                `${a.cs} ${KIND_LABEL[a.k]}${a.k === 'arr' && a.rw != null ? ` ${runwayLabel(a.rw)}` : ''}${a.k !== 'arr' ? ` →${a.eg}` : ''}`,
                `${fl(a.al)}${a.ta > a.al + 50 ? '↑' : a.ta < a.al - 50 ? '↓' : ' '}${a.ta !== a.al ? fl(a.ta) : '   '} ${a.s}kt${a.hd ? ' ⟳' : ''}`
            ];
            ctx.font = '11px ui-monospace, monospace';
            const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
            const bx = sx + 16;
            const by = sy - 30;
            ctx.fillStyle = 'rgba(14,22,34,0.82)';
            ctx.fillRect(bx, by, w, 30);
            ctx.strokeStyle = a.cf ? COLORS.bad : 'rgba(201,212,227,0.25)';
            ctx.lineWidth = 1;
            ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 29);
            if (multi) {
                const owners = Rules.ownersOf(a, state.room.settings, players);
                owners.slice(0, 3).forEach((p, i) => {
                    ctx.fillStyle = p.color;
                    ctx.fillRect(bx, by + i * (30 / Math.min(3, owners.length)), 3, 30 / Math.min(3, owners.length));
                });
            }
            ctx.textAlign = 'left';
            ctx.fillStyle = color;
            ctx.fillText(lines[0], bx + 6, by + 12);
            ctx.fillStyle = COLORS.text;
            ctx.fillText(lines[1], bx + 6, by + 25);
            if (a.f < 90 && a.st !== 'rollout') {
                ctx.fillStyle = COLORS.bad;
                ctx.fillText(`ÜZEMANYAG ${a.f}s`, bx + 6, by + 40);
            }
            ctx.globalAlpha = 1;
        }
    }

    function frame(now) {
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.fillStyle = '#0e1622';
        ctx.fillRect(0, 0, W, H);
        if (state.info) {
            drawGrid();
            drawSectors();
            drawRunways();
            drawGates();
            drawAircraft(now);
        }
        if (state.room && state.room.paused) {
            ctx.fillStyle = 'rgba(245,196,81,0.9)';
            ctx.font = '600 13px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.fillText('SZÜNET', W / 2, 24);
        }
        requestAnimationFrame(frame);
    }

    // ---------- egér ----------
    function aircraftAt(sx, sy) {
        if (!state.snap) return [];
        return state.snap.aircraft
            .filter((a) => a.st !== 'ground')
            .map((a) => {
                const [x, y] = toScreen(a.x, a.y);
                return { a, d: Math.hypot(x - sx, y - sy) };
            })
            .filter((h) => h.d < 16)
            .sort((p, q) => p.d - q.d)
            .map((h) => h.a);
    }

    function waypointAt(a, sx, sy) {
        const route = routeFor(a);
        for (let i = 0; i < route.length; i++) {
            const [x, y] = toScreen(...route[i]);
            if (Math.hypot(x - sx, y - sy) < 10) return i;
        }
        return -1;
    }

    function segmentAt(a, sx, sy) {
        const pts = [[a.x, a.y], ...routeFor(a), ...routeEnd(a).slice(0, 1)].map((p) => toScreen(...p));
        for (let i = 0; i < pts.length - 1; i++) {
            const [ax, ay] = pts[i];
            const [bx, by] = pts[i + 1];
            const dx = bx - ax;
            const dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / len2)) : 0;
            if (t > 0.05 && t < 0.95 && Math.hypot(sx - (ax + t * dx), sy - (ay + t * dy)) < 6) return i;
        }
        return -1;
    }

    function canvasPos(e) {
        const r = canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    let lastMoveSent = 0;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('mousedown', (e) => {
        const [sx, sy] = canvasPos(e);
        if (e.button === 2 || e.button === 1) {
            state.drag = { type: 'pan', sx, sy, panX: state.view.panX, panY: state.view.panY };
            return;
        }
        if (!state.snap) return;
        const sel = state.selected != null ? state.acById.get(state.selected) : null;

        // kifutó irányának fordítása
        if (e.shiftKey) {
            const hit = runwayLabelHits.find((h) => Math.hypot(h.x - sx, h.y - sy) < 11);
            if (hit) {
                cmd('flipRunway', { runway: hit.index });
                return;
            }
        }

        if (sel && canControl(sel)) {
            const wi = waypointAt(sel, sx, sy);
            if (wi >= 0) {
                state.drag = { type: 'wp', id: sel.id, index: wi, sx, sy, moved: false };
                state.localRoute = { id: sel.id, route: sel.r.map((p) => p.slice()) };
                return;
            }
            const si = segmentAt(sel, sx, sy);
            if (si >= 0 && !e.altKey) {
                state.drag = { type: 'seg', id: sel.id, index: si, sx, sy, moved: false };
                return;
            }
        }

        const hits = e.altKey ? [] : aircraftAt(sx, sy);
        if (hits.length) {
            const cur = hits.findIndex((a) => a.id === state.selected);
            const next = hits[(cur + 1) % hits.length];
            select(next.id);
            return;
        }

        if (sel) {
            if (!canControl(sel)) {
                addLog('warn', `${sel.cs} nem a te géped.`);
                return;
            }
            const [x, y] = toWorld(sx, sy);
            if (sel.st === 'ground' || sel.st === 'takeoff' || sel.st === 'rollout') {
                if (sel.st === 'ground') addLog('warn', `${sel.cs} még a földön van – előbb szállj fel vele (X).`);
                return;
            }
            const R = state.info.radius;
            if (Math.hypot(x, y) > R + 1) return;
            if (e.shiftKey) cmd('replaceRoute', { id: sel.id, x, y });
            else cmd('addWaypoint', { id: sel.id, x, y });
            // azonnali visszajelzés
            sel.r = e.shiftKey ? [[x, y]] : sel.r;
            return;
        }
        select(null);
    });

    window.addEventListener('mousemove', (e) => {
        const d = state.drag;
        if (!d) return;
        const [sx, sy] = canvasPos(e);
        if (d.type === 'pan') {
            const k = scale();
            state.view.panX = d.panX + (sx - d.sx) / k;
            state.view.panY = d.panY - (sy - d.sy) / k;
            return;
        }
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 4) return;
        const [x, y] = toWorld(sx, sy);
        if (d.type === 'seg' && !d.moved) {
            const a = state.acById.get(d.id);
            if (!a) return;
            state.localRoute = { id: d.id, route: a.r.map((p) => p.slice()) };
            state.localRoute.route.splice(d.index, 0, [x, y]);
            cmd('addWaypoint', { id: d.id, x, y, index: d.index });
            d.type = 'wp';
        }
        d.moved = true;
        if (state.localRoute && state.localRoute.route[d.index]) state.localRoute.route[d.index] = [x, y];
        const now = performance.now();
        if (now - lastMoveSent > 60) {
            lastMoveSent = now;
            cmd('moveWaypoint', { id: d.id, index: d.index, x, y });
        }
    });

    window.addEventListener('mouseup', (e) => {
        const d = state.drag;
        state.drag = null;
        if (!d || d.type === 'pan') return;
        if (d.type === 'wp') {
            if (d.moved) {
                const [x, y] = toWorld(...canvasPos(e));
                cmd('moveWaypoint', { id: d.id, index: d.index, x, y });
            } else {
                cmd('removeWaypoint', { id: d.id, index: d.index });
                if (state.localRoute) state.localRoute.route.splice(d.index, 1);
            }
            // a következő pillanatképig a helyi útvonalat mutatjuk
            setTimeout(() => { if (!state.drag) state.localRoute = null; }, 350);
        } else if (d.type === 'seg' && !d.moved) {
            // egyszerű kattintás a szakaszon: útpont oda
            const [x, y] = toWorld(...canvasPos(e));
            cmd('addWaypoint', { id: d.id, x, y, index: d.index });
        }
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const [sx, sy] = canvasPos(e);
        const before = toWorld(sx, sy);
        state.view.zoom = Math.max(0.6, Math.min(8, state.view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const after = toWorld(sx, sy);
        state.view.panX += after[0] - before[0];
        state.view.panY += after[1] - before[1];
    }, { passive: false });

    canvas.addEventListener('mousemove', (e) => {
        if (state.drag) return;
        const [sx, sy] = canvasPos(e);
        const sel = state.selected != null ? state.acById.get(state.selected) : null;
        let cursor = sel ? 'crosshair' : 'default';
        if (aircraftAt(sx, sy).length) cursor = 'pointer';
        else if (sel && (waypointAt(sel, sx, sy) >= 0 || segmentAt(sel, sx, sy) >= 0)) cursor = 'move';
        canvas.style.cursor = cursor;
    });

    // ---------- billentyűzet ----------
    function cycleList(kind, backwards) {
        if (!state.snap) return;
        let list;
        if (kind === 'dep') list = state.snap.aircraft.filter((a) => a.st === 'ground');
        else {
            list = state.snap.aircraft.filter((a) => a.st !== 'ground' && a.st !== 'rollout')
                .sort((a, b) => (state.firstAirspaceSeen.get(b.id) || 0) - (state.firstAirspaceSeen.get(a.id) || 0));
        }
        if (!list.length) return;
        const cur = list.findIndex((a) => a.id === state.selected);
        let idx;
        if (cur < 0) idx = 0;
        else idx = (cur + (backwards ? -1 : 1) + list.length) % list.length;
        select(list[idx].id);
    }

    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        if (!$('lobby').hidden) return;
        const sel = state.selected != null ? state.acById.get(state.selected) : null;
        const key = e.key.toLowerCase();
        if (key === ' ') {
            e.preventDefault();
            if (isHost()) send({ t: 'pause' });
            return;
        }
        if (key === 'tab') {
            e.preventDefault();
            cycleList('dep', e.shiftKey);
            return;
        }
        if (key === 'n') { cycleList('air', e.shiftKey); return; }
        if (key === 'h') { $('app').classList.toggle('hide-top'); setTimeout(resize, 0); return; }
        if (key === 'escape') { select(null); $('help').hidden = true; return; }
        if (key === '?') { $('help').hidden = !$('help').hidden; return; }
        if (!sel) return;
        if (/^[1-9]$/.test(key)) {
            const i = Number(key) - 1;
            if (state.info && i < state.info.runways.length) cmd('runway', { id: sel.id, runway: i });
            return;
        }
        if (key === 'x') cmd('takeoff', { id: sel.id });
        else if (key === 'r') cmd('hold', { id: sel.id });
        else if (key === 'g') cmd('goAround', { id: sel.id });
        else if (key === 'w') cmd('speed', e.shiftKey ? { id: sel.id, to: 'max' } : { id: sel.id, delta: 10 });
        else if (key === 's') cmd('speed', e.shiftKey ? { id: sel.id, to: 'min' } : { id: sel.id, delta: -10 });
        else if (key === 'c' || key === 'arrowup') {
            e.preventDefault();
            cmd('altitude', e.shiftKey ? { id: sel.id, to: 'max' } : { id: sel.id, delta: 1000 });
        } else if (key === 'd' || key === 'arrowdown') {
            e.preventDefault();
            cmd('altitude', e.shiftKey ? { id: sel.id, to: 'min' } : { id: sel.id, delta: -1000 });
        }
    });

    // ---------- oldalsáv gombjai ----------
    function bindSidebar() {
        const onRowClick = (e) => {
            const row = e.target.closest('.ac-row');
            if (row) select(Number(row.dataset.id));
        };
        $('dep-list').onclick = onRowClick;
        $('air-list').onclick = onRowClick;
        $('sel-card').onclick = (e) => {
            const b = e.target.closest('button[data-act]');
            if (!b || state.selected == null) return;
            const id = state.selected;
            const act = b.dataset.act;
            if (act === 'runway') cmd('runway', { id, runway: Number(b.dataset.rw) });
            else if (act === 'takeoff') cmd('takeoff', { id });
            else if (act === 'hold') cmd('hold', { id });
            else if (act === 'goaround') cmd('goAround', { id });
            else if (act === 'alt') cmd('altitude', { id, delta: Number(b.dataset.d) });
            else if (act === 'spd') cmd('speed', { id, delta: Number(b.dataset.d) });
            else if (act === 'clearroute') {
                const a = state.acById.get(id);
                if (a) for (let i = a.r.length - 1; i >= 0; i--) cmd('removeWaypoint', { id, index: i });
            }
        };
        for (const b of document.querySelectorAll('#speed-seg button')) {
            b.onclick = () => send({ t: 'speed', value: Number(b.dataset.speed) });
        }
        $('btn-pause').onclick = () => send({ t: 'pause' });
        $('btn-end').onclick = () => {
            if (confirm('Biztosan befejezed a műszakot?')) send({ t: 'end' });
        };
        $('btn-help').onclick = () => { $('help').hidden = false; };
        $('help-close').onclick = () => { $('help').hidden = true; };
        $('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
        $('btn-again').onclick = () => send({ t: 'restart' });
        $('btn-sum-close').onclick = () => { $('summary').hidden = true; };
        $('log-toggle').onclick = () => {
            const h = $('log-history');
            h.hidden = !h.hidden;
            $('log-toggle').textContent = h.hidden ? 'Korábbiak ▾' : 'Bezár ▴';
            if (!h.hidden) renderLogHistory();
        };
    }

    // ---------- indulás ----------
    async function main() {
        resize();
        window.addEventListener('resize', resize);
        bindLobby();
        bindSidebar();
        requestAnimationFrame(frame);
        await Promise.all([loadAirports(), connect()]);
        renderLobby();
        window.__legterDebug = state;
    }

    main();
}());
