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
