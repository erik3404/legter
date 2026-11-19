/* Légtér – hangjelzések Web Audio szintézissel (nincs szükség hangfájlokra).
   Minden eseménynek saját, jól megkülönböztethető hangja van. */
(function () {
    'use strict';

    let ac = null;
    let master = null;
    const LEVELS = { on: 0.55, quiet: 0.22, off: 0 };
    let level = 'on';
    const lastPlayed = {};

    try {
        const saved = localStorage.getItem('legter-sound');
        if (LEVELS[saved] != null) level = saved;
    } catch (e) { /* nem baj */ }

    function ensure() {
        if (!ac) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            ac = new Ctx();
            master = ac.createGain();
            master.gain.value = LEVELS[level];
            master.connect(ac.destination);
        }
        if (ac.state === 'suspended') ac.resume();
        return ac;
    }

    // a böngésző csak felhasználói művelet után engedi a hangot
    const unlock = () => ensure();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });

    function tone({ freq, freqEnd, type = 'sine', start = 0, dur = 0.15, gain = 0.5, attack = 0.005, filter }) {
        const t0 = ac.currentTime + start;
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (freqEnd) osc.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        let node = osc;
        if (filter) {
            const f = ac.createBiquadFilter();
            f.type = 'lowpass';
            f.frequency.value = filter;
            osc.connect(f);
            node = f;
        }
        node.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
    }

    const SOUNDS = {
        // új induló: fényes, felfelé lépő hármas csengő – a legfeltűnőbb hang
        depReady() {
            tone({ freq: 660, type: 'triangle', dur: 0.18, gain: 0.55 });
            tone({ freq: 880, type: 'triangle', start: 0.13, dur: 0.18, gain: 0.55 });
            tone({ freq: 1320, type: 'triangle', start: 0.26, dur: 0.32, gain: 0.5 });
        },
        // emlékeztető: induló vár – ugyanaz a dallam, rövidebben
        depReminder() {
            tone({ freq: 880, type: 'triangle', dur: 0.14, gain: 0.4 });
            tone({ freq: 1320, type: 'triangle', start: 0.12, dur: 0.22, gain: 0.4 });
        },
        // érkező belép: egyetlen rövid, tiszta pitty
        arrival() {
            tone({ freq: 1046, type: 'sine', dur: 0.09, gain: 0.45 });
        },
        // átrepülő belép: két mélyebb, tompa pitty
        transit() {
            tone({ freq: 523, type: 'sine', dur: 0.07, gain: 0.4 });
            tone({ freq: 523, type: 'sine', start: 0.11, dur: 0.07, gain: 0.4 });
        },
        // konfliktus: éles, gyors dupla sípolás
        conflict() {
            tone({ freq: 1400, type: 'square', dur: 0.07, gain: 0.22, filter: 3500 });
            tone({ freq: 1400, type: 'square', start: 0.12, dur: 0.07, gain: 0.22, filter: 3500 });
        },
        // sikeres leszállás / kilépés: halk, kellemes ding
        good() {
            tone({ freq: 1568, type: 'sine', dur: 0.5, gain: 0.22 });
            tone({ freq: 2093, type: 'sine', start: 0.04, dur: 0.4, gain: 0.1 });
        },
        // incidens: mély, reszelős zúgás
        incident() {
            tone({ freq: 140, freqEnd: 70, type: 'sawtooth', dur: 0.6, gain: 0.5, filter: 900 });
        },
        // vészhelyzet: szirénaszerű le-fel csúszás
        emergency() {
            tone({ freq: 600, freqEnd: 950, type: 'triangle', dur: 0.35, gain: 0.45 });
            tone({ freq: 950, freqEnd: 600, type: 'triangle', start: 0.35, dur: 0.35, gain: 0.45 });
            tone({ freq: 600, freqEnd: 950, type: 'triangle', start: 0.7, dur: 0.35, gain: 0.45 });
        },
        // zivatarmag felé tart: sürgető, magas–mély váltakozó riasztás
        stormWarn() {
            for (let i = 0; i < 3; i++) {
                tone({ freq: 1180, type: 'square', start: i * 0.22, dur: 0.1, gain: 0.25, filter: 3000 });
                tone({ freq: 780, type: 'square', start: i * 0.22 + 0.11, dur: 0.1, gain: 0.25, filter: 3000 });
            }
        },
        // eltérítés: mély–magas váltakozó duda, négyszer
        hijack() {
            for (let i = 0; i < 4; i++) {
                tone({ freq: 440, type: 'sawtooth', start: i * 0.3, dur: 0.14, gain: 0.3, filter: 2200 });
                tone({ freq: 660, type: 'sawtooth', start: i * 0.3 + 0.15, dur: 0.14, gain: 0.3, filter: 2200 });
            }
        },
        // hurrikán: mély, hosszan emelkedő-ereszkedő búgás
        hurricane() {
            tone({ freq: 90, freqEnd: 220, type: 'sawtooth', dur: 1.2, gain: 0.45, filter: 700 });
            tone({ freq: 220, freqEnd: 90, type: 'sawtooth', start: 1.2, dur: 1.2, gain: 0.45, filter: 700 });
        },
        // figyelmeztetés (zivatar, kifutózárás): lefelé lépő kettős hang
        warn() {
            tone({ freq: 523, type: 'triangle', dur: 0.16, gain: 0.4 });
            tone({ freq: 392, type: 'triangle', start: 0.17, dur: 0.24, gain: 0.4 });
        }
    };

    function play(name) {
        if (level === 'off' || !SOUNDS[name]) return;
        if (!ensure() || ac.state !== 'running') return;
        const now = performance.now();
        // ugyanaz a hang ne szóljon egymásra
        if (lastPlayed[name] && now - lastPlayed[name] < 350) return;
        lastPlayed[name] = now;
        SOUNDS[name]();
    }

    function cycle() {
        level = level === 'on' ? 'quiet' : level === 'quiet' ? 'off' : 'on';
        try { localStorage.setItem('legter-sound', level); } catch (e) { /* nem baj */ }
        if (master) master.gain.value = LEVELS[level];
        if (level !== 'off') play('depReminder');
        return level;
    }

    window.LegterSound = { play, cycle, level: () => level, names: Object.keys(SOUNDS) };
}());
