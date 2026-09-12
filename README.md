# Assistenza Tecnica IVD

Gestionale per assistenza tecnica IVD (clienti, interventi, appuntamenti, ricambi, bolle e D.D.T.), impacchettato come app desktop con [Electron](https://www.electronjs.org/).

L'applicazione vera e propria è interamente contenuta in [`index.html`](index.html) (un unico file, dati salvati in locale su IndexedDB/localStorage con sincronizzazione cloud opzionale su Supabase). `main.js` e `package.json` sono solo l'involucro Electron che la fa girare come app nativa su Mac e Windows.

> **Nota**: l'app carica alcune librerie (Dexie, XLSX, jsPDF, pdf.js, Supabase) da CDN. Serve una connessione internet al primo avvio (e per la sincronizzazione cloud); il resto — dati, interventi, stampe — funziona anche offline una volta caricate.

## Sviluppo locale

Serve [Node.js](https://nodejs.org/) (versione 20 o superiore).

```bash
npm install
npm start
```

## Creare gli installer

```bash
npm run dist:mac   # .dmg + .zip per macOS (Intel e Apple Silicon)
npm run dist:win   # .exe (installer NSIS) + versione portable per Windows
npm run dist:all   # entrambi (richiede gli strumenti di build della piattaforma ospite)
```

Gli installer vengono generati nella cartella `dist_electron/`.

**Nota bene**: per compilare per Windows serve un Mac o Linux con Wine, e per compilare un `.dmg` macOS firmato serve un Mac — per questo la build "vera" per entrambe le piattaforme avviene su GitHub Actions (vedi sotto), che usa runner nativi per ciascun sistema.

Le build generate **non sono firmate digitalmente** (serve un certificato sviluppatore Apple/Windows a pagamento). Questo significa che:
- su **macOS**, aprendo l'app per la prima volta va fatto clic destro → "Apri" (invece del doppio clic) per bypassare Gatekeeper;
- su **Windows**, Defender SmartScreen mostrerà un avviso — cliccare "Ulteriori informazioni" → "Esegui comunque".

## Build automatica su GitHub

Il workflow [`.github/workflows/build.yml`](.github/workflows/build.yml) compila l'app per **macOS e Windows** automaticamente su GitHub, usando runner nativi per ciascuna piattaforma (nessuna cross-compilazione).

**Per scaricare una build senza creare una release**: dalla tab *Actions* del repository, apri "Build desktop app" → *Run workflow*. A fine build, gli installer sono scaricabili come artifact dalla pagina della run.

**Per pubblicare una release con gli installer allegati**: crea e pubblica un tag di versione, es.

```bash
git tag v2.9.4
git push origin v2.9.4
```

Il workflow compila entrambe le piattaforme e crea una **bozza di release** su GitHub con gli installer allegati (`.dmg`, `.zip`, `.exe`) — resta da rivedere e pubblicare manualmente dalla tab *Releases*.

## Struttura del progetto

```
index.html   ← l'applicazione (tutto il codice vive qui)
main.js      ← finestra Electron che carica index.html
package.json ← dipendenze e configurazione electron-builder
.github/workflows/build.yml ← build automatica Mac + Windows
```
