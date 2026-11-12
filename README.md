# Ship Transfer

Website ya **Ship Transfer** — mfumo wa amana (deposit), utoaji (withdraw), uwekezaji wa
VIP packages, historia ya muamala na mialiko ya marafiki. Mtumiaji anajisajili kwa jina,
namba ya simu, barua pepe na neno la siri, kisha anaingia moja kwa moja kwenye dashboard.

## Vipengele

- **Usajili na kuingia** — jina kamili, namba ya simu (+255), barua pepe, neno la siri.
  Neno la siri huhifadhiwa kwa `scrypt` (hash + salt), hakuna kinachohifadhiwa kama maandishi wazi.
- **Dashboard** — salio, faida jumla, uwekezaji hai, maombi yanayosubiri, historia ya karibuni.
- **Deposit** — ombi la amana kupitia M-Pesa, Mixx by Yas, Airtel Money, HaloPesa au benki.
  Amana inaingia kwenye salio baada ya uthibitisho wa msimamizi.
- **Withdraw** — ombi la utoaji; kiasi hukatiwa salio mara moja na hurudishwa likikataliwa.
- **Invest (VIP packages)** — VIP 1 hadi VIP 5, faida ya kila siku 1.5%–3.5% kwa siku 30.
  Faida huhesabiwa na kuwekwa kwenye salio kila siku.
- **History** — kila amana, utoaji, uwekezaji, faida na bonasi, na vichujio.
- **Invite friends** — kodi ya mwaliko na kiungo cha kushiriki; bonasi TZS 2,000 kwa kila rafiki.
- **Admin** — ukurasa wa msimamizi wa kuthibitisha au kukataa maombi ya amana na utoaji.

## Teknolojia

- Node.js + Express 5 (API na kuhudumia faili tuli)
- HTML/CSS/JavaScript ya kawaida (hakuna hatua ya ku-build ya frontend)
- Hifadhi ya data: faili moja la JSON (`data/db.json`)

## Kuanzisha kienyeji

```bash
npm install
npm start          # http://localhost:3000
npm test           # majaribio ya API
npm run build      # ukaguzi wa muundo wa mradi
```

## Mipangilio (environment variables)

| Jina | Maelezo |
| --- | --- |
| `PORT` | Bandari ya seva (chaguo-msingi `3000`) |
| `DATA_DIR` | Folda ya hifadhi ya data (chaguo-msingi `./data`) |
| `ADMIN_EMAIL` | Barua pepe ya msimamizi (chaguo-msingi `admin@shiptransfer.co.tz`) |
| `ADMIN_PASSWORD` | Neno la siri la msimamizi — **badilisha kabla ya matumizi halisi** |

Akaunti ya msimamizi huundwa mara ya kwanza tu. Baada ya kuweka `ADMIN_EMAIL` na
`ADMIN_PASSWORD` kwenye Settings → Environment variables, msimamizi anaweza kuingia na
kuona kipengele cha "Msimamizi" kwenye menyu.

## Muundo wa mradi

```
server.js            kiingilio cha seva (0.0.0.0:$PORT)
src/app.js           API ya Express na huduma ya faili tuli
src/domain.js        mantiki ya amana, utoaji, uwekezaji, faida na mialiko
src/auth.js          hash ya neno la siri (scrypt) na session
src/db.js            hifadhi ya JSON yenye uandishi salama
src/constants.js     VIP packages, viwango vya chini na njia za malipo
public/              UI (index.html, styles.css, app.js)
tests/               majaribio ya API (node --test)
scripts/build.js     ukaguzi wa muundo kabla ya kupeleka mtandaoni
```

## Tahadhari

Hifadhi ya data ni faili la JSON kwenye diski ya kontena. Kwenye mpango wa Free
hakuna diski ya kudumu, hivyo data inaweza kuanza upya kila mara app inapopangwa upya.
Kwa matumizi halisi unahitaji database ya kudumu (mfano PostgreSQL) pamoja na
uthibitisho wa malipo kutoka kwa watoa huduma za malipo.
