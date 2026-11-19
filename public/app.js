/* Légtér – böngészős kliens: megjelenítés, egér és billentyűzet, lobby. */
(function () {
    'use strict';

    const Rules = window.LegterRules;
    const $ = (id) => document.getElementById(id);
    const KIND_LABEL = { arr: 'ÉRK', dep: 'IND', transit: 'ÁTR', mil: 'VAD' };
    const KIND_NAME = { arr: 'Érkező', dep: 'Induló', transit: 'Átrepülő', mil: 'Katonai' };
    const COLORS = {
        arr: '#ff6f7d', dep: '#5fa8ff', transit: '#f5c451', em: '#c58cff', bad: '#ff4d5e', mil: '#7bd88f', hj: '#ff9f1c', vip: '#ffd84d', pc: '#f5c451',
        grid: 'rgba(120,150,190,0.08)', border: 'rgba(79,209,197,0.35)',
        text: '#c9d4e3', muted: '#6f7f96', accent: '#4fd1c5'
    };
    const AIRPORT_DESC = {
        LHBP: 'Ferihegy: két párhuzamos kifutó Budapest délkeleti szélén, a Duna és a város közelében.',
        LOWW: 'Két egymást keresztező kifutó a Duna mellett, Bécs keleti szélén.',
        EGLL: 'Két hosszú párhuzamos kifutó, nyugat felől sűrű forgalommal.',
        EDDF: 'Három párhuzamos kifutó és egy csak felszállásra használt északi–déli pálya.',
        LKPR: 'Két keresztező kifutó Prága nyugati dombjain.',
        KSFO: 'Négy, kettesével keresztező kifutó az öböl partján.',
        KJFK: 'Két párhuzamos pár a Jamaica-öböl szélén, a tenger fölött érkezőkkel.',
        KORD: 'Nyolc kifutó, többnyire párhuzamosan: a legnagyobb kihívás.',
        KATL: 'Öt párhuzamos kifutó, a világ egyik legforgalmasabb repülőtere.'
    };

    // ---------- állapot ----------
    const state = {
        ws: null,
        me: null,
        room: null,
        info: null,          // statikus reptéradat
        snap: null,          // legutóbbi pillanatkép
        snapAt: 0,           // mikor érkezett (performance.now)
        acById: new Map(),
        disp: new Map(),     // simított megjelenítési helyzet gépenként
        trails: new Map(),
        lastTrailT: 0,
        selected: null,
        drag: null,
        localRoute: null,    // húzás közbeni helyi útvonal
        map: null,           // háttértérkép
        view: { zoom: 1, panX: 0, panY: 0 },
        logs: [],
        firstAirspaceSeen: new Map(),
        draft: null,         // a lobbiban szerkesztett műszak-beállítás (gazda)
        pings: [],           // térképjelölések
        flash: null,         // gyorsüzenethez kötött gép kiemelése
        mouse: null          // utolsó egérpozíció (P billentyű)
    };
    let soloPending = false;

    // ---------- hálózat ----------
    // ---------- kapcsolat és visszacsatlakozás ----------
    const SESSION_KEY = 'legter-session';
    let leaving = false;
    let retry = { attempt: 0, timer: null, since: 0 };

    function loadSession() {
        try {
            const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
            return s && Date.now() - s.at < 30 * 60 * 1000 ? s : null;
        } catch (e) {
            return null;
        }
    }
    function saveSession(code, token) {
        try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token, at: Date.now() })); } catch (e) { /* nem baj */ }
    }
    function clearSession() {
        try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* nem baj */ }
    }

    function connect() {
        const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
        const ws = new WebSocket(url);
        state.ws = ws;
        ws.onmessage = (e) => onMessage(JSON.parse(e.data));
        ws.onclose = () => {
            if (state.ws !== ws || leaving) return;
            scheduleReconnect();
        };
        return new Promise((resolve) => {
            ws.onopen = () => {
                retry = { attempt: 0, timer: null, since: 0 };
                $('reconnect').hidden = true;
                resolve();
            };
        });
    }

    // megszakadt kapcsolatnál egyre ritkábban próbálkozunk, legfeljebb 2 percig
    function scheduleReconnect() {
        if (!retry.since) retry.since = Date.now();
        if (Date.now() - retry.since > 120000) {
            $('reconnect').hidden = true;
            $('disconnected').hidden = false;
            return;
        }
        $('reconnect').hidden = false;
        const delay = Math.min(8000, 1000 * Math.pow(1.6, retry.attempt++));
        clearTimeout(retry.timer);
        retry.timer = setTimeout(async () => {
            await connect();
            const sess = loadSession();
            if (sess) send({ t: 'resume', code: sess.code, token: sess.token });
        }, delay);
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
                if (m.token) saveSession(m.room.code, m.token);
                if (m.resumed) addLog('good', 'Visszacsatlakoztál a szobához.');
                if (m.room && m.room.code) {
                    try { history.replaceState(null, '', `?room=${m.room.code}`); } catch (e) { /* nem baj */ }
                }
                if (soloPending) {
                    soloPending = false;
                }
                renderLobby();
                break;
            case 'room':
                state.room = m.room;
                if (!m.room.started) state.info = null;
                renderLobby();
                renderPlayers();
                renderTopbar();
                break;
            case 'static':
                state.info = m.info;
                state.snap = null;
                state.disp.clear();
                state.trails.clear();
                state.selected = null;
                state.view = { zoom: 1, panX: 0, panY: 0 };
                $('summary').hidden = true;
                renderLobby();
                $('wind').textContent = `SZÉL ${String(m.info.windFrom).padStart(3, '0')}°`;
                $('st-mult').textContent = `×${m.info.multiplier.toFixed(2)}`;
                loadMap(m.info.icao);
                break;
            case 'state':
                onState(m.s);
                for (const ev of m.ev) {
                    addLog(ev.kind, ev.text, ev.t);
                    notify(ev);
                }
                checkConflicts();
                checkDepartures();
                checkReview();
                renderPerks();
                checkOwnership();
                renderQuick();
                break;
            case 'log':
                addLog(m.kind, m.text, null, m.by, m.color);
                break;
            case 'cmdResult':
                if (!m.ok && m.text) addLog('warn', m.text);
                break;
            case 'handoffReq':
                showHandoffRequest(m);
                break;
            case 'queued':
                $('queued').textContent = m.count ? `${m.count} parancs vár a folytatásra` : '';
                break;
            case 'resumeFailed':
                clearSession();
                state.room = null;
                state.info = null;
                $('lobby-error').textContent = m.text;
                renderLobby();
                break;
            case 'ping':
                state.pings.push({ x: m.x, y: m.y, color: m.color, by: m.by, at: performance.now() });
                if (m.pid !== state.me) Sound.play('ping');
                break;
            case 'chat':
                showChat(m);
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
        state.snapAt = performance.now();
        state.acById.clear();
        for (const a of s.aircraft) {
            state.acById.set(a.id, a);
            if (!state.firstAirspaceSeen.has(a.id) && a.st !== 'ground') state.firstAirspaceSeen.set(a.id, s.t);
        }
        for (const id of state.disp.keys()) if (!state.acById.has(id)) state.disp.delete(id);
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
    const rules = () => (state.info ? state.info.shift.rules : Rules.defaultShift().rules);
    const fmtTime = (sec) => {
        const s = Math.max(0, Math.floor(sec));
        const h = Math.floor(s / 3600);
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rwState = (idx) => (state.snap && state.snap.runways[idx]) || { e: 0, w: 0, c: 0 };
    const runwayLabel = (idx) => {
        if (!state.info || idx == null) return '–';
        const rw = state.info.runways[idx];
        return rw ? rw.names[rwState(idx).e] : '–';
    };
    const fl = (alt) => String(Math.round(alt / 100)).padStart(3, '0');
    const acColor = (a) => (a.hj ? COLORS.hj : a.vp ? COLORS.vip : a.em != null ? COLORS.em : COLORS[a.k]);
    const acBadge = (a) => (a.hj ? 'ELTÉR' : a.vp ? 'VIP' : a.pr ? 'KÉNYSZ' : a.em != null ? 'VÉSZ' : KIND_LABEL[a.k]);
    const hasPerk = (k) => !!(state.snap && state.snap.perks && state.snap.perks.includes(k));
    const roleSet = () => (state.room ? Rules.ROLE_SETS[Rules.MODES[state.room.settings.mode].roles] : null);
    const multiAirport = () => state.info && state.info.airports && state.info.airports.length > 1;
    const apCode = (i) => (state.info && state.info.airports[i] ? state.info.airports[i].icao : '');

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

    // ---------- hangok és értesítések ----------
    const Sound = window.LegterSound;
    const alerts = { conflictIds: new Set(), lastConflictBeep: 0, lastDepReminder: performance.now(), depCount: 0, toastTimer: null };

    // csak azokról a gépekről szólunk, amelyeket a játékos irányíthat
    function relevant(ev) {
        if (['good', 'incident', 'warn', 'hijack', 'hurricane', 'vip', 'review'].includes(ev.sound)) return true;
        if (ev.sound === 'depReady') return canControl({ k: 'dep', st: 'ground', x: 0, y: 0 });
        const a = ev.aircraftId != null ? state.acById.get(ev.aircraftId) : null;
        return !a || canControl(a);
    }

    function showToast(html, cls, aircraftId) {
        const t = $('toast');
        t.className = cls || '';
        t.innerHTML = html;
        t.hidden = false;
        t.onclick = () => { if (aircraftId != null && state.acById.has(aircraftId)) select(aircraftId); t.hidden = true; };
        clearTimeout(alerts.toastTimer);
        alerts.toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
    }

    function notify(ev) {
        if (!ev.sound || !relevant(ev)) return;
        Sound.play(ev.sound);
        if (ev.sound === 'depReady') {
            const a = state.acById.get(ev.aircraftId);
            showToast(`<b>${a ? a.cs : ''}</b> felszállásra kész – kattints ide, vagy <kbd>Tab</kbd> + <kbd>X</kbd>`, '', ev.aircraftId);
            const panel = $('dep-list').closest('.list-panel');
            panel.classList.remove('flash');
            void panel.offsetWidth;
            panel.classList.add('flash');
            alerts.lastDepReminder = performance.now();
        } else if (ev.sound === 'emergency') {
            const a = state.acById.get(ev.aircraftId);
            showToast(a && a.pr ? `<b>${a.cs}</b> KÉNYSZERLESZÁLLÁS – amíg le nem száll, senki más nem szállhat le`
                : `<b>${a ? a.cs : ''}</b> VÉSZHELYZET – 6 percen belül le kell szállnia`, 'em', ev.aircraftId);
        } else if (ev.sound === 'hijack') {
            const a = state.acById.get(ev.aircraftId);
            showToast(`<b>${a ? a.cs : ''}</b> ELTÉRÍTÉS! Koppints ide, vagy nyomd meg az <kbd>F</kbd>-et a vadászgépek indításához.`, 'hj', ev.aircraftId);
            $('toast').onclick = () => {
                if (a) {
                    cmd('scramble', { id: a.id });
                    select(a.id);
                }
                $('toast').hidden = true;
            };
        } else if (ev.sound === 'vip') {
            const a = state.acById.get(ev.aircraftId);
            showToast(`<b>${a ? a.cs : 'VIP'}</b> államfői gép érkezik! Tartsd tisztán a kifutókat, és indítsd a Gripeneket – koppints ide vagy <kbd>F</kbd>.`, 'vip', ev.aircraftId);
            $('toast').onclick = () => {
                if (a) {
                    cmd('scramble', { id: a.id });
                    select(a.id);
                }
                $('toast').hidden = true;
            };
        } else if (ev.sound === 'hurricane') {
            showToast('<b>HURRIKÁN!</b> Tartsd távol a gépeket a piros magjától.', 'em', null);
        }
    }

    // értékelés: 3 fejlesztésből lehet választani (multiban bárki választhat a csapatnak)
    let lastReviewKey = '';
    function checkReview() {
        const rv = state.snap && state.snap.review;
        const box = $('review');
        const key = rv ? rv.options.join(',') : '';
        if (key === lastReviewKey) return;
        lastReviewKey = key;
        if (!rv) {
            box.hidden = true;
            return;
        }
        $('review-cards').innerHTML = rv.options.map((k) => `<button class="perk-card" data-perk="${k}">
            <b>${esc(Rules.PERKS[k].label)}</b><span>${esc(Rules.PERKS[k].desc)}</span></button>`).join('');
        box.hidden = false;
    }

    function renderPerks() {
        const s = state.snap;
        if (!s) return;
        const chips = (s.perks || []).map((k) => `<span class="perk-chip" title="${esc(Rules.PERKS[k].desc)}">${esc(Rules.PERKS[k].label)}</span>`).join('');
        const next = s.nextReview ? `<span class="hint">Következő értékelés: ${s.nextReview.moves} gép vagy ${fmtTime(s.nextReview.seconds)}</span>` : '';
        const html = `${chips}${next}`;
        if ($('perks-list').innerHTML !== html) $('perks-list').innerHTML = html;
    }

    const QUICK = ['Vedd át!', 'Tartsd vissza az indulókat!', 'Segítség kell!', 'Figyelj, időjárás jön!', 'Rendben!', 'Köszi!'];
    function renderQuick() {
        const r = state.room;
        const show = r && r.started && r.players.length > 1;
        $('quick-msgs').hidden = !show;
        if (show && !$('quick-msgs').dataset.ready) {
            $('quick-msgs').dataset.ready = '1';
            $('quick-msgs').innerHTML = '<div class="tb-label">Gyorsüzenet (a kijelölt géphez kötve)</div><div class="quick-grid">'
                + QUICK.map((q, i) => `<button class="btn quick-btn" data-q="${i}">${esc(q)}</button>`).join('') + '</div>';
        }
    }

    let chatTimer = null;
    function showChat(m) {
        addLog('chat', m.text, null, m.by, m.color);
        const pop = $('chat-pop');
        pop.innerHTML = `<b style="color:${m.color}">${esc(m.by)}:</b> ${esc(m.text)}`;
        pop.style.borderColor = m.color;
        pop.hidden = false;
        pop.onclick = () => {
            if (m.id != null && state.acById.has(m.id)) select(m.id);
            pop.hidden = true;
        };
        if (m.id != null) state.flash = { id: m.id, color: m.color, until: performance.now() + 5000 };
        if (m.pid !== state.me) Sound.play('chat');
        clearTimeout(chatTimer);
        chatTimer = setTimeout(() => { pop.hidden = true; }, 5000);
    }

    // „I”: az eddigi eredmény a műszak befejezése nélkül
    function showStatsSoFar() {
        if (!state.snap) return;
        const s = state.snap.stats;
        $('sum-title').textContent = `Eddig: ${fmtTime(state.snap.t)} · ${s.score} pont`;
        $('sum-body').innerHTML = `<p class="hint">A műszak tovább megy – ez csak egy pillantás az eddigi eredményre.</p><div class="sum-stats">
            <div><b class="arr-c">${s.landed}</b>leszállt</div><div><b class="dep-c">${s.departed}</b>felszállt</div>
            <div><b class="tr-c">${s.transited}</b>átrepült</div><div><b class="bad-c">${s.incidents}</b>incidens</div></div>
            <p class="hint">Alappont: ${s.base} · szorzó: ×${(state.info.multiplier || 1).toFixed(2)}</p>`;
        $('btn-sum-close').textContent = 'Vissza a játékhoz';
        $('summary').hidden = false;
    }

    function showHandoffRequest(m) {
        const box = $('handoff-req');
        $('handoff-text').innerHTML = m.give
            ? `<b style="color:${m.color}">${esc(m.from)}</b> át szeretné adni neked: <b>${esc(m.cs)}</b>`
            : `<b style="color:${m.color}">${esc(m.from)}</b> átvenné tőled: <b>${esc(m.cs)}</b>`;
        box.hidden = false;
        Sound.play('handoff');
        const close = (accept) => {
            send({ t: 'handoffReply', reqId: m.reqId, accept });
            box.hidden = true;
            clearTimeout(alerts.handoffTimer);
        };
        $('handoff-yes').onclick = () => close(true);
        $('handoff-no').onclick = () => close(false);
        clearTimeout(alerts.handoffTimer);
        alerts.handoffTimer = setTimeout(() => { box.hidden = true; }, 25000);
    }

    // automatikus átadásnál (pl. torony-zóna) szól, ha egy gép hozzád került
    const ownership = new Map();
    function checkOwnership() {
        if (!state.snap || !state.room || state.room.players.length < 2 || state.room.settings.mode === 'free') return;
        let gained = null;
        for (const a of state.snap.aircraft) {
            if (a.k === 'mil') continue;
            const mine = canControl(a);
            const before = ownership.get(a.id);
            if (before === false && mine) gained = a;
            ownership.set(a.id, mine);
        }
        for (const id of ownership.keys()) if (!state.acById.has(id)) ownership.delete(id);
        if (gained) {
            Sound.play('handoff');
            addLog('info', `${gained.cs} átkerült hozzád.`);
        }
    }

    function checkConflicts() {
        if (!state.snap) return;
        // szünetben nem sípol (a konfliktus ilyenkor „befagy”, és folyamatosan szólna)
        if (state.room && state.room.paused) {
            alerts.conflictIds = new Set(state.snap.aircraft.filter((a) => a.cf && canControl(a)).map((a) => a.id));
            return;
        }
        const now = performance.now();
        const ids = new Set(state.snap.aircraft.filter((a) => a.cf && canControl(a)).map((a) => a.id));
        let fresh = false;
        for (const id of ids) if (!alerts.conflictIds.has(id)) fresh = true;
        alerts.conflictIds = ids;
        // új konfliktusnál azonnal, tartós konfliktusnál 2,5 mp-enként sípol
        if (ids.size && (fresh || now - alerts.lastConflictBeep > 2500)) {
            alerts.lastConflictBeep = now;
            Sound.play('conflict');
        }
    }

    function checkDepartures() {
        if (!state.snap) return;
        const deps = state.snap.aircraft.filter((a) => a.st === 'ground' && canControl(a));
        const panel = $('dep-list').closest('.list-panel');
        panel.classList.toggle('waiting', deps.length > 0);
        document.title = deps.length ? `(${deps.length}) Légtér – induló vár` : 'Légtér – többjátékos légiirányítás';
        const now = performance.now();
        // ha valaki régóta vár, 40 mp-enként emlékeztet
        const oldest = deps.reduce((m, a) => Math.min(m, a.gf), Infinity);
        if (deps.length && oldest < 240 && now - alerts.lastDepReminder > 40000 && !(state.room && state.room.paused)) {
            alerts.lastDepReminder = now;
            Sound.play('depReminder');
            const a = deps.find((d) => d.gf === oldest);
            showToast(`<b>${deps.length}</b> induló vár a felszállásra – a legrégebbi: <b>${a.cs}</b> (${a.gf}s)`, '', a.id);
        }
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
            const st = state.snap.stats;
            $('tb-clock').textContent = fmtTime(state.snap.t);
            $('st-score').textContent = st.score;
            $('st-landed').textContent = st.landed;
            $('st-departed').textContent = st.departed;
            $('st-transited').textContent = st.transited;
            $('st-incidents').textContent = st.incidents;
        }
        if (r) {
            for (const b of document.querySelectorAll('#speed-seg button')) {
                b.classList.toggle('on', Number(b.dataset.speed) === r.speed);
                b.disabled = !isHost();
            }
            const narrow = window.innerWidth < 760;
            $('btn-pause').textContent = r.paused ? (narrow ? '▶' : '▶ Folytatás') : (narrow ? 'Ⅱ' : 'Ⅱ Szünet');
            $('btn-pause').disabled = !isHost() || !r.started;
            $('btn-end').disabled = !isHost() || !r.started;
            $('btn-end-mobile').disabled = !isHost() || !r.started;
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
            right = `<div class="timer ${a.gf < 60 ? 'low' : ''}">${a.q ? 'SORBAN · ' : ''}FÖLD ${a.gf}s</div>`;
        } else if (a.sq) {
            right = `<div class="timer">#${a.sq} · ${fmtTime(a.eta)}</div>`;
        } else if (a.fg) {
            right = '<div class="timer">KÖDBEN</div>';
        } else if (a.em != null) {
            right = `<div class="timer low">VÉSZ ${fmtTime(a.em)}</div>`;
        } else {
            right = `<div class="timer ${a.f < 90 ? 'low' : ''}">${a.st === 'final' ? 'VÉGSŐ' : a.st === 'rollout' ? 'GURUL' : `${a.f}s`}</div>`;
        }
        const apPrefix = multiAirport() && a.k !== 'mil' ? `${apCode(a.ap)} · ` : '';
        if (a.k === 'mil') return `<div class="ac-row k-mil" data-id="${a.id}"><span class="badge" style="color:${COLORS.mil}">VAD</span>
            <div><div class="cs">${a.cs}</div><div class="meta">vadászgép · önálló</div></div><div class="timer"></div></div>`;
        const target = apPrefix + (a.k === 'arr' ? (a.rw != null ? `RWY ${runwayLabel(a.rw)}` : 'nincs kifutó')
            : `<span class="gate-chip">${a.eg}</span>${a.k === 'dep' ? `RWY ${runwayLabel(a.rw)}` : `${a.ig} → ${a.eg}`}${a.xa ? ` · ${a.xa / 100}` : ''}`);
        return `<div class="ac-row k-${a.em != null ? 'em' : a.k} ${state.selected === a.id ? 'sel' : ''} ${locked ? 'locked' : ''}" data-id="${a.id}">
            <span class="badge" style="color:${acColor(a)}">${acBadge(a)}</span>
            <div><div class="cs">${a.cs}</div><div class="meta">${cls} · ${target}</div></div>
            ${right}</div>`;
    }

    // ---------- kijelölt gép ----------
    function renderSelected() {
        const card = $('sel-card');
        const focused = document.activeElement;
        if (focused && card.contains(focused) && (focused.tagName === 'INPUT' || focused.tagName === 'SELECT')) return;
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
        const alt = rules().altitude;
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
        else status = `Kijárat: ${a.eg} kapu${a.xa ? `, ${a.xa / 100}-es szinten` : ''}`;
        if (a.hd) status += ' · körözik';

        const rwButtons = state.info.runways.map((rw, i) => {
            const rs = rwState(i);
            const closed = rs.c > 0;
            return `<button class="btn rw-btn ${a.rw === i ? 'active' : ''}" data-act="runway" data-rw="${i}" ${closed ? 'disabled title="Lezárva"' : ''}>${runwayLabel(i)}${closed ? ' ✕' : ''}<kbd>${i + 1}</kbd></button>`;
        }).join('');
        const altButtons = alt ? `<button class="btn" data-act="alt" data-d="-1000">▼ 1000<kbd>D</kbd></button>
                    <button class="btn" data-act="alt" data-d="1000">▲ 1000<kbd>C</kbd></button>` : '';
        let actions = '';
        if (a.st === 'ground') {
            const tlabel = a.q ? 'Kivétel a sorból' : hasPerk('takeoffQueue') ? 'Felszállás / sorba' : 'Felszállás';
            actions = `<div class="btn-row">${rwButtons}</div><div class="btn-row"><button class="btn primary" data-act="takeoff">${tlabel}<kbd>X</kbd></button>
                ${a.q ? '<span class="hint">Sorban áll: magától felszáll, amint a kifutó szabad.</span>' : ''}</div>`;
        } else if (a.st === 'takeoff') {
            actions = alt ? `<div class="btn-row">${altButtons}</div>` : '';
        } else if (a.st === 'airborne' || a.st === 'final') {
            actions = `${a.k === 'arr' ? `<div class="btn-row">${rwButtons}</div>` : ''}
                <div class="btn-row">
                    ${altButtons}
                    <button class="btn" data-act="spd" data-d="-10">− 10 kt<kbd>S</kbd></button>
                    <button class="btn" data-act="spd" data-d="10">+ 10 kt<kbd>W</kbd></button>
                </div>
                ${hasPerk('exactSpeed') && a.st === 'airborne' ? `<div class="btn-row"><input id="exact-speed" type="number" class="num-input" min="${Math.round(a.ts * 0.6)}" max="${a.ts * 2}" value="${a.ts}" step="5"><button class="btn" data-act="exactspd">Sebesség beállítása</button></div>` : ''}
                ${hasPerk('flexExit') && a.st === 'airborne' && (a.k === 'dep' || a.k === 'transit') ? `<div class="btn-row"><span class="hint">Kijárat${state.snap.flexIn ? ` (${state.snap.flexIn} mp múlva)` : ''}:</span>${state.info.gates.map((g) => `<button class="btn gate-btn ${g.letter === a.eg ? 'active' : ''}" data-act="exit" data-gate="${g.letter}" ${state.snap.flexIn ? 'disabled' : ''}>${g.letter}</button>`).join('')}</div>` : ''}
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
        // átadás / átvétel (csak megosztott irányítású multiban)
        const room = state.room;
        const shared = room && room.players.length > 1 && room.settings.mode !== 'free' && a.k !== 'mil' && !a.hj;
        if (shared) {
            if (!locked) {
                const others = room.players.filter((p) => p.id !== state.me);
                ownerNote += `<div class="btn-row handoff-row"><span class="hint">Átadás:</span>
                    <select id="handoff-to">${others.map((p) => `<option value="${p.id}" ${state.handoffTo === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
                    <button class="btn" data-act="handoff">Átadom neki</button></div>`;
            } else {
                ownerNote += '<div class="btn-row handoff-row"><button class="btn" data-act="handoff">Átvétel kérése</button></div>';
            }
        }
        let emBanner = a.em != null ? `<div class="em-banner">${a.pr ? 'KÉNYSZERLESZÁLLÁS' : 'VÉSZHELYZET'} – még ${fmtTime(a.em)} a leszállásig${a.pr ? '. Amíg le nem száll, a repterén senki más nem szállhat le.' : ''}</div>` : '';
        if (a.hj) {
            emBanner += `<div class="storm-banner">ELTÉRÍTETT GÉP – nem válaszol, ${esc(apCode(a.ap) || 'a reptér')} felé tart.
                ${a.sc ? 'A vadászgépek úton vannak.' : '<br><button class="btn danger" data-act="scramble">Vadászgépek indítása<kbd>F</kbd></button>'}</div>`;
        }
        if (a.vp) {
            emBanner += `<div class="vip-banner">VIP (államfői) GÉP – amíg le nem száll, ${esc(apCode(a.ap) || 'a reptér')} kifutói zárva, és senki nem repülhet a közelébe.
                ${a.sc ? 'A Gripenek kísérik.' : a.ed != null ? `<br><button class="btn vip" data-act="scramble">Gripenek indítása (${a.ed} mp)<kbd>F</kbd></button>` : ' Kíséret nélkül érkezett.'}</div>`;
        }
        if (a.sq) emBanner += `<div class="seq-banner">Leszállási sorrend: #${a.sq} · földet ér ${fmtTime(a.eta)} múlva${a.gp != null ? ` · ${a.gp} mp az előző mögött` : ''}</div>`;
        if (a.fg) emBanner += '<div class="fog-banner">KÖDBEN – a pilóta nem tudja, hol jár. Egyenesen repül tovább, és amíg ki nem ér, nem irányítható.</div>';
        if (a.sw) emBanner += '<div class="storm-banner">ZIVATAR! A gép a piros mag felé tart – fordítsd el, különben vége a műszaknak.</div>';
        card.innerHTML = `
            ${emBanner}
            <div class="sel-head"><span class="cs" style="color:${acColor(a)}">${a.cs}</span><span class="badge" style="color:${acColor(a)}">${acBadge(a)}</span></div>
            <div class="sel-sub">${KIND_NAME[a.k]} · ${c.label}${multiAirport() && a.k !== 'mil' ? ` · reptér: <b>${esc(apCode(a.ap))}</b>` : ''}</div>
            <div class="sel-grid">
                <div><div class="tb-label">Állapot</div><div style="font-size:13px">${status}</div></div>
                <div><div class="tb-label">${a.st === 'ground' ? 'Földi idő' : 'Üzemanyag (hátralévő idő)'}</div><div class="v">${fuel} mp · ${fmtTime(fuel)}</div>
                    <div class="fuel-bar"><i class="${pct < 20 ? 'low' : ''}" style="width:${pct}%"></i></div></div>
                ${alt ? `<div><div class="tb-label">Magasság</div><div class="v">${fl(a.al)}${a.ta !== a.al ? ` → ${fl(a.ta)}` : ''}</div></div>` : ''}
                <div><div class="tb-label">Sebesség</div><div class="v">${a.s}${a.ts !== a.s ? ` → ${a.ts}` : ''} kt</div></div>
            </div>
            ${locked || a.fg || a.hj || a.k === 'mil' ? '' : actions}
            ${ownerNote}`;
    }

    // ---------- játékosok ----------
    function playerRoleText(p) {
        const s = state.room.settings;
        const set = Rules.ROLE_SETS[Rules.MODES[s.mode].roles];
        if (set) return set[p.role] || '';
        if (s.mode === 'airports') return state.info && state.info.airports[p.airport] ? state.info.airports[p.airport].icao : '';
        if (s.mode === 'sector') return `${p.sector + 1}. szektor`;
        return '';
    }

    function renderPlayers() {
        if (!state.room) return;
        $('mode-label').textContent = Rules.MODES[state.room.settings.mode].label;
        $('players-list').innerHTML = state.room.players.map((p) => `
            <div class="player ${p.online === false ? 'offline' : ''}"><span class="dot" style="background:${p.color}"></span>${esc(p.name)}${p.online === false ? ' <span class="me">(nincs kapcsolat)</span>' : ''}
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
        $('rs-mode').innerHTML = Object.entries(Rules.MODES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    }

    function currentShift() {
        return state.room ? state.room.settings.shift : Rules.defaultShift();
    }

    function pushShift(shift) {
        send({ t: 'settings', settings: { shift } });
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
        const host = isHost();
        const shift = currentShift();
        $('room-code').textContent = r.code;

        // reptérkártyák
        $('airport-cards').innerHTML = airportsCache.map((a) => `
            <button class="ap-card ${r.settings.airport === a.icao ? 'on' : ''}" data-icao="${a.icao}" ${host ? '' : 'disabled'}>
                <span class="ap-code">${a.icao}</span>
                <span><div class="ap-name">${esc(a.name)}</div>
                <div class="ap-desc">${esc(AIRPORT_DESC[a.icao] || `${a.runways} kifutó`)}</div>
                ${!r.settings.solo && a.airports.length > 1 ? `<div class="ap-multi">Multiban: ${a.airports.slice(1, Math.min(3, r.settings.size)).map((x) => `+ ${esc(x.icao)} ${esc(x.name)}`).join(', ') || 'csak a fő reptér (1 fő)'}</div>` : ''}</span>
            </button>`).join('');

        // előbeállítások
        const preset = Rules.presetOf(shift.rules);
        $('preset-seg').innerHTML = Object.entries(Rules.PRESETS).map(([k, p]) => `<button data-preset="${k}" class="${preset === k ? 'on' : ''}" ${host ? '' : 'disabled'}>${p.label}</button>`).join('')
            + `<button class="${preset === 'custom' ? 'on' : ''}" disabled>Egyéni</button>`;
        $('preset-hint').textContent = preset === 'custom'
            ? 'Egyéni szabályok: bármelyik kapcsolót átállíthatod.'
            : 'A Klasszikus és a Nehéz előre beállított szabálycsomag. Bármelyik kapcsoló átállításával Egyéni lesz.';

        // szabályok
        $('rules-list').innerHTML = Rules.RULE_GROUPS.map((g) => `
            <div class="rule-group"><h3>${g.label}</h3>
            ${Rules.RULE_DEFS.filter((d) => d.group === g.key).map((d) => {
                const on = !!shift.rules[d.key];
                return `<label class="rule ${host ? '' : 'disabled'}">
                    <input type="checkbox" data-rule="${d.key}" ${on ? 'checked' : ''} ${host ? '' : 'disabled'}>
                    <span><div class="rt">${d.label}</div><div class="rd">${d.desc}</div></span>
                    <span class="rm"><span class="${on ? '' : 'on'}">ki ×${d.off.toFixed(2)}</span><span class="${on ? 'on' : ''}">be ×${d.on.toFixed(2)}</span></span>
                </label>`;
            }).join('')}</div>`).join('');

        $('traffic-seg').innerHTML = Object.entries(Rules.TRAFFIC_LEVELS).map(([lvl, m]) => `<button data-traffic="${lvl}" class="${Number(lvl) === shift.traffic ? 'on' : ''}" ${host ? '' : 'disabled'}>${lvl}%<small>×${m.toFixed(2)}</small></button>`).join('');
        $('practice-seg').innerHTML = Object.entries(Rules.PRACTICE).map(([k, v]) => `<button data-practice="${k}" class="${shift.practice === k ? 'on' : ''}" ${host ? '' : 'disabled'}>${v}</button>`).join('');
        $('opening-seg').innerHTML = Object.entries(Rules.OPENINGS).map(([k, v]) => `<button data-opening="${k}" class="${shift.opening === k ? 'on' : ''}" ${host ? '' : 'disabled'}>${v.label}</button>`).join('');
        $('opening-desc').textContent = Rules.OPENINGS[shift.opening].desc;

        const mult = Rules.scoreMultiplier(shift);
        $('mult-value').textContent = shift.practice === 'all' ? `×${mult.toFixed(2)}` : 'gyakorlás';
        const ap = airportsCache.find((a) => a.icao === r.settings.airport);
        $('mult-summary').textContent = `${ap ? ap.name : r.settings.airport} · ${Rules.PRESETS[preset] ? Rules.PRESETS[preset].label : 'Egyéni'} · ${shift.traffic}% forgalom`;

        // multi
        $('rs-mode').disabled = !host;
        $('rs-offset').disabled = !host;
        $('rs-mode').value = r.settings.mode;
        $('rs-offset').value = r.settings.sectorOffset;
        $('rs-offset-field').style.display = r.settings.mode === 'sector' ? '' : 'none';
        const mode = Rules.MODES[r.settings.mode];
        $('size-field').hidden = !!r.settings.solo;
        $('size-seg').innerHTML = Array.from({ length: mode.maxPlayers }, (_, i) => i + 1).map((n) => `<button data-size="${n}" class="${r.settings.size === n ? 'on' : ''}" ${host && n >= r.players.length ? '' : 'disabled'}>${n} fő${n > 1 ? `<small>${Math.min(n, 3)} reptér</small>` : '<small>1 reptér</small>'}</button>`).join('');
        let warn = '';
        if (r.players.length > mode.maxPlayers) warn = `Ebben a módban legfeljebb ${mode.maxPlayers} fő játszhat – válassz másik módot.`;
        else if (r.players.length > r.settings.size) warn = `Többen vagytok (${r.players.length}), mint a beállított létszám (${r.settings.size}).`;
        else if (Rules.roleProblems(r.settings.mode, r.players)) warn = `Posztok: ${Rules.roleProblems(r.settings.mode, r.players)}`;
        $('rs-mode-desc').innerHTML = `${esc(mode.desc)}${warn ? `<div class="mode-warn">⚠ ${esc(warn)}</div>` : ''}`;
        $('btn-start').disabled = !!warn;
        $('btn-start').hidden = !host;
        $('wait-host').hidden = host;
        const n = Rules.sectorCount(r.players);
        $('room-players').innerHTML = r.players.map((p) => {
            const editable = host || p.id === state.me;
            let sel = '';
            const set = Rules.ROLE_SETS[Rules.MODES[r.settings.mode].roles];
            if (set) {
                sel = `<select data-pid="${p.id}" data-field="role" ${editable ? '' : 'disabled'}>${Object.entries(set).map(([k, v]) => `<option value="${k}" ${p.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select>`;
            } else if (r.settings.mode === 'airports') {
                const ap = airportsCache.find((x) => x.icao === r.settings.airport);
                const list = ap ? ap.airports.slice(0, Math.min(3, r.settings.size)) : [];
                sel = `<select data-pid="${p.id}" data-field="airport" ${editable ? '' : 'disabled'}>${list.map((x, i) => `<option value="${i}" ${p.airport === i ? 'selected' : ''}>${x.icao} ${esc(x.name)}</option>`).join('')}</select>`;
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

    function bindLobby() {
        try { $('in-name').value = localStorage.getItem('legter-name') || ''; } catch (e) { /* nem baj */ }
        const params = new URLSearchParams(location.search);
        if (params.get('room')) $('in-code').value = params.get('room').toUpperCase();
        $('btn-solo').onclick = () => {
            soloPending = true;
            send({ t: 'create', name: getName(), settings: { mode: 'free', solo: true } });
        };
        $('btn-create').onclick = () => send({ t: 'create', name: getName(), settings: { mode: 'airports', size: 2 } });
        $('btn-join').onclick = () => {
            const code = $('in-code').value.trim().toUpperCase();
            if (code.length !== 4) {
                $('lobby-error').textContent = 'A szobakód 4 betű.';
                return;
            }
            send({ t: 'join', code, name: getName() });
        };
        $('in-code').onkeydown = (e) => { if (e.key === 'Enter') $('btn-join').click(); };
        $('btn-start').onclick = () => send({ t: 'start', aspect: radarAspect() });
        $('btn-leave').onclick = () => {
            leaving = true;
            send({ t: 'leave' });
            clearSession();
            setTimeout(() => { location.href = location.pathname; }, 150);
        };
        $('btn-copy').onclick = async () => {
            const link = `${location.origin}${location.pathname}?room=${state.room.code}`;
            try {
                await navigator.clipboard.writeText(link);
                $('btn-copy').textContent = 'Másolva ✓';
            } catch (e) {
                prompt('Másold ki a linket:', link);
            }
        };
        $('airport-cards').onclick = (e) => {
            const b = e.target.closest('[data-icao]');
            if (b && isHost()) send({ t: 'settings', settings: { airport: b.dataset.icao } });
        };
        $('preset-seg').onclick = (e) => {
            const b = e.target.closest('[data-preset]');
            if (!b || !isHost()) return;
            const shift = JSON.parse(JSON.stringify(currentShift()));
            shift.rules = Object.assign({}, Rules.PRESETS[b.dataset.preset].rules);
            pushShift(shift);
        };
        $('rules-list').onchange = (e) => {
            const key = e.target.dataset.rule;
            if (!key || !isHost()) return;
            const shift = JSON.parse(JSON.stringify(currentShift()));
            shift.rules[key] = e.target.checked;
            pushShift(shift);
        };
        const segHandler = (attr, field, conv) => (e) => {
            const b = e.target.closest(`[data-${attr}]`);
            if (!b || !isHost()) return;
            const shift = JSON.parse(JSON.stringify(currentShift()));
            shift[field] = conv(b.dataset[attr]);
            pushShift(shift);
        };
        $('traffic-seg').onclick = segHandler('traffic', 'traffic', Number);
        $('practice-seg').onclick = segHandler('practice', 'practice', String);
        $('opening-seg').onclick = segHandler('opening', 'opening', String);
        const pushMulti = () => send({
            t: 'settings',
            settings: { mode: $('rs-mode').value, sectorOffset: Number($('rs-offset').value) }
        });
        $('rs-mode').onchange = pushMulti;
        $('size-seg').onclick = (e) => {
            const b = e.target.closest('[data-size]');
            if (b && isHost()) send({ t: 'settings', settings: { size: Number(b.dataset.size) } });
        };
        $('rs-offset').onchange = pushMulti;
        $('room-players').onchange = (e) => {
            const s = e.target;
            if (!s.dataset.pid) return;
            const pid = Number(s.dataset.pid);
            const msg = { t: 'player', targetId: pid === state.me ? undefined : pid };
            if (s.dataset.field === 'role') msg.role = s.value;
            else if (s.dataset.field === 'airport') msg.airport = Number(s.value);
            else msg.sector = Number(s.value);
            send(msg);
        };
    }

    function showSummary(m) {
        const s = m.stats;
        $('btn-sum-close').textContent = 'Vissza a beállításokhoz';
        $('sum-title').textContent = m.gameOver ? `Vége a műszaknak · ${s.score} pont` : `${fmtTime(m.time)} műszak · ${s.score} pont`;
        $('sum-body').innerHTML = `${m.gameOver ? `<div class="storm-banner">⛈ ${esc(m.gameOver.reason)} (${fmtTime(m.time)} után)</div>` : ''}<div class="sum-stats">
            <div><b class="arr-c">${s.landed}</b>leszállt</div><div><b class="dep-c">${s.departed}</b>felszállt</div>
            <div><b class="tr-c">${s.transited}</b>átrepült</div><div><b class="bad-c">${s.incidents}</b>incidens</div></div>
            <p class="hint">Alappont: ${s.base} · szorzó: ×${(m.multiplier || 1).toFixed(2)}${s.emergencies ? ` · vészhelyzetből leszállt: ${s.emergencies}` : ''}</p>
            <div class="sum-inc">${m.incidents.length ? m.incidents.map((i) => `<div>${fmtTime(i.t)} · ${esc(i.callsign)} – ${esc(i.reason)}</div>`).join('') : 'Tiszta műszak, egyetlen incidens nélkül.'}</div>`;
        $('summary').hidden = false;
    }

    // ---------- radar: vetítés ----------
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

    const airspace = () => (state.info ? state.info.airspace : { hw: 24, hh: 14 });
    // a radar méretaránya (a légtér ehhez igazodik az induláskor)
    function radarAspect() {
        const r = $('scope-wrap').getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? Math.round((r.width / r.height) * 1000) / 1000 : undefined;
    }

    // a légtér pontosan kitölti a radart; ennél jobban nem lehet kicsinyíteni
    function scale() {
        const as = airspace();
        return Math.min(W / (2 * as.hw), H / (2 * as.hh)) * state.view.zoom;
    }

    // nagyítás után a nézet nem csúszhat ki a légtérből
    function clampView() {
        const as = airspace();
        state.view.zoom = Math.max(1, Math.min(8, state.view.zoom));
        const k = scale();
        const mx = Math.max(0, as.hw - W / (2 * k));
        const my = Math.max(0, as.hh - H / (2 * k));
        state.view.panX = Math.max(-mx, Math.min(mx, state.view.panX));
        state.view.panY = Math.max(-my, Math.min(my, state.view.panY));
    }
    function toScreen(x, y) {
        const k = scale();
        return [W / 2 + (x + state.view.panX) * k, H / 2 - (y + state.view.panY) * k];
    }
    function toWorld(sx, sy) {
        const k = scale();
        return [(sx - W / 2) / k - state.view.panX, -(sy - H / 2) / k - state.view.panY];
    }

    // ---------- simított mozgás ----------
    // A szerver 5×/s küld helyzetet. A két frissítés között a gépet a saját irányában és sebességével
    // továbbvisszük, a megjelenített helyzet pedig finoman követi ezt a becslést.
    let lastFrame = performance.now();
    function updateDisplay(now) {
        const dtFrame = Math.min(0.1, (now - lastFrame) / 1000);
        lastFrame = now;
        if (!state.snap || !state.info) return;
        const paused = state.room && state.room.paused;
        const speed = state.room ? state.room.speed : 1;
        const since = paused ? 0 : Math.min(0.6, (now - state.snapAt) / 1000) * speed;
        const nmPerKtS = state.info.timeScale / 3600;
        const follow = Math.min(1, dtFrame * 14);
        for (const a of state.snap.aircraft) {
            if (a.st === 'ground') continue;
            const d = a.s * nmPerKtS * since;
            const px = a.x + Math.sin(a.h * Math.PI / 180) * d;
            const py = a.y + Math.cos(a.h * Math.PI / 180) * d;
            let disp = state.disp.get(a.id);
            if (!disp || Math.hypot(disp.x - px, disp.y - py) > 2) {
                disp = { x: px, y: py, h: a.h };
                state.disp.set(a.id, disp);
                continue;
            }
            disp.x += (px - disp.x) * follow;
            disp.y += (py - disp.y) * follow;
            let dh = ((a.h - disp.h + 540) % 360) - 180;
            if (Math.abs(dh) > 90) dh = dh > 0 ? dh - 0 : dh;
            disp.h = (disp.h + dh * follow + 360) % 360;
        }
    }
    const posOf = (a) => state.disp.get(a.id) || { x: a.x, y: a.y, h: a.h };

    // a felszálló gép a kifutón végigmegy, a vége után 1 nm-t egyenesen emelkedik, csak utána fordul
    function departurePrefix(a) {
        if (a.k !== 'dep' || !(a.st === 'ground' || a.st === 'takeoff') || a.rw == null || !state.info) return null;
        const rw = state.info.runways[a.rw];
        const end = rwState(a.rw).e;
        const thr = rw.ends[end];
        const far = rw.ends[1 - end];
        const len = Math.hypot(far[0] - thr[0], far[1] - thr[1]) || 1;
        const climb = [far[0] + (far[0] - thr[0]) / len, far[1] + (far[1] - thr[1]) / len];
        if (a.st === 'ground') return [thr, far, climb];
        const p = posOf(a);
        return [[p.x, p.y], far, climb];
    }

    function routeFor(a) {
        if (state.localRoute && state.localRoute.id === a.id) return state.localRoute.route;
        return a.r;
    }

    function routeEnd(a) {
        if (!state.info) return [];
        if (a.k === 'arr' && a.rw != null) {
            const rw = state.info.runways[a.rw];
            const end = rwState(a.rw).e;
            const thr = rw.ends[end];
            const other = rw.ends[1 - end];
            const len = Math.hypot(other[0] - thr[0], other[1] - thr[1]);
            const ux = (thr[0] - other[0]) / len;
            const uy = (thr[1] - other[1]) / len;
            const faf = [thr[0] + ux * state.info.fafDistance, thr[1] + uy * state.info.fafDistance];
            if (a.st === 'final') return [thr];
            // a szerver által tervezett legrövidebb csatlakozás a tengelyre, majd a kifutó
            return a.aj && a.aj.length ? [...a.aj, thr] : [faf, thr];
        }
        if (a.eg && !(rules().manualRouting && !a.r.length && a.st !== 'ground')) {
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

    // a térkép a fő reptérhez van igazítva; multiban a légtér középpontja eltolódik
    function mapPt(p) {
        const off = (state.info && state.info.mapOffset) || [0, 0];
        return toScreen(p[0] - off[0], p[1] - off[1]);
    }

    function tracePoly(c, rings) {
        c.beginPath();
        for (const ring of rings) {
            ring.forEach((p, i) => {
                const [x, y] = mapPt(p);
                if (i) c.lineTo(x, y); else c.moveTo(x, y);
            });
            c.closePath();
        }
    }

    function renderBackground(c) {
        const m = state.map;
        const k = scale();
        const as = airspace();
        c.fillStyle = m && m.land.length ? MAP_COLORS.water : MAP_COLORS.land;
        c.fillRect(0, 0, W, H);
        if (m) {
            c.fillStyle = MAP_COLORS.land;
            for (const poly of m.land) { tracePoly(c, poly); c.fill('evenodd'); }
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
                r.p.forEach((p, i) => { const [x, y] = mapPt(p); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
                c.stroke();
            }
            for (const road of m.roads) {
                c.strokeStyle = road.m ? MAP_COLORS.roadMajor : MAP_COLORS.road;
                c.lineWidth = road.m ? 1.6 : 1;
                c.beginPath();
                road.p.forEach((p, i) => { const [x, y] = mapPt(p); if (i) c.lineTo(x, y); else c.moveTo(x, y); });
                c.stroke();
            }
            c.font = '600 11px ui-monospace, monospace';
            c.textAlign = 'center';
            c.fillStyle = MAP_COLORS.place;
            const off = (state.info && state.info.mapOffset) || [0, 0];
            for (const pl of m.places) {
                if (Math.abs(pl.x - off[0]) > as.hw - 2 || Math.abs(pl.y - off[1]) > as.hh - 1.5) continue;
                const [x, y] = mapPt([pl.x, pl.y]);
                c.fillRect(x - 1.5, y - 1.5, 3, 3);
                c.fillText(pl.n.toUpperCase(), x, y - 6);
            }
        }
        // finom rács
        c.fillStyle = COLORS.grid;
        for (let x = -as.hw - 10; x <= as.hw + 10; x += 2) {
            for (let y = -as.hh - 10; y <= as.hh + 10; y += 2) {
                const [sx, sy] = toScreen(x, y);
                if (sx < -2 || sy < -2 || sx > W + 2 || sy > H + 2) continue;
                c.fillRect(sx - 0.6, sy - 0.6, 1.2, 1.2);
            }
        }
        // a légtéren kívüli rész enyhe sötétítése
        const [x0, y0] = toScreen(-as.hw, as.hh);
        const [x1, y1] = toScreen(as.hw, -as.hh);
        c.fillStyle = 'rgba(6,10,16,0.4)';
        c.beginPath();
        c.rect(0, 0, W, H);
        c.rect(x1, y0, x0 - x1, y1 - y0);
        c.fill('evenodd');
    }

    function drawBackground() {
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
        const as = airspace();
        const [x0, y0] = toScreen(-as.hw, as.hh);
        const [x1, y1] = toScreen(as.hw, -as.hh);
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0 - 1, y1 - y0 - 1);
        // északi nyíl
        const nx = x1 - 26;
        const ny = y1 - 18;
        ctx.fillStyle = COLORS.muted;
        ctx.font = '600 15px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('É', nx, ny - 40);
        ctx.strokeStyle = COLORS.muted;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.lineTo(nx, ny - 28);
        ctx.lineTo(nx - 4, ny - 20);
        ctx.moveTo(nx, ny - 28);
        ctx.lineTo(nx + 4, ny - 20);
        ctx.stroke();
    }

    function drawSectors() {
        const r = state.room;
        if (!r || r.settings.mode !== 'sector' || !state.info) return;
        const n = Rules.sectorCount(r.players);
        const k = scale();
        const as = airspace();
        const far = Math.hypot(as.hw, as.hh) + 2;
        const [cx, cy] = toScreen(0, 0);
        const [x0, y0] = toScreen(-as.hw, as.hh);
        const [x1, y1] = toScreen(as.hw, -as.hh);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        ctx.strokeStyle = 'rgba(79,209,197,0.3)';
        ctx.setLineDash([8, 6]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(cx, cy, Rules.TOWER_RADIUS * k, 0, Math.PI * 2);
        ctx.stroke();
        for (let i = 0; i < n; i++) {
            const brg = (r.settings.sectorOffset + i * (360 / n)) * Math.PI / 180;
            const [xa, ya] = toScreen(Math.sin(brg) * Rules.TOWER_RADIUS, Math.cos(brg) * Rules.TOWER_RADIUS);
            const [xb, yb] = toScreen(Math.sin(brg) * far, Math.cos(brg) * far);
            ctx.beginPath();
            ctx.moveTo(xa, ya);
            ctx.lineTo(xb, yb);
            ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.textAlign = 'center';
        for (let i = 0; i < n; i++) {
            const mid = (r.settings.sectorOffset + (i + 0.5) * (360 / n)) * Math.PI / 180;
            const dist = Math.min(as.hw / Math.max(0.01, Math.abs(Math.sin(mid))), as.hh / Math.max(0.01, Math.abs(Math.cos(mid)))) * 0.62;
            const [tx, ty] = toScreen(Math.sin(mid) * dist, Math.cos(mid) * dist);
            const owners = r.players.filter((p) => p.sector === i);
            ctx.fillStyle = owners.length ? owners[0].color : COLORS.muted;
            ctx.globalAlpha = 0.55;
            ctx.font = '600 12px ui-monospace, monospace';
            ctx.fillText(`${i + 1}. SZEKTOR`, tx, ty);
            ctx.font = '11px system-ui, sans-serif';
            ctx.fillText(owners.map((p) => p.name).join(', ') || 'gazdátlan', tx, ty + 15);
            ctx.globalAlpha = 1;
        }
        ctx.fillStyle = 'rgba(79,209,197,0.5)';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText('TORONY · KÖZÖS', cx, cy - Rules.TOWER_RADIUS * k - 6);
        ctx.restore();
    }

    // ---------- zivatarok ----------
    function drawStorms(now) {
        if (!state.snap || !state.snap.storms) return;
        const k = scale();
        for (const s of state.snap.storms) {
            const [sx, sy] = toScreen(s.x, s.y);
            const layers = [
                [s.r, 'rgba(70,160,90,0.22)', 'rgba(90,190,110,0.45)'],
                [s.r * 0.62, 'rgba(210,180,60,0.25)', 'rgba(230,200,80,0.5)']
            ];
            if (s.core > 0) layers.push([s.core, 'rgba(220,60,70,0.45)', 'rgba(255,90,100,0.9)']);
            if (s.hu) {
                // hurrikán: forgó spirálkarok
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(-now / 2500);
                ctx.strokeStyle = 'rgba(255,120,130,0.55)';
                ctx.lineWidth = 3;
                for (let arm = 0; arm < 4; arm++) {
                    ctx.beginPath();
                    for (let t = 0; t <= 1; t += 0.04) {
                        const ang = arm * Math.PI / 2 + t * Math.PI * 1.6;
                        const rr = (s.core + (s.r - s.core) * t) * k;
                        const px = Math.cos(ang) * rr;
                        const py = Math.sin(ang) * rr;
                        if (t) ctx.lineTo(px, py); else ctx.moveTo(px, py);
                    }
                    ctx.stroke();
                }
                ctx.restore();
            }
            for (const [r, fill, stroke] of layers) {
                ctx.beginPath();
                // kissé szabálytalan, „csapadékszerű” forma
                for (let i = 0; i <= 24; i++) {
                    const ang = (i / 24) * Math.PI * 2;
                    const wob = 1 + 0.08 * Math.sin(ang * 3 + s.id * 1.7) + 0.05 * Math.sin(ang * 5 + s.id);
                    const px = sx + Math.cos(ang) * r * k * wob;
                    const py = sy + Math.sin(ang) * r * k * wob;
                    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
                }
                ctx.closePath();
                ctx.fillStyle = fill;
                ctx.fill();
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
            ctx.fillStyle = 'rgba(255,140,150,0.9)';
            ctx.font = '600 10px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(s.hu ? 'HURRIKÁN' : 'ZIVATAR', sx, sy - s.r * k - 6);
            // sodródás iránya
            const ang = s.h * Math.PI / 180;
            const ax = sx + Math.sin(ang) * (s.r * k + 14);
            const ay = sy - Math.cos(ang) * (s.r * k + 14);
            ctx.strokeStyle = 'rgba(220,230,240,0.6)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(ax - Math.sin(ang) * 14, ay + Math.cos(ang) * 14);
            ctx.lineTo(ax, ay);
            ctx.lineTo(ax - Math.sin(ang - 0.5) * 7, ay + Math.cos(ang - 0.5) * 7);
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax - Math.sin(ang + 0.5) * 7, ay + Math.cos(ang + 0.5) * 7);
            ctx.stroke();
            void now;
        }
    }

    // ---------- köd ----------
    function drawFogs(now) {
        if (!state.snap || !state.snap.fogs) return;
        const k = scale();
        for (const f of state.snap.fogs) {
            const [fx, fy] = toScreen(f.x, f.y);
            // több egymást fedő, lágy szélű folt: „gomolygó” köd
            for (let i = 0; i < 7; i++) {
                const ang = (i / 7) * Math.PI * 2 + f.id;
                const off = i === 0 ? 0 : f.r * 0.45;
                const cx = fx + Math.cos(ang + now / 9000) * off * k;
                const cy = fy + Math.sin(ang + now / 9000) * off * k;
                const rr = f.r * (i === 0 ? 0.8 : 0.6) * k;
                const g = ctx.createRadialGradient(cx, cy, rr * 0.2, cx, cy, rr);
                g.addColorStop(0, 'rgba(205,215,228,0.28)');
                g.addColorStop(1, 'rgba(205,215,228,0)');
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(cx, cy, rr, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.strokeStyle = 'rgba(205,215,228,0.35)';
            ctx.setLineDash([3, 6]);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(fx, fy, f.r * k, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(220,228,238,0.75)';
            ctx.font = '600 10px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.fillText('KÖD', fx, fy - f.r * k - 6);
        }
    }

    // ---------- kifutók ----------
    const runwayLabelHits = [];
    const runwayStripHits = [];
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
        runwayStripHits.length = 0;
        const k = scale();
        const widthPx = Math.max(8, RUNWAY_WIDTH_NM * k * 1.6);
        state.info.runways.forEach((rw, i) => {
            const rs = rwState(i);
            if (rs.c > 0) return;
            const [a, b] = [rw.ends[rs.e], rw.ends[1 - rs.e]];
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
            const rs = rwState(i);
            const [a, b] = [rw.ends[rs.e], rw.ends[1 - rs.e]];
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
            runwayStripHits.push({ index: i, a: sa, b: sb, half: widthPx / 2 });
            ctx.fillStyle = rs.c > 0 ? '#3a2f36' : '#3a4554';
            ctx.strokeStyle = rs.c > 0 ? '#7a4450' : '#59677a';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(sa[0] + px, sa[1] + py);
            ctx.lineTo(sb[0] + px, sb[1] + py);
            ctx.lineTo(sb[0] - px, sb[1] - py);
            ctx.lineTo(sa[0] - px, sa[1] - py);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // küszöbcsíkok
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
            // középvonal
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
            if (widthPx >= 11 && lenPx > widthPx * 5) {
                const fs = Math.min(widthPx * 0.62, 14);
                const inset = Math.min(lenPx * 0.06, widthPx * 0.9) + fs;
                drawRunwayDesignator(rw.names[rs.e], sa[0] + ax * inset, sa[1] + ay * inset, angle + Math.PI / 2, fs);
                drawRunwayDesignator(rw.names[1 - rs.e], sb[0] - ax * inset, sb[1] - ay * inset, angle - Math.PI / 2, fs);
            }
            // lezárás jelzése
            const mx = (sa[0] + sb[0]) / 2;
            const my = (sa[1] + sb[1]) / 2;
            if (rs.c > 0 || rs.w > 0) {
                if (rs.c > 0) {
                    ctx.strokeStyle = COLORS.bad;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(mx - 7, my - 7);
                    ctx.lineTo(mx + 7, my + 7);
                    ctx.moveTo(mx + 7, my - 7);
                    ctx.lineTo(mx - 7, my + 7);
                    ctx.stroke();
                }
                ctx.fillStyle = rs.c > 0 ? COLORS.bad : COLORS.transit;
                ctx.font = '600 10px ui-monospace, monospace';
                ctx.textAlign = 'center';
                ctx.fillText(rs.c > 0 ? `${rw.names[rs.e]} LEZÁRVA ${fmtTime(rs.c)}` : `${rw.names[rs.e]} LEZÁR ${rs.w}s`, mx, my + widthPx + 14);
            }
            // aktív vég: billentyűszám + név a küszöb előtt
            const lx = sa[0] - ax * (widthPx + 14);
            const ly = sa[1] - ay * (widthPx + 14);
            ctx.fillStyle = '#0e1622';
            ctx.strokeStyle = rs.c > 0 ? COLORS.muted : COLORS.arr;
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
            ctx.fillText(rw.names[rs.e], lx - ax * 20, ly - ay * 20);
            ctx.textBaseline = 'alphabetic';
            runwayLabelHits.push({ index: i, x: lx, y: ly });
        });
    }

    // ---------- kapuk ----------
    // többrepteres pályán a repterek neve, „Saját reptér” módban a gazda színével
    function drawAirportLabels() {
        if (!multiAirport()) return;
        const r = state.room;
        state.info.airports.forEach((ap, i) => {
            const [x, y] = toScreen(ap.pos[0], ap.pos[1]);
            const owner = r && r.settings.mode === 'airports' ? r.players.find((p) => p.airport === i) : null;
            ctx.font = '600 12px ui-monospace, monospace';
            ctx.textAlign = 'center';
            const label = `${ap.icao} · ${ap.name}${owner ? ` · ${owner.name}` : ''}`;
            const w = ctx.measureText(label).width + 12;
            ctx.fillStyle = 'rgba(14,22,34,0.75)';
            ctx.fillRect(x - w / 2, y + 26, w, 18);
            ctx.strokeStyle = owner ? owner.color : 'rgba(201,212,227,0.35)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - w / 2 + 0.5, y + 26.5, w - 1, 17);
            ctx.fillStyle = owner ? owner.color : COLORS.text;
            ctx.fillText(label, x, y + 39);
        });
    }

    // „Korábbi átvétel”: a hamarosan belépő gépek jelzése a kapunál
    function drawIncoming(now) {
        if (!state.snap || !state.snap.incoming) return;
        for (const inc of state.snap.incoming) {
            const g = state.info.gates.find((x) => x.letter === inc.g);
            if (!g) continue;
            let [sx, sy] = toScreen(...g.pos);
            sx = Math.max(20, Math.min(W - 20, sx));
            sy = Math.max(20, Math.min(H - 20, sy));
            const pulse = 0.5 + 0.5 * Math.sin(now / 150);
            ctx.strokeStyle = COLORS[inc.k];
            ctx.globalAlpha = 0.5 + pulse * 0.5;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(sx, sy, 24, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = COLORS[inc.k];
            ctx.font = '600 11px ui-monospace, monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`${KIND_LABEL[inc.k]} ${inc.t}s`, sx, sy - 30 < 10 ? sy + 40 : sy - 30);
        }
    }

    function drawGates() {
        if (!state.info) return;
        for (const g of state.info.gates) {
            let [sx, sy] = toScreen(...g.pos);
            sx = Math.max(20, Math.min(W - 20, sx));
            sy = Math.max(20, Math.min(H - 20, sy));
            ctx.fillStyle = 'rgba(14,22,34,0.9)';
            ctx.strokeStyle = 'rgba(201,212,227,0.6)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sx, sy, 18, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = COLORS.text;
            ctx.font = '600 16px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(g.letter, sx, sy + 1);
            ctx.textBaseline = 'alphabetic';
            // a fix neve a kapu belső oldalára
            const [cx, cy] = toScreen(0, 0);
            const vx = cx - sx;
            const vy = cy - sy;
            const vl = Math.hypot(vx, vy) || 1;
            ctx.fillStyle = COLORS.muted;
            ctx.font = '600 11px ui-monospace, monospace';
            ctx.fillText(g.name, sx + (vx / vl) * 38, sy + (vy / vl) * 38 + 4);
        }
    }

    // ---------- gépek ----------
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

    // A gép várható pályája ívekkel: a böngésző végigszámolja, merre repül a gép a saját fordulási ívével
    // (a sebességéből és fordulási képességéből adódó sugárral), ugyanúgy, ahogy a szerver vezeti.
    // Eredmény: mintapontok, mindegyiknél a szakasz sorszáma (melyik célpont felé tart), a húzáshoz.
    function predictPath(a) {
        const out = [];
        const ts = state.info.timeScale;
        const rate = 3 * ts * (hasPerk('agile') ? 1.25 : 1) * Math.PI / 180;   // rad/s
        const v = Math.max(a.s || 0, 140) * ts / 3600;                           // nm/s
        const radius = v / rate;
        const route = routeFor(a);
        const end = routeEnd(a);
        let x;
        let y;
        let h;
        const prefix = departurePrefix(a);
        if (prefix) {
            // felszállás: a kifutón végig egyenesen, majd a kifutó vége után 1 nm egyenes emelkedés
            prefix.forEach((q) => out.push({ x: q[0], y: q[1], seg: -1 }));
            [x, y] = prefix[prefix.length - 1];
            const a0 = prefix[prefix.length - 2];
            h = Math.atan2(x - a0[0], y - a0[1]);
        } else {
            const p = posOf(a);
            x = p.x;
            y = p.y;
            h = (p.h || 0) * Math.PI / 180;
            out.push({ x, y, seg: 0 });
        }
        // célpontok: útpontok, majd a vég (érkezőnél a csatlakozás és a tengely pontjai, egyébként a kapu)
        const targets = route.map((q, i) => ({ p: q, seg: i, sw: 0.6 }));
        if (a.k === 'arr' && end.length) {
            const thr = end[end.length - 1];
            const approach = end.slice(0, -1);
            approach.forEach((q, i) => targets.push({ p: q, seg: route.length + i, sw: i === approach.length - 1 ? 0.25 : 0.6 }));
            // a csatlakozástól a küszöbig a tengely pontjai, hogy a ráfordulás íve is látsszon
            const from = approach.length ? approach[approach.length - 1] : [x, y];
            const n = Math.max(1, Math.round(Math.hypot(thr[0] - from[0], thr[1] - from[1]) / 0.5));
            for (let i = 1; i <= n; i++) targets.push({ p: [from[0] + (thr[0] - from[0]) * i / n, from[1] + (thr[1] - from[1]) * i / n], seg: 99, sw: 0.15 });
        } else {
            end.forEach((q, i) => targets.push({ p: q, seg: route.length + i, sw: 0.6 }));
        }
        const ds = 0.06;
        let steps = 0;
        for (const t of targets) {
            while (Math.hypot(t.p[0] - x, t.p[1] - y) > t.sw && steps < 1500) {
                const want = Math.atan2(t.p[0] - x, t.p[1] - y);
                let d = want - h;
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                const maxTurn = ds / radius;
                h += Math.max(-maxTurn, Math.min(maxTurn, d));
                x += Math.sin(h) * ds;
                y += Math.cos(h) * ds;
                if (steps % 3 === 0) out.push({ x, y, seg: t.seg });
                steps++;
            }
        }
        if (targets.length) {
            const last = targets[targets.length - 1];
            out.push({ x: last.p[0], y: last.p[1], seg: last.seg });
        }
        return out;
    }

    function drawRoute(a, color, faded) {
        const path = predictPath(a);
        ctx.strokeStyle = color;
        ctx.globalAlpha = faded ? 0.3 : 0.85;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 5]);
        ctx.beginPath();
        path.forEach((q, i) => {
            const [x, y] = toScreen(q.x, q.y);
            if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        if (!faded) {
            routeFor(a).forEach((q, i) => {
                const [x, y] = toScreen(...q);
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
        }
        ctx.globalAlpha = 1;
    }

    function drawAircraft(now) {
        if (!state.snap) return;
        const k = scale();
        const players = state.room ? state.room.players : [];
        const multi = players.length > 1 && state.room.settings.mode !== 'free';
        const showAll = rules().showAllRoutes;
        const alt = rules().altitude;
        const airborne = state.snap.aircraft.filter((a) => a.st !== 'ground');
        if (showAll) for (const a of airborne) if (a.id !== state.selected) drawRoute(a, acColor(a), true);
        // a kijelölt, még földön álló induló tervezett útja: kifutó → egyenes emelkedés → útpontok → kapu
        const selGround = state.selected != null ? state.acById.get(state.selected) : null;
        if (selGround && selGround.st === 'ground' && selGround.k === 'dep') {
            drawRoute(selGround, acColor(selGround), false);
            const rw = state.info.runways[selGround.rw];
            if (rw) {
                const [tx, ty] = toScreen(...rw.ends[rwState(selGround.rw).e]);
                ctx.fillStyle = acColor(selGround);
                ctx.font = '600 11px ui-monospace, monospace';
                ctx.textAlign = 'center';
                ctx.fillText(`${selGround.cs} · ${runwayLabel(selGround.rw)}`, tx, ty - 26);
            }
        }
        for (const a of airborne) {
            const p = posOf(a);
            const [sx, sy] = toScreen(p.x, p.y);
            const color = acColor(a);
            const mine = canControl(a);
            const baseAlpha = multi && !mine ? 0.45 : 1;
            ctx.globalAlpha = baseAlpha;

            const tr = state.trails.get(a.id) || [];
            ctx.fillStyle = color;
            tr.forEach((q, i) => {
                const [tx, ty] = toScreen(...q);
                ctx.globalAlpha = baseAlpha * (0.15 + i * 0.08);
                ctx.beginPath();
                ctx.arc(tx, ty, 1.6, 0, Math.PI * 2);
                ctx.fill();
            });
            ctx.globalAlpha = baseAlpha;

            if (a.pc && !a.cf) {
                ctx.strokeStyle = COLORS.pc;
                ctx.setLineDash([3, 4]);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(sx, sy, Math.max(16, 1.5 * k), 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            if (a.vp) {
                ctx.strokeStyle = COLORS.vip;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(sx, sy, Math.max(14, 1.5 * k), 0, Math.PI * 2);
                ctx.stroke();
            }
            if (a.cf) {
                const pulse = 0.5 + 0.5 * Math.sin(now / 160);
                ctx.strokeStyle = COLORS.bad;
                ctx.lineWidth = 1.5 + pulse;
                ctx.beginPath();
                ctx.arc(sx, sy, Math.max(16, 1.5 * k), 0, Math.PI * 2);
                ctx.stroke();
            }

            for (const pl of players) {
                if (pl.id === state.me || pl.selected !== a.id) continue;
                ctx.strokeStyle = pl.color;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(sx, sy, 15, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = pl.color;
                ctx.font = '10px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(pl.name, sx, sy + 27);
            }

            if (state.selected === a.id) {
                drawRoute(a, color, false);
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

            if (a.k === 'mil') {
                // vadászgép: kis zöld delta, rövid felirat, nincs adatblokk
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(p.h * Math.PI / 180);
                ctx.fillStyle = COLORS.mil;
                ctx.beginPath();
                ctx.moveTo(0, -8);
                ctx.lineTo(6, 6);
                ctx.lineTo(0, 3);
                ctx.lineTo(-6, 6);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
                ctx.fillStyle = COLORS.mil;
                ctx.font = '10px ui-monospace, monospace';
                ctx.textAlign = 'left';
                ctx.fillText(a.cs, sx + 9, sy - 6);
                ctx.globalAlpha = 1;
                continue;
            }
            if (a.hj) {
                // eltérített gép: villogó narancs kör és szaggatott vonal a célreptérig
                const pulse = 0.5 + 0.5 * Math.sin(now / 140);
                ctx.strokeStyle = `rgba(255,159,28,${0.55 + pulse * 0.45})`;
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(sx, sy, 20 + pulse * 4, 0, Math.PI * 2);
                ctx.stroke();
                const tgt = state.info.airports[a.ap] || state.info.airports[0];
                const [tx, ty] = toScreen(tgt.pos[0], tgt.pos[1]);
                ctx.setLineDash([6, 6]);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(tx, ty);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            if (a.sw) {
                const pulse = 0.5 + 0.5 * Math.sin(now / 110);
                ctx.strokeStyle = `rgba(255,77,94,${0.5 + pulse * 0.5})`;
                ctx.setLineDash([4, 3]);
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(sx, sy, 22, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            drawPlane(sx, sy, p.h, a.fg ? '#9aa6b5' : color, a.c === 'wide' ? 10 : a.c === 'turboprop' ? 7.5 : 8.5);
            if (a.fg) {
                ctx.fillStyle = '#e6ecf4';
                ctx.font = '600 11px system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('?', sx, sy - 12);
            }

            // adatblokk
            let line1 = `${a.cs} ${acBadge(a)}`;
            if (multiAirport() && a.k !== 'mil' && a.k !== 'transit') line1 += ` ${apCode(a.ap)}`;
            if (a.k === 'arr' && a.rw != null) line1 += ` ${runwayLabel(a.rw)}`;
            if ((a.k === 'dep' || a.k === 'transit') && a.eg) line1 += ` →${a.eg}`;
            let line2;
            if (alt) {
                line2 = `${fl(a.al)}${a.ta > a.al + 50 ? '↑' : a.ta < a.al - 50 ? '↓' : ' '}${a.ta !== a.al ? fl(a.ta) : '   '} ${a.s}kt`;
                if (a.xa && a.k !== 'arr') line2 += ` ki:${a.xa / 100}`;
            } else {
                line2 = `${a.s}kt`;
            }
            if (a.hd) line2 += ' ⟳';
            // kijelölt gépnél a hátralévő üzemanyag (idő) is látszik
            if (state.selected === a.id && a.st !== 'rollout') line2 += `  üa. ${a.f}s`;
            const lines = [line1, line2];
            ctx.font = '11px ui-monospace, monospace';
            const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 10;
            // a képernyő szélén az adatblokk a gép másik oldalára kerül
            let bx = sx + 16;
            let by = sy - 30;
            if (bx + w > W - 4) bx = sx - 16 - w;
            if (by < 4) by = sy + 14;
            ctx.fillStyle = 'rgba(14,22,34,0.82)';
            ctx.fillRect(bx, by, w, 30);
            ctx.strokeStyle = a.cf ? COLORS.bad : a.em != null ? COLORS.em : 'rgba(201,212,227,0.25)';
            ctx.lineWidth = 1;
            ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, 29);
            if (multi) {
                const owners = Rules.ownersOf(a, state.room.settings, players);
                owners.slice(0, 3).forEach((pl, i) => {
                    ctx.fillStyle = pl.color;
                    ctx.fillRect(bx, by + i * (30 / Math.min(3, owners.length)), 3, 30 / Math.min(3, owners.length));
                });
            }
            ctx.textAlign = 'left';
            ctx.fillStyle = color;
            ctx.fillText(lines[0], bx + 6, by + 12);
            ctx.fillStyle = COLORS.text;
            ctx.fillText(lines[1], bx + 6, by + 25);
            if (a.hj) {
                ctx.fillStyle = COLORS.hj;
                ctx.fillText(a.sc ? 'ELTÉRÍTETT – VADÁSZOK ÚTON' : 'ELTÉRÍTETT – NYOMD: F', bx + 6, by + 40);
            } else if (a.vp) {
                ctx.fillStyle = COLORS.vip;
                ctx.fillText(a.sc ? 'VIP – GRIPEN KÍSÉRET' : a.ed != null ? `VIP – KÍSÉRET: ${a.ed}s (F)` : 'VIP – KÍSÉRET NÉLKÜL', bx + 6, by + 40);
            } else if (a.sq) {
                ctx.fillStyle = COLORS.muted;
                ctx.fillText(`#${a.sq} ${fmtTime(a.eta)}${a.gp != null ? ` +${a.gp}s` : ''}`, bx + 6, by + 40);
            } else if (a.sw) {
                ctx.fillStyle = COLORS.bad;
                ctx.fillText('ZIVATAR! FORDÍTSD EL', bx + 6, by + 40);
            } else if (a.fg) {
                ctx.fillStyle = '#c3ccd8';
                ctx.fillText('KÖDBEN – NEM IRÁNYÍTHATÓ', bx + 6, by + 40);
            } else if (a.em != null) {
                ctx.fillStyle = COLORS.em;
                ctx.fillText(`VÉSZ ${fmtTime(a.em)}`, bx + 6, by + 40);
            } else if (a.f < 90 && a.st !== 'rollout') {
                ctx.fillStyle = COLORS.bad;
                ctx.fillText(`ÜZEMANYAG ${a.f}s`, bx + 6, by + 40);
            }
            ctx.globalAlpha = 1;
        }
    }

    function drawPings(now) {
        state.pings = state.pings.filter((p) => now - p.at < 3500);
        for (const p of state.pings) {
            const [x, y] = toScreen(p.x, p.y);
            const age = (now - p.at) / 3500;
            for (let i = 0; i < 3; i++) {
                const t = ((now - p.at) / 900 + i / 3) % 1;
                ctx.strokeStyle = p.color;
                ctx.globalAlpha = (1 - t) * (1 - age * 0.6);
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(x, y, 6 + t * 34, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.globalAlpha = 1 - age * 0.5;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.font = '600 12px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(p.by, x, y - 44);
            ctx.globalAlpha = 1;
        }
        // gyorsüzenethez kötött gép kiemelése
        if (state.flash && now < state.flash.until && state.acById.has(state.flash.id)) {
            const p = posOf(state.acById.get(state.flash.id));
            const [x, y] = toScreen(p.x, p.y);
            const pulse = 0.5 + 0.5 * Math.sin(now / 120);
            ctx.strokeStyle = state.flash.color;
            ctx.lineWidth = 3;
            ctx.globalAlpha = 0.5 + pulse * 0.5;
            ctx.beginPath();
            ctx.arc(x, y, 26 + pulse * 6, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }

    function frame(now) {
        updateDisplay(now);
        if (state.info) clampView();
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.fillStyle = '#0e1622';
        ctx.fillRect(0, 0, W, H);
        if (state.info) {
            drawBackground();
            drawSectors();
            drawFogs(now);
            drawStorms(now);
            drawRunways();
            drawAirportLabels();
            drawGates();
            drawIncoming(now);
            drawAircraft(now);
            drawPings(now);
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
                const p = posOf(a);
                const [x, y] = toScreen(p.x, p.y);
                return { a, d: Math.hypot(x - sx, y - sy) };
            })
            .filter((h) => h.d < 16 * hitScale())
            .sort((p, q) => p.d - q.d)
            .map((h) => h.a);
    }

    function waypointAt(a, sx, sy) {
        const route = routeFor(a);
        for (let i = 0; i < route.length; i++) {
            const [x, y] = toScreen(...route[i]);
            if (Math.hypot(x - sx, y - sy) < 10 * hitScale()) return i;
        }
        return -1;
    }

    // a kirajzolt (íves) pálya melyik szakaszára kattintottak; a visszaadott szám az útpont beszúrási helye
    function segmentAt(a, sx, sy) {
        const path = predictPath(a);
        const route = routeFor(a);
        let best = -1;
        let bestD = 7 * hitScale();
        for (let i = 0; i < path.length - 1; i++) {
            const seg = path[i + 1].seg;
            // a végső megközelítés (99) és a felszállási egyenes (-1) nem húzható
            if (seg < 0 || seg === 99) continue;
            if (a.k === 'arr' && seg > route.length + Math.max(0, (a.aj || []).length - 1)) continue;
            const [ax, ay] = toScreen(path[i].x, path[i].y);
            const [bx, by] = toScreen(path[i + 1].x, path[i + 1].y);
            const dx = bx - ax;
            const dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / len2)) : 0;
            const d = Math.hypot(sx - (ax + t * dx), sy - (ay + t * dy));
            // a waypointok körüli kis területet a waypoint-húzás kapja
            const nearWp = route.some((q) => { const [wx, wy] = toScreen(...q); return Math.hypot(sx - wx, sy - wy) < 10 * hitScale(); });
            if (d < bestD && !nearWp) {
                bestD = d;
                best = Math.min(seg, route.length);
            }
        }
        return best;
    }

    // a kifutó előtti szám vagy maga a kifutó a kattintás helyén
    function runwayAt(sx, sy) {
        // több találatnál (párhuzamos kifutók) mindig a legközelebbi nyer
        let best = null;
        let bestD = 12 * hitScale();
        for (const h of runwayLabelHits) {
            const d = Math.hypot(h.x - sx, h.y - sy);
            if (d < bestD) { bestD = d; best = h.index; }
        }
        if (best != null) return best;
        let bestStrip = Infinity;
        for (const r of runwayStripHits) {
            const dx = r.b[0] - r.a[0];
            const dy = r.b[1] - r.a[1];
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((sx - r.a[0]) * dx + (sy - r.a[1]) * dy) / len2)) : 0;
            const d = Math.hypot(sx - (r.a[0] + t * dx), sy - (r.a[1] + t * dy));
            if (d < r.half + 3 && d < bestStrip) { bestStrip = d; best = r.index; }
        }
        return best;
    }

    // érintésnél nagyobb a koppintási terület
    let touchMode = false;
    const hitScale = () => (touchMode ? 1.8 : 1);

    function canvasPos(e) {
        const r = canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
    }

    let lastMoveSent = 0;
    const pointers = new Map();   // aktív ujjak / lenyomott egérgombok
    let pinch = null;             // két ujjas nagyítás állapota
    let pinchLock = false;        // csípés után minden ujj felengedéséig nem kezelünk koppintást
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // kattintás vagy koppintás üres helyre: útpont a kijelölt gépnek, vagy kijelölés megszüntetése
    function emptyClick(sx, sy, mods) {
        const sel = state.selected != null ? state.acById.get(state.selected) : null;
        if (!sel) {
            select(null);
            return;
        }
        if (!canControl(sel)) {
            addLog('warn', `${sel.cs} nem a te géped.`);
            return;
        }
        const [x, y] = toWorld(sx, sy);
        if (sel.fg) {
            addLog('warn', `${sel.cs} ködben van, amíg ki nem ér, nem irányítható.`);
            return;
        }
        if (sel.st === 'rollout' || (sel.st === 'ground' && sel.k !== 'dep')) return;
        const as = airspace();
        if (Math.abs(x) > as.hw + 0.5 || Math.abs(y) > as.hh + 0.5) return;
        if (mods.shiftKey) {
            cmd('replaceRoute', { id: sel.id, x, y });
            sel.r = [[x, y]];
        } else {
            cmd('addWaypoint', { id: sel.id, x, y });
        }
    }

    function startPinch() {
        const [p1, p2] = [...pointers.values()];
        const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        pinch = { d: Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) || 1, zoom: state.view.zoom, world: toWorld(...mid) };
        state.drag = null;
        state.localRoute = null;
        pinchLock = true;
    }

    canvas.addEventListener('pointerdown', (e) => {
        touchMode = e.pointerType === 'touch' || e.pointerType === 'pen';
        try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* nem baj */ }
        const [sx, sy] = canvasPos(e);
        pointers.set(e.pointerId, [sx, sy]);
        if (pointers.size === 2) {
            startPinch();
            return;
        }
        if (pointers.size > 2 || pinchLock) return;
        if (e.button === 2 || e.button === 1) {
            state.drag = { type: 'pan', sx, sy, panX: state.view.panX, panY: state.view.panY, right: e.button === 2 };
            return;
        }
        if (!state.snap) return;
        const sel = state.selected != null ? state.acById.get(state.selected) : null;

        if (e.shiftKey) {
            const hit = runwayLabelHits.reduce((m, h) => { const d = Math.hypot(h.x - sx, h.y - sy); return d < 11 && (!m || d < m.d) ? { index: h.index, d } : m; }, null);
            if (hit) {
                cmd('flipRunway', { runway: hit.index });
                return;
            }
        }

        // kijelölt gépnél a kifutó számára vagy magára a kifutóra kattintás = kifutó kiosztása
        if (sel && canControl(sel) && !e.shiftKey && !e.altKey && (sel.st === 'ground' || (sel.k === 'arr' && (sel.st === 'airborne' || sel.st === 'final')))) {
            const rwHit = runwayAt(sx, sy);
            if (rwHit != null) {
                cmd('runway', { id: sel.id, runway: rwHit });
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

        // érintésnél csak felengedéskor döntjük el, hogy koppintás (útpont) vagy húzás (térkép mozgatása)
        if (touchMode) {
            const drag = { type: 'tap', sx, sy };
            state.drag = drag;
            // hosszú érintés (fél másodperc mozdulatlanul): jelölés a térképen
            setTimeout(() => {
                if (state.drag === drag && drag.type === 'tap') {
                    drag.pinged = true;
                    sendPing(sx, sy);
                }
            }, 550);
            return;
        }
        emptyClick(sx, sy, e);
    });

    canvas.addEventListener('pointermove', (e) => {
        const [sx, sy] = canvasPos(e);
        state.mouse = [sx, sy];
        if (!pointers.has(e.pointerId)) {
            if (e.pointerType === 'mouse') updateCursor(sx, sy);
            return;
        }
        pointers.set(e.pointerId, [sx, sy]);
        if (pinch && pointers.size >= 2) {
            const [p1, p2] = [...pointers.values()];
            const d = Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) || 1;
            const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
            state.view.zoom = Math.max(1, Math.min(8, pinch.zoom * (d / pinch.d)));
            const now = toWorld(...mid);
            state.view.panX += now[0] - pinch.world[0];
            state.view.panY += now[1] - pinch.world[1];
            return;
        }
        let d = state.drag;
        if (!d) return;
        if (d.type === 'tap') {
            if (d.pinged || Math.hypot(sx - d.sx, sy - d.sy) < 10) return;
            d = { type: 'pan', sx: d.sx, sy: d.sy, panX: state.view.panX, panY: state.view.panY };
            state.drag = d;
        }
        if (d.type === 'pan') {
            const k = scale();
            state.view.panX = d.panX + (sx - d.sx) / k;
            state.view.panY = d.panY - (sy - d.sy) / k;
            return;
        }
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < (touchMode ? 8 : 4)) return;
        const [x, y] = toWorld(sx, sy);
        if (d.type === 'seg' && !d.moved) {
            const a = state.acById.get(d.id);
            if (!a) return;
            d.index = Math.min(d.index, a.r.length);
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

    function onPointerEnd(e) {
        pointers.delete(e.pointerId);
        if (pinch) {
            if (pointers.size < 2) pinch = null;
            state.drag = null;
            if (pointers.size === 0) pinchLock = false;
            return;
        }
        if (pointers.size === 0) pinchLock = false;
        const d = state.drag;
        state.drag = null;
        if (d && d.type === 'pan' && d.right && e.type !== 'pointercancel') {
            // jobb klikk húzás nélkül: jelölés a térképen
            const [ux, uy] = canvasPos(e);
            if (Math.hypot(ux - d.sx, uy - d.sy) < 6) sendPing(ux, uy);
            return;
        }
        if (d && d.pinged) return;
        if (!d || d.type === 'pan' || e.type === 'pointercancel') return;
        const [sx, sy] = canvasPos(e);
        if (d.type === 'tap') {
            emptyClick(d.sx, d.sy, { shiftKey: false, altKey: false });
        } else if (d.type === 'wp') {
            if (d.moved) {
                const [x, y] = toWorld(sx, sy);
                cmd('moveWaypoint', { id: d.id, index: d.index, x, y });
            } else {
                cmd('removeWaypoint', { id: d.id, index: d.index });
                if (state.localRoute) state.localRoute.route.splice(d.index, 1);
            }
            setTimeout(() => { if (!state.drag) state.localRoute = null; }, 350);
        } else if (d.type === 'seg' && !d.moved) {
            const [x, y] = toWorld(sx, sy);
            cmd('addWaypoint', { id: d.id, x, y, index: d.index });
        }
    }
    canvas.addEventListener('pointerup', onPointerEnd);
    canvas.addEventListener('pointercancel', onPointerEnd);

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const [sx, sy] = canvasPos(e);
        const before = toWorld(sx, sy);
        state.view.zoom = Math.max(1, Math.min(8, state.view.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        const after = toWorld(sx, sy);
        state.view.panX += after[0] - before[0];
        state.view.panY += after[1] - before[1];
    }, { passive: false });

    function sendPing(sx, sy) {
        if (!state.room || !state.info) return;
        const [x, y] = toWorld(sx, sy);
        send({ t: 'ping', x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
    }

    function updateCursor(sx, sy) {
        const sel = state.selected != null ? state.acById.get(state.selected) : null;
        let cursor = sel ? 'crosshair' : 'default';
        if (aircraftAt(sx, sy).length) cursor = 'pointer';
        else if (sel && (sel.st === 'ground' || sel.k === 'arr') && runwayAt(sx, sy) != null) cursor = 'pointer';
        else if (sel && (waypointAt(sel, sx, sy) >= 0 || segmentAt(sel, sx, sy) >= 0)) cursor = 'move';
        canvas.style.cursor = cursor;
    }

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
        const idx = cur < 0 ? 0 : (cur + (backwards ? -1 : 1) + list.length) % list.length;
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
        if (key === 'i') {
            if ($('summary').hidden) showStatsSoFar(); else $('summary').hidden = true;
            return;
        }
        if (key === 'p' && state.mouse) { sendPing(...state.mouse); return; }
        if (key === 'h') { $('app').classList.toggle('hide-top'); setTimeout(resize, 0); return; }
        if (key === 'escape') { select(null); $('help').hidden = true; return; }
        if (key === '?') { $('help').hidden = !$('help').hidden; return; }
        if (key === 'f' && !(sel && (sel.hj || sel.vp))) {
            const hj = state.snap && state.snap.aircraft.find((x) => (x.hj || (x.vp && x.ed != null)) && !x.sc);
            if (hj) cmd('scramble', { id: hj.id });
            return;
        }
        if (!sel) return;
        if (/^[1-9]$/.test(key)) {
            const i = Number(key) - 1;
            if (state.info && i < state.info.runways.length) cmd('runway', { id: sel.id, runway: i });
            return;
        }
        if (key === 'x') cmd('takeoff', { id: sel.id });
        else if (key === 'r') cmd('hold', { id: sel.id });
        else if (key === 'g') cmd('goAround', { id: sel.id });
        else if (key === 'f') cmd('scramble', { id: sel.id });
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
        // a kártya ötször újrarajzolódik másodpercenként: a választást megjegyezzük,
        // a gombok pedig már lenyomáskor reagálnak, hogy egy kattintás se vesszen el
        $('sel-card').addEventListener('change', (e) => {
            if (e.target.id === 'handoff-to') state.handoffTo = Number(e.target.value);
        });
        $('sel-card').onpointerdown = (e) => {
            if (e.button !== 0) return;
            const b = e.target.closest('button[data-act]');
            if (b) e.preventDefault();
            if (!b || state.selected == null) return;
            const id = state.selected;
            const act = b.dataset.act;
            if (act === 'runway') cmd('runway', { id, runway: Number(b.dataset.rw) });
            else if (act === 'takeoff') cmd('takeoff', { id });
            else if (act === 'hold') cmd('hold', { id });
            else if (act === 'goaround') cmd('goAround', { id });
            else if (act === 'scramble') cmd('scramble', { id });
            else if (act === 'exactspd') cmd('speed', { id, value: Number($('exact-speed').value) });
            else if (act === 'exit') cmd('changeExit', { id, gate: b.dataset.gate });
            else if (act === 'handoff') {
                const toSel = $('handoff-to');
                send({ t: 'handoff', id, to: toSel ? Number(toSel.value) : undefined });
                addLog('info', 'Kérés elküldve, várjuk a választ…');
            }
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
        const soundIcon = { on: '🔊', quiet: '🔉', off: '🔇' };
        $('btn-sound').textContent = soundIcon[Sound.level()];
        $('btn-sound').onclick = () => {
            const lvl = Sound.cycle();
            $('btn-sound').textContent = soundIcon[lvl];
            addLog('info', `Hangjelzések: ${{ on: 'bekapcsolva', quiet: 'halkan', off: 'kikapcsolva' }[lvl]}.`);
        };
        $('btn-help').onclick = () => { $('help').hidden = false; };
        $('btn-fit').onclick = () => { state.view = { zoom: 1, panX: 0, panY: 0 }; };
        $('quick-msgs').onclick = (e) => {
            const b = e.target.closest('[data-q]');
            if (b) send({ t: 'quick', i: Number(b.dataset.q), id: state.selected != null ? state.selected : undefined });
        };
        $('review-cards').onclick = (e) => {
            const b = e.target.closest('[data-perk]');
            if (b) cmd('choosePerk', { perk: b.dataset.perk });
        };
        $('btn-end-mobile').onclick = () => $('btn-end').click();
        $('help-close').onclick = () => { $('help').hidden = true; };
        $('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
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
        window.addEventListener('resize', () => { resize(); bg.key = ''; });
        if (window.ResizeObserver) new ResizeObserver(() => { resize(); bg.key = ''; }).observe($('scope-wrap'));
        bindLobby();
        bindSidebar();
        requestAnimationFrame(frame);
        await Promise.all([loadAirports(), connect()]);
        // oldalfrissítés után automatikusan visszalépünk a korábbi szobába
        const sess = loadSession();
        const urlRoom = new URLSearchParams(location.search).get('room');
        if (sess && (!urlRoom || urlRoom.toUpperCase() === sess.code)) send({ t: 'resume', code: sess.code, token: sess.token });
        renderLobby();
        window.__legterDebug = state;
    }

    main();
}());
