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

A szobagazda a lobbiban beállítja a **létszámot** (1–3 fő; szabad és szektoros módban akár 6): **ahány fő, annyi reptér él
a pályán (legfeljebb 3)**, minden játékmódban. Minden pálya kap két közeli társrepteret:

| Pálya | Társrepterek |
| --- | --- |
| Budapest – Liszt Ferenc | Tököl, Budaörs |
| Bécs – Schwechat | Pozsony, Malacky |
| London – Heathrow | Gatwick, London City |
| Frankfurt am Main | Wiesbaden, Egelsbach |
| Prága – Václav Havel | Vodochody, Kbely |
| San Francisco | Oakland, San José |
| New York – JFK | LaGuardia, Newark |
| Chicago – O'Hare | Midway, DuPage |
| Atlanta – Hartsfield-Jackson | Peachtree, Fulton County |

- **Saját reptér (2–3 fő)**: mindenki csak a saját repterének gépeit irányítja.
- **Bevezető – Torony – Kivezető (2–3 fő)**: mint a valódi légiirányításban. A bevezető hozza be az érkezőket,
  a torony kezeli a reptér körüli zónát (felszállás, végső megközelítés, leszállás), a kivezető viszi ki az
  indulókat és az átrepülőket. A gép magától kerül át a következő irányítóhoz. Két főnél: Bevezető + Torony és Kivezető.
- **Érkező – Induló – Ügyeletes (2–3 fő)**: az érkező a leszállókat, az induló a felszállókat irányítja,
  az ügyeletes az átrepülőket és a különleges eseteket (vészhelyzet, kényszerleszállás, VIP gép).
- **Szabad**: mindenki minden gépet irányíthat (legfeljebb 6 fő).
- **Szektoros**: a légteret szeletekre osztjuk, mindenki a saját szeletét kezeli (legfeljebb 6 fő).

**Budapest (LHBP)** is választható: a két párhuzamos kifutó pontos adatai az OurAirports nyílt adatbázisából jönnek.

**Együttműködés:** jobb klikk (húzás nélkül), hosszú érintés vagy a **P** billentyű jelölést tesz a térképre, ami a
társaidnál is felvillan. A **gyorsüzenetek** („Vedd át!”, „Tartsd vissza az indulókat!” stb.) a kijelölt géphez kötve
mennek, a gép a társaidnál is kiemelődik.

**Visszacsatlakozás:** ha megszakad a net vagy frissíted az oldalt, a játék 90 másodpercig megtartja a helyed, és
automatikusan visszalép ugyanabba a szobába, ugyanazzal a poszttal.

A posztokat a lobbiban választjátok ki; ha egy poszt üres vagy ketten választották, a játék szól.
Játék közben a kijelölt gépnél **„Átadom neki”** gombbal átadhatod egy társadnak, vagy **„Átvétel kérése”**
gombbal elkérheted tőle; a másik fél elfogadja vagy elutasítja. Hárman a **„Közösbe (bárki)”** választással
bedobhatod a gépet a közösbe: mindenki megkapja a kérést, és aki elsőként elfogadja, azé lesz.

Ha két gép összeütközik, vége a műszaknak.

A többiek a 4 betűs szobakóddal vagy a megosztott linkkel lépnek be.

## Események

- **Zivatar**: zöld és sárga rész átrepülhető, a piros magba repülés a műszak végét jelenti. 1% eséllyel hurrikán lesz belőle.
- **Köd**: a benne repülő gép egyenesen halad, és amíg ki nem ér, nem irányítható.
- **Vészhelyzet / kényszerleszállás**: 6 percen belül le kell szállnia. Kényszerleszállásnál amíg le nem száll,
  a repterén senki más nem szállhat le.
- **Eltérítés**: egy gép nem válaszol, és egy reptér felé fordul. Az **F** billentyűvel vadászgépeket indíthatsz:
  ha elfogják, a gép kényszerleszállást hajt végre (+25 pont). Ha eléri a repteret, vége a műszaknak.
- **VIP (államfői) gép**: amíg le nem száll, a repterén minden kifutó zárva. 60 mp-en belül Gripen-kíséretet
  kell indítani (**F**); ha bárki túl közel repül hozzá, vége a műszaknak. Kísért leszállás: +30 pont.
- **Kifutó-ellenőrzés**: egy kifutót egy perc figyelmeztetés után néhány percre lezárnak.

## Fejlesztések

30 lekezelt gépenként vagy 8 percenként (amelyik előbb jön) értékelés jön: 3 fejlesztésből választhattok egyet,
ami a műszak végéig megmarad (multiban az egész csapaté).

| Fejlesztés | Hatás |
| --- | --- |
| Fürge szárnyak | 25%-kal gyorsabb fordulás, a várakozó körben is |
| Korai radar | a kialakuló konfliktust 5 mp-cel korábban, sárgán jelzi |
| Érkezési távköz | 3 mp-cel több idő két érkező között, zsúfolt légtérben még több |
| Gyors kigurulás | a leszálló gépek egyhatodával hamarabb hagyják el a kifutót |
| Korábbi átvétel | a belépő gép 6 mp-cel korábban jelzésként látszik a kapunál |
| Pontos sebesség | pontos sebesség adható meg az utazósebesség ±20%-án belül |
| Felszállási sor | foglalt kifutónál az induló sorba áll, és magától felszáll |
| Sorrendjelzés | várható földet érés, leszállási sorszám és távköz az előző géptől |
| Rugalmas kijárat | kétpercenként egy induló vagy átrepülő kijárata megváltoztatható |

A „Fejlesztések nélkül” szabály (×1.10) kikapcsolja az értékelést.

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
- **Budapest (LHBP)**, a **társrepterek** kifutói és a környékbeli rádióadók: [OurAirports](https://ourairports.com/data/), közkincs.
- **Háttértérkép** (szárazföld, vizek, folyók, utak, települések): [Natural Earth](https://www.naturalearthdata.com/), közkincs.
