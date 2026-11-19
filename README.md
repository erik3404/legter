# Légtér

Többjátékos, böngészős légiirányító játék. A gépeket egérrel vezeted: útpontokat raksz le, kifutót jelölsz ki,
felszállást engedélyezel, és a gépeket a megfelelő kapun (A–F) küldöd ki a légtérből.

## Futtatás

Node.js 18 vagy újabb kell hozzá.

```bash
npm install
```

```bash
npm start
```

Ezután nyisd meg a http://localhost:3000 címet. Ha többen játszotok, mindenkinek ugyanazt a szervert kell elérnie
(helyi hálózaton a gép IP-címe, vagy egy tárhelyre telepítve, például Render vagy Railway).

## Nyilvános szerverre telepítés (Render)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/erik3404/legter)

1. Lépj be a [render.com](https://render.com) oldalon a GitHub-fiókoddal.
2. Kattints a fenti gombra, vagy válaszd a **New → Blueprint** menüpontot, és add meg ezt a repót.
   A beállításokat a `render.yaml` tartalmazza (ingyenes csomag, Node 22, állapot-ellenőrzés a `/healthz` címen).
3. Az **Apply** után néhány perc, és kapsz egy `https://legter-xxxx.onrender.com` címet. Ezt küldd el a barátaidnak.

Minden `main` ágra feltöltött módosítás után a Render magától újratelepít.

Az ingyenes csomag tudnivalói:

- Ha egy ideig senki nem használja, a szerver elalszik, és az első megnyitás kb. fél–egy percig tölt.
- Újraindításkor vagy elalváskor a futó szobák elvesznek (adatbázis nincs, minden a memóriában van).

Bármilyen más Node-tárhelyen is fut: a `PORT` környezeti változón figyel, a WebSocket a `/ws` útvonalon van.

## Multi módok

- **Szabad**: mindenki minden gépet irányíthat, a pontszám közös.
- **Szektoros**: a légteret szeletekre osztjuk, mindenki a saját szeletét kezeli. A reptér körüli torony-zóna közös,
  és ha egy gép átrepül a szomszéd szektorba, automatikusan oda kerül.
- **Repteres (Fel/Le)**: szerepeket osztotok ki. Az *induló* a felszállókat, az *érkező* a leszállókat irányítja,
  az átrepülőket mindenki.

A szobagazda választja a repteret, a módot és a forgalmat, és ő indítja a műszakot. A többiek a 4 betűs
szobakóddal vagy a megosztott linkkel lépnek be.

## Irányítás

| Billentyű | Funkció |
| --- | --- |
| Kattintás a gépre | kijelölés |
| Kattintás üres helyre | útpont (a legkisebb kerülőt jelentő helyre kerül) |
| Kattintás / húzás útponton | törlés / áthelyezés |
| Shift + kattintás | útvonal cseréje |
| Shift + kattintás a kifutó számán | üzemi irány megfordítása |
| 1–9 | kifutó kiválasztása |
| X | felszállás |
| R | várakozó körözés |
| G | átstartolás |
| W / S | sebesség ±10 csomó (Shift: max/min) |
| C / D, ↑ / ↓ | magasság ±1000 láb (Shift: max/min) |
| Tab, N | következő induló / légtérben lévő gép |
| Szóköz | szünet (szobagazda) |

## Felépítés

- `server/index.js`: HTTP- és WebSocket-szerver, szobák, jogosultság-ellenőrzés. A szimuláció a szerveren fut.
- `shared/sim.js`: a játék szimulációja (mozgás, megközelítés, elkülönítés, pontozás).
- `shared/rules.js`: a multi módok jogosultsági szabályai (szerveren és böngészőben is fut).
- `public/`: a böngészős kliens (radar, egér és billentyűzet, lobby).
- `tools/`: a reptér- és térképadatok előállítása.

Tesztek:

```bash
npm test
```

## Források és licencek

A játék kódja saját, MIT licenc alatt áll (lásd `LICENSE`).

- **Reptéradatok** (kifutók koordinátái, fixpontok, terepmagasság): az [openScope](https://github.com/openscope/openscope)
  projektből, MIT licenc, © openScope contributors. Lásd `THIRD_PARTY_NOTICES.md`.
- **Háttértérkép** (szárazföld, vizek, folyók, utak, települések): [Natural Earth](https://www.naturalearthdata.com/), közkincs.
