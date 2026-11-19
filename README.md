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

A szobagazda a lobbiban választ módot:

- **Saját reptér (2–3 fő)**: többrepteres pálya (London: Heathrow, Gatwick, London City · New York: JFK, Newark ·
  Washington: Dulles, Reagan National · Tokió: Haneda, Narita). Ahányan vagytok (legfeljebb 3), annyi reptér él,
  és mindenki csak a saját repterének gépeit irányítja.
- **Leszállás + felszállás (2 fő)**: egy reptér, az egyik játékos a leszállókért, a másik a felszállókért felel.
- **Szabad**: mindenki minden gépet irányíthat (legfeljebb 6 fő).
- **Szektoros**: a légteret szeletekre osztjuk, mindenki a saját szeletét kezeli (legfeljebb 6 fő).

A többiek a 4 betűs szobakóddal vagy a megosztott linkkel lépnek be.

## Események

- **Zivatar**: zöld és sárga rész átrepülhető, a piros magba repülés a műszak végét jelenti. 1% eséllyel hurrikán lesz belőle.
- **Köd**: a benne repülő gép egyenesen halad, és amíg ki nem ér, nem irányítható.
- **Vészhelyzet / kényszerleszállás**: 6 percen belül le kell szállnia. Kényszerleszállásnál amíg le nem száll,
  a repterén senki más nem szállhat le.
- **Eltérítés**: egy gép nem válaszol, és egy reptér felé fordul. Az **F** billentyűvel vadászgépeket indíthatsz:
  ha elfogják, a gép kényszerleszállást hajt végre (+25 pont). Ha eléri a repteret, vége a műszaknak.
- **Kifutó-ellenőrzés**: egy kifutót egy perc figyelmeztetés után néhány percre lezárnak.

Telefonon és tableten is játszható: koppintás, húzás, kétujjas nagyítás.

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
