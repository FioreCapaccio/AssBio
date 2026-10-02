const { app, BrowserWindow, Menu, shell, session, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

// URL dell'app (file://.../index.html): unica pagina che la finestra principale ha il
// diritto di caricare. Usato per l'allowlist di navigazione.
const APP_URL = require('url').pathToFileURL(path.join(__dirname, 'index.html')).toString();

// ============================================================================
// ARCHIVIO LOCALE SU CARTELLA (dati/ con JSON per tabella + backups/ a rotazione)
// Il renderer (sandboxato) ci arriva SOLO via IPC con canali stretti: nessun percorso
// passa dal renderer, i nomi file sono validati da whitelist e le scritture vengono
// serializzate in una coda (mai write concorrenti).
// ============================================================================
const FILE_WHITELIST = [
  'clienti.json', 'interventi.json', 'ricambi.json', 'fornitori.json',
  'bolle.json', 'ordini.json', 'inventari.json', 'appuntamenti.json', 'meta.json'
];
const BACKUP_KEEP = 5;

function leggiConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
  } catch { return {}; }
}

function salvaConfig(cfg) {
  try {
    const p = path.join(app.getPath('userData'), 'config.json');
    fs.writeFileSync(p + '.tmp', JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    console.warn('[Archivio] Impossibile salvare config.json:', e.message);
  }
}

// Ordine di risoluzione: variabile d'ambiente → scelta utente salvata → default Documenti/Assistenza Tecnica IVD
function risolviCartellaDati() {
  if (process.env.IVD_DATA_DIR) return process.env.IVD_DATA_DIR;
  const cfg = leggiConfig();
  if (cfg.cartellaDati) return cfg.cartellaDati;
  return path.join(app.getPath('documents'), 'Assistenza Tecnica IVD');
}

let cartellaDati = null;
// La cartella dei backup automatici è indipendente dall'archivio dati: se l'utente non la
// imposta esplicitamente (cartellaBackupOverride resta null) segue l'archivio come prima
// (sottocartella "backups" dentro cartellaDati) — se la imposta (es. un disco esterno), resta
// lì anche se in seguito l'archivio dati viene spostato altrove.
let cartellaBackupOverride = null;
function cartellaBackupAttuale() {
  return cartellaBackupOverride || path.join(cartellaDati, 'backups');
}

function percorsi() {
  return {
    root: cartellaDati,
    dati: path.join(cartellaDati, 'dati')
  };
}

async function assicuraCartelle() {
  await scriviConTimeout(fsp.mkdir(percorsi().dati, { recursive: true }));
  await scriviConTimeout(fsp.mkdir(cartellaBackupAttuale(), { recursive: true }));
}

// Coda di scrittura: le richieste IPC arrivano in ordine e vengono eseguite una alla volta.
let _writeQueue = Promise.resolve();
function inCoda(fn) {
  const p = _writeQueue.then(fn);
  _writeQueue = p.catch(() => {}); // la coda prosegue anche se una scrittura fallisce
  return p;
}

// Ogni richiesta "archivio:scrivi" porta una FOTOGRAFIA COMPLETA degli archivi: se mentre una
// scrittura è in corso ne arrivano altre, quelle intermedie sono già superate dall'ultima.
// Prima venivano accodate tutte (e ogni salvataggio riscrive tutti i file, PDF in base64
// compresi): con più salvataggi ravvicinati la coda si allungava e il dato più recente
// arrivava su disco con grande ritardo — o non faceva in tempo ad arrivarci prima della
// chiusura dell'app. Ora le richieste ancora in attesa si fondono in UNA scrittura che
// contiene, per ogni file, il contenuto più recente; chi aspettava riceve l'esito comune.
let _scritturaInAttesa = null;
function scriviArchivioRaggruppato(payload) {
  return new Promise((resolve, reject) => {
    if (_scritturaInAttesa) {
      Object.assign(_scritturaInAttesa.payload, payload);
      _scritturaInAttesa.waiters.push({ resolve, reject });
      return;
    }
    const giro = { payload: { ...payload }, waiters: [{ resolve, reject }] };
    _scritturaInAttesa = giro;
    inCoda(async () => {
      _scritturaInAttesa = null; // da qui in poi le nuove richieste formano il giro successivo
      try {
        await assicuraCartelle();
        const { dati } = percorsi();
        for (const nome of Object.keys(giro.payload)) {
          await scriviFileAtomico(path.join(dati, nome), giro.payload[nome]);
        }
        const esito = { ok: true, scritti: Object.keys(giro.payload) };
        giro.waiters.forEach(w => w.resolve(esito));
      } catch (e) {
        giro.waiters.forEach(w => w.reject(e));
      }
    });
  });
}

async function scriviFileAtomico(filePath, content) {
  const tmp = filePath + '.tmp';
  await scriviConTimeout(fsp.writeFile(tmp, content, 'utf8'));
  await scriviConTimeout(fsp.rename(tmp, filePath));
}

// Timeout sulle operazioni disco: se la cartella archivio risiede in un percorso gestito
// da una sincronizzazione (es. Documenti con iCloud Drive) read/write/rename possono
// BLOCCARSI per tempo indefinito (download di file evitti, sync in corso). Senza timeout
// l'attesa è silenziosa e infinita: il renderer resta "non caricato" e TUTTI i salvataggi
// vengono rinviati per sempre senza alcun errore visibile. Con il timeout l'operazione
// fallisce subito, il renderer avvisa l'utente e riprova.
function conTimeout(promessa, ms, operazione) {
  return Promise.race([
    promessa,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${Math.round(ms / 1000)}s) sull'operazione "${operazione}" — la cartella archivio non ha risposto in tempo (disco esterno/di rete lento, cartella sincronizzata — iCloud/Dropbox/OneDrive — ancora in corso, o semplicemente disco occupato)`)), ms))
  ]);
}
const OP_TIMEOUT_MS = 30000;

function leggiFileConTimeout(p) { return conTimeout(p, OP_TIMEOUT_MS, 'lettura'); }
function scriviConTimeout(p) { return conTimeout(p, OP_TIMEOUT_MS, 'scrittura'); }

function registraCanaliArchivio() {
  cartellaDati = risolviCartellaDati();
  cartellaBackupOverride = leggiConfig().cartellaBackup || null;

  // Dopo un confirm()/alert() nativo, in Electron la finestra può restare senza il focus di
  // tastiera: i campi sembrano normali ma non accettano più la digitazione ("campi bloccati")
  // finché non si cambia finestra. Il renderer chiama questo canale subito dopo ogni dialogo.
  ipcMain.handle('finestra:ripristinaFocus', (event) => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w || w.isDestroyed()) return false;
    if (!w.isFocused()) w.focus();
    w.webContents.focus();
    return true;
  });

  ipcMain.handle('archivio:info', async () => {
    await assicuraCartelle();
    const { dati } = percorsi();
    const backups = cartellaBackupAttuale();
    const elenca = async (dir) => (await fsp.readdir(dir).catch(() => []))
      .filter(f => f.endsWith('.json') && !f.endsWith('.tmp')).sort();
    return {
      dir: cartellaDati,
      dirBackup: backups,
      fileDati: await elenca(dati),
      backups: await elenca(backups)
    };
  });

  ipcMain.handle('archivio:leggiTutto', async () => {
    const { dati } = percorsi();
    const files = {};
    for (const nome of FILE_WHITELIST) {
      try {
        files[nome] = await leggiFileConTimeout(fsp.readFile(path.join(dati, nome), 'utf8'));
      } catch (e) {
        // File assente (primo avvio): chiave omessa — è un caso normale.
        // QUALSIASI altro errore (soprattutto timeout su cartella non raggiungibile)
        // fa FALLIRE tutto il canale: il renderer deve saper distinguere "cartella
        // vuota" (può migrarci i dati) da "cartella che non risponde" (non toccarla mai,
        // sovrascriverla con dati più vecchi sarebbe una perdita silenziosa).
        if (e && e.code === 'ENOENT') continue;
        throw e;
      }
    }
    return { dir: cartellaDati, files };
  });

  ipcMain.handle('archivio:scrivi', (event, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Payload non valido');
    }
    for (const nome of Object.keys(payload)) {
      if (!FILE_WHITELIST.includes(nome)) throw new Error('Nome file non consentito: ' + nome);
      if (typeof payload[nome] !== 'string') throw new Error('Contenuto non valido per ' + nome);
    }
    return scriviArchivioRaggruppato(payload);
  });

  // Snapshot completo dell'archivio scritto dal renderer (che possiede i dati) con
  // rotazione gestita qui: tengo gli ultimi BACKUP_KEEP file. Scrive nella cartella di
  // backup corrente, che può essere indipendente dall'archivio dati (vedi cartellaBackupAttuale).
  ipcMain.handle('archivio:backupSnapshot', (event, contenuto) => inCoda(async () => {
    if (typeof contenuto !== 'string' || contenuto.length < 2) throw new Error('Snapshot non valido');
    await assicuraCartelle();
    const backups = cartellaBackupAttuale();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await scriviFileAtomico(path.join(backups, `ivd-backup-${ts}.json`), contenuto);
    const tutti = (await fsp.readdir(backups).catch(() => []))
      .filter(f => f.startsWith('ivd-backup-') && f.endsWith('.json'))
      .sort();
    for (const vecchio of tutti.slice(0, Math.max(0, tutti.length - BACKUP_KEEP))) {
      await fsp.rm(path.join(backups, vecchio), { force: true }).catch(() => {});
    }
    return { ok: true, nome: `ivd-backup-${ts}.json`, tenuti: Math.min(tutti.length + 1, BACKUP_KEEP) };
  }));

  ipcMain.handle('archivio:apriCartella', async () => {
    await assicuraCartelle();
    shell.openPath(cartellaDati);
    return { ok: true };
  });

  // Cambia la posizione dell'archivio per le prossime sessioni. NON copia i dati:
  // la copia è voluta separata (archivio:sposta) perché è un'operazione più rischiosa.
  ipcMain.handle('archivio:scegliCartella', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Scegli la cartella dell\'archivio Assistenza Tecnica IVD',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const cfg = leggiConfig();
    cfg.cartellaDati = res.filePaths[0];
    salvaConfig(cfg);
    cartellaDati = cfg.cartellaDati;
    await assicuraCartelle();
    return { ok: true, dir: cartellaDati };
  });

  // Copia dati/ dalla cartella corrente verso `destinazione`, poi la rende l'archivio attivo
  // per le prossime scritture. La cartella di backup NON viene toccata se è stata impostata
  // esplicitamente dall'utente (cartellaBackupOverride) — è indipendente per definizione;
  // se invece segue ancora l'archivio (default), viene copiata insieme così non resta
  // "orfana" nella vecchia posizione.
  const spostaVerso = async (destinazione) => {
    if (destinazione === cartellaDati) return { ok: false, errore: 'Cartella identica a quella attuale' };

    const vecchiDati = percorsi().dati;
    const vecchiBackup = cartellaBackupAttuale();
    const backupSeguivaArchivio = !cartellaBackupOverride;

    const copiaDir = async (da, verso) => {
      await fsp.mkdir(verso, { recursive: true });
      let n = 0;
      for (const f of await fsp.readdir(da).catch(() => [])) {
        if (!f.endsWith('.json')) continue;
        await fsp.copyFile(path.join(da, f), path.join(verso, f)).catch(() => {});
        n++;
      }
      return n;
    };
    const nDati = await copiaDir(vecchiDati, path.join(destinazione, 'dati'));
    const nBk = backupSeguivaArchivio ? await copiaDir(vecchiBackup, path.join(destinazione, 'backups')) : 0;

    const cfg = leggiConfig();
    cfg.cartellaDati = destinazione;
    salvaConfig(cfg);
    cartellaDati = destinazione;
    await assicuraCartelle();
    return { ok: true, dir: destinazione, copiati: nDati + nBk };
  };

  // Sposta l'archivio dati corrente nella cartella scelta, poi usa quella.
  ipcMain.handle('archivio:sposta', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Sposta l\'archivio in una nuova cartella',
      properties: ['openDirectory', 'createDirectory']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    return spostaVerso(res.filePaths[0]);
  });

  // Imposta la cartella dei BACKUP automatici (indipendente dall'archivio dati), con un
  // percorso digitato/incollato a mano dall'utente in Impostazioni invece che scelto tramite
  // il selettore di sistema — utile per un disco esterno o una cartella cloud già nota. Il
  // renderer è sandboxato e non fidato per percorsi di filesystem (vedi nota in preload.js):
  // il valore ricevuto è sempre trattato come testo grezzo e validato — mai interpolato in
  // comandi di shell, mai usato per altro che chiamate dirette a fs/path — prima di
  // accettarlo come nuova destinazione.
  ipcMain.handle('archivio:impostaCartellaBackup', async (event, percorsoGrezzo) => {
    if (typeof percorsoGrezzo !== 'string') return { ok: false, errore: 'Percorso non valido' };
    const percorso = percorsoGrezzo.trim();
    if (!percorso) return { ok: false, errore: 'Inserisci un percorso' };
    if (!path.isAbsolute(percorso)) {
      return { ok: false, errore: 'Il percorso deve essere assoluto (es. ' + (process.platform === 'win32' ? 'C:\\Cartella\\Backup' : '/Users/nome/Cartella') + ')' };
    }
    const destinazione = path.resolve(percorso);
    if (destinazione === cartellaBackupAttuale()) return { ok: false, errore: 'Cartella identica a quella attuale' };
    try {
      await fsp.mkdir(destinazione, { recursive: true });
      await fsp.access(destinazione, fs.constants.W_OK);
    } catch (e) {
      return { ok: false, errore: 'Cartella non raggiungibile o non scrivibile: ' + (e.message || e) };
    }
    const vecchia = cartellaBackupAttuale();
    let spostati = 0;
    for (const f of await fsp.readdir(vecchia).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      await fsp.copyFile(path.join(vecchia, f), path.join(destinazione, f)).catch(() => {});
      spostati++;
    }
    const cfg = leggiConfig();
    cfg.cartellaBackup = destinazione;
    salvaConfig(cfg);
    cartellaBackupOverride = destinazione;
    return { ok: true, dir: destinazione, spostati };
  });
}

// ============================================================================
// PORTALE MERCK (scarico chiamate/WO → appuntamenti)
// Sessione PERSISTENTE separata ('persist:merck'): i cookie sopravvivono ai
// riavvii, così il login va rifatto solo quando il portale invalida la sessione.
// Le credenziali NON transitano in chiaro nell'app: l'utente può salvarle nelle
// Impostazioni (cifrate con safeStorage del sistema operativo — Keychain/DPAPI)
// e vengono usate SOLO per compilare automaticamente la pagina di login del
// portale quando la sessione è scaduta; senza credenziali il login resta manuale.
// La password del portale ruota ogni ~3 mesi: si aggiorna dalla card Impostazioni.
// ============================================================================
const MERCK_PARTITION = 'persist:merck';
let merckFinestraLogin = null;
let merckAutofillTimer = null;
// Stato dell'accesso al portale, mostrato dal pulsante "Merck" in alto nell'app:
// 'inattivo' | 'accesso' (login in corso in background) | 'connesso' | 'manuale' (serve la
// finestra: nessuna credenziale salvata o intervento richiesto) | 'errore'.
let merckStato = { stato: 'inattivo', dettaglio: '' };
let merckUltimaDiagnostica = '';
let merckMonitor = null; // { timer, fine } del controllo esito accesso in corso

// User-Agent standard da Chrome desktop invece di quello di default di Electron (che
// contiene la sottostringa "Electron/x.y.z"): molti portali aziendali — Salesforce
// Experience Cloud/Community incluso — hanno politiche di sicurezza che riconoscono e
// bloccano i login da client non standard/automatizzati, mostrando un generico "login
// attempt failed" anche con credenziali corrette (confermato: le stesse credenziali
// funzionano da un browser normale ma falliscono anche digitandole a mano dentro questa
// sessione). Usa la versione di Chromium realmente imbarcata in questa build di Electron,
// così resta coerente con le funzionalità JS effettivamente disponibili.
function merckUserAgentStandard() {
  const chromeVer = process.versions.chrome || '130.0.0.0';
  const piattaforma = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
    : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${piattaforma}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`;
}

let _merckUaImpostato = false;
function merckSessione() {
  const ses = session.fromPartition(MERCK_PARTITION);
  if (!_merckUaImpostato) {
    ses.setUserAgent(merckUserAgentStandard());
    _merckUaImpostato = true;
  }
  return ses;
}

function validaUrlPortale(urlGrezzo) {
  if (typeof urlGrezzo !== 'string') return null;
  const t = urlGrezzo.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  try { return new URL(t).toString(); } catch { return null; }
}

// Euristiche per riconoscere una pagina di login (sessione scaduta o mai effettuata)
function paginaDiLogin(html) {
  if (typeof html !== 'string' || !html) return true;
  const h = html.slice(0, 400000).toLowerCase();
  const haPassword = /<input[^>]+type=["']password["']/.test(h);
  const indiziLogin = /log\s?in|sign\s?in|accedi|autenticazione|password/.test(h);
  return haPassword && indiziLogin;
}

// Credenziali salvate: decifrate SOLO qui nel main, mai inviate al renderer.
// Pulizia anti copia-incolla: accapo/invii a capo e caratteri zero-width in coda
// (tipici quando la password viene incollata da una mail/password manager) rendono
// le credenziali "sbagliate" sul portale pur sembrando identiche. Si tolgono \r\n\t
// ai bordi e gli zero-width ovunque; gli SPAZI restano toccati solo ai bordi estremi
// tramite trim (una password con spazi interni resta intatta).
function merckCredenziali() {
  const cfg = leggiConfig();
  if (!cfg.merck || !cfg.merck.passEnc) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const passwordPulita = safeStorage.decryptString(Buffer.from(cfg.merck.passEnc, 'base64'))
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/^[\r\n\t]+/, '')
      .replace(/[\r\n\t]+$/, '')
      .trim();
    return {
      user: String(cfg.merck.user || '').trim(),
      password: passwordPulita,
      aggiornataIl: cfg.merck.aggiornataIl || null
    };
  } catch { return null; }
}

// Raccoglie TUTTE le radici di query della pagina: documento, iframe same-origin e —
// fondamentale per i portali Salesforce Lightning (LWC) — tutti gli SHADOW DOM aperti.
// La pagina di login del portale Merck (c-community-login-form) ha ZERO input nel
// documento piatto: username/password/checkbox vivono tutti dentro lo shadow root.
const MERCK_COLLEZIONA_RADICI = `
  const radici = [];
  const raccogli = (root, w) => {
    radici.push(root);
    try {
      [...root.querySelectorAll('iframe')].forEach(f => {
        try { if (f.contentDocument) raccogli(f.contentDocument, f.contentWindow); } catch (e) {}
      });
    } catch (e) {}
    try {
      [...root.querySelectorAll('*')].forEach(el => { if (el.shadowRoot) raccogli(el.shadowRoot, el.shadowRoot); });
    } catch (e) {}
  };
  raccogli(document, window);
  const visibile = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
  const selUser = 'input[type=email], input[name*=user i], input[name*=email i], input[name*=login i], input[name*=account i], input[id*=user i], input[id*=email i], input[id*=login i], input[type=text], input:not([type])';
  const cercaCoppia = () => {
    for (const root of radici) {
      const p = [...root.querySelectorAll('input[type=password]')].find(visibile);
      if (!p) continue;
      const u = [...root.querySelectorAll(selUser)].find(el => visibile(el) && el !== p);
      return { root, p, u };
    }
    return null;
  };
`;

// Check per pagina (documento + iframe + shadow DOM): c'è un campo password visibile?
// (usato da merckScaricaRenderizzato per capire se serve il login)
const MERCK_CHECK_SCRIPT = `(() => {
  ${MERCK_COLLEZIONA_RADICI}
  const coppia = cercaCoppia();
  return { haPassword: !!coppia, userVuoto: !!(coppia && coppia.u && !coppia.u.value), passVuota: !!(coppia && !coppia.p.value) };
})()`;

// Serializza documento + iframe + TUTTI gli shadow DOM aperti in testo leggibile, per
// calibrare l'autofill su un portale reale. Un semplice outerHTML del documento non basta:
// per costruzione il contenuto degli shadow DOM non viene mai incluso nella serializzazione
// del documento che li ospita (è l'intero scopo dello shadow DOM) — su un form come
// c-community-login-form, che non ha ALCUN input nel documento piatto, un outerHTML normale
// risulterebbe un guscio vuoto. Le password visibili vengono mascherate prima di esportare.
const MERCK_SERIALIZZA_RADICI = `(() => {
  ${MERCK_COLLEZIONA_RADICI}
  return radici.map((root) => {
    const titolo = root === document ? 'DOCUMENTO PRINCIPALE'
      : (root.host ? 'SHADOW ROOT di <' + root.host.tagName.toLowerCase() + (root.host.id ? ('#' + root.host.id) : '') + '>'
      : 'ALTRO (iframe)');
    const contenitore = root.body || root;
    [...contenitore.querySelectorAll('input[type=password]')].forEach(p => { if (p.value) p.setAttribute('value', '••••••••'); });
    return '=== ' + titolo + ' ===\\n' + (contenitore.innerHTML || '');
  }).join('\\n\\n');
})()`;

// Inoltra alla finestra principale (card "Portale Merck" in Impostazioni) l'ultimo esito
// del tentativo di autofill, così l'utente vede DAL VIVO cosa sta succedendo durante il
// login — senza questo, nel pacchetto di produzione (niente Toggle Developer Tools) un
// fallimento restava visibile solo nei log della console del processo main, che l'utente
// non può aprire. Fondamentale per capire SE il problema è "non trovo i campi di login su
// questo portale" (selettori da adattare) oppure "campi trovati ma le credenziali salvate
// vengono rifiutate" (password da aggiornare, account bloccato dal portale, ecc.).
// BUG FIX: la card di Impostazioni resta nella finestra PRINCIPALE, nascosta dietro il
// popup di login quando l'utente ci sta effettivamente guardando — risultato, il messaggio
// c'era ma restava invisibile all'utente concentrato sul popup. Se `win` (la finestra di
// login/scarico in corso) è passata, viene mostrato un banner anche lì, sopra la pagina del
// portale: impossibile non vederlo.
function merckInviaDiagnostica(messaggio, win) {
  console.log('[Merck]', messaggio);
  merckUltimaDiagnostica = String(messaggio);
  try {
    if (finestraPrincipale && !finestraPrincipale.isDestroyed()) {
      finestraPrincipale.webContents.send('merck:diagnostica', messaggio);
    }
  } catch { /* finestra principale non pronta: solo log console */ }
  if (win && !win.isDestroyed()) {
    const testoJson = JSON.stringify(String(messaggio));
    win.webContents.executeJavaScript(`(() => {
      let el = document.getElementById('__ivd_merck_diag__');
      if (!el) {
        el = document.createElement('div');
        el.id = '__ivd_merck_diag__';
        el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#0d9488;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;padding:10px 16px;box-shadow:0 -2px 10px rgba(0,0,0,.35);';
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = '🔎 Assistenza Tecnica IVD — ' + ${testoJson};
    })()`, true).catch(() => {});
  }
}

// Click REALE (eventi mouse fidati) alle coordinate viewport indicate: i componenti
// Salesforce Lightning (LWC) reagiscono come a un vero utente.
function clickReale(win, x, y) {
  const px = Math.round(x), py = Math.round(y);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
}

// Auto-compilazione "come un umano": localizza i campi (documento/iframe/shadow DOM),
// porta il focus su ciascuno e inserisce il testo con webContents.insertText, che genera
// EVENTI FIDATI identici alla digitazione — è la differenza decisiva rispetto al riempimento
// via JavaScript: Lightning registra lo stato interno solo con eventi fidati, altrimenti
// il form si invia con i valori "non visti" dal componente e il server risponde
// "username o password non corretti" pur essendo giusti. La checkbox di accettazione
// (es. "I accept … Terms of Use" su maestro.my.site.com, senza cui Sign In resta DISABLED)
// viene premuta con un vero click del mouse alle sue coordinate. Il bottone si preme solo
// quando il portale lo ha abilitato, con coordinate fresche (tick successivo al click sulla
// spunta: il click può far comparire messaggi e spostare il layout).
async function merckProvaAutofill(win, credenziali) {
  const esito = { trovato: false, userInserito: false, passInserita: false, spuntaMessa: false, submitted: false, userOk: null, passOk: null };
  if (!win || win.isDestroyed()) return esito;
  try {
    const stato = await win.webContents.executeJavaScript(`(() => {
      ${MERCK_COLLEZIONA_RADICI}
      const coppia = cercaCoppia();
      if (!coppia) return { trovato: false };
      const { root, p, u } = coppia;
      const misura = (el) => {
        if (!el) return null;
        try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, valore: el.value || '', visibile: el.offsetParent !== null };
      };
      const checkboxes = [...root.querySelectorAll('input[type=checkbox]')].filter(c => c.offsetParent !== null);
      const chk = checkboxes.find(c => /agre|accept|terms|privacy|consen|condiz|gdpr/i.test((c.id || '') + ' ' + (c.name || '')))
        || (checkboxes.length === 1 ? checkboxes[0] : null);
      const btn = [...root.querySelectorAll('button, input[type=submit]')].find(b => (b.offsetParent !== null) && (b.type === 'submit' || /log\\s?in|sign\\s?in|accedi|accesso|invia|submit|continua|conferma|entra/i.test(((b.id || '') + ' ' + (b.name || '') + ' ' + (b.value || '') + ' ' + (b.textContent || '')))));
      const btnR = btn ? (() => { try { btn.scrollIntoView({ block: 'center' }); } catch (e) {} const r = btn.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: btn.disabled }; })() : null;
      return {
        trovato: true,
        user: misura(u), pass: misura(p),
        chk: chk ? (() => { const r = chk.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, checked: chk.checked }; })() : null,
        btn: btnR
      };
    })()`, true).catch(() => null);
    if (!stato || !stato.trovato) {
      merckInviaDiagnostica('Nessun campo di login individuato in questo tentativo (documento, iframe e shadow DOM analizzati) — se la pagina è già quella giusta, il portale potrebbe avere una struttura diversa da quella prevista.', win);
      return esito;
    }
    esito.trovato = true;

    // Username e password: focus + inserimento come digitazione reale (eventi fidati),
    // solo se il campo è vuoto — mai sopra il testo dell'utente.
    // BUG FIX ("credenziali errate" anche quando corrette): insertText() ritorna una
    // Promise che va ATTESA — prima non lo era, quindi il controllo subito dopo (poche
    // righe sotto) a volte leggeva il campo PRIMA che il testo fosse davvero atterrato nel
    // DOM. Il controllo trovava allora un valore vuoto o parziale e lo "correggeva" con un
    // secondo insertText: se nel frattempo il primo inserimento era comunque arrivato, il
    // campo finiva per contenere il valore scritto DUE VOLTE di seguito (es. la password
    // concatenata con se stessa) — credenziali visivamente "giuste" ma di fatto sbagliate
    // ad ogni tentativo di login. Atteso anche un istante dopo l'inserimento per dare al
    // componente Lightning il tempo di assestarsi prima di rileggere il valore.
    if (stato.user && stato.user.visibile && stato.user.valore === '') {
      await win.webContents.executeJavaScript(`(() => { ${MERCK_COLLEZIONA_RADICI} const c = cercaCoppia(); if (c && c.u) c.u.focus(); return true; })()`, true).catch(() => null);
      await win.webContents.insertText(credenziali.user);
      esito.userInserito = true;
    }
    if (stato.pass && stato.pass.visibile && stato.pass.valore === '') {
      await win.webContents.executeJavaScript(`(() => { ${MERCK_COLLEZIONA_RADICI} const c = cercaCoppia(); if (c && c.p) c.p.focus(); return true; })()`, true).catch(() => null);
      await win.webContents.insertText(credenziali.password);
      esito.passInserita = true;
    }
    await new Promise(r => setTimeout(r, 200));
    // VERIFICA di quanto realmente scritto nei campi (log mascherato: solo esiti
    // booleani e lunghezze, MAI il contenuto). Se l'inserimento non è atterrato
    // fedelmente, il mismatch lo mostra subito invece che far fallire il login
    // con "credenziali sbagliate" inspiegabili.
    const lettura = await win.webContents.executeJavaScript(`(() => {
      ${MERCK_COLLEZIONA_RADICI}
      const c = cercaCoppia();
      if (!c) return null;
      return { userValore: c.u ? c.u.value : null, passValore: c.p ? c.p.value : null };
    })()`, true).catch(() => null);
    if (lettura) {
      esito.userOk = lettura.userValore === credenziali.user;
      esito.passOk = lettura.passValore === credenziali.password;
      if (!esito.userOk || !esito.passOk) {
        merckInviaDiagnostica(`Verifica inserimento — user: ${esito.userOk ? 'OK' : 'non corrisponde (letti ' + (lettura.userValore || '').length + ' caratteri, attesi ' + credenziali.user.length + ')'} · password: ${esito.passOk ? 'OK' : (lettura.passValore === '' ? 'campo rimasto vuoto' : 'non corrisponde (letti ' + (lettura.passValore || '').length + ' caratteri, attesi ' + credenziali.password.length + ')')}. Provo a correggere…`, win);
        // Un solo tentativo di correzione: pulisce DAVVERO il campo (select-all + canc)
        // prima di reinserire, invece di limitarsi a scrivere sopra un valore parziale o
        // duplicato — altrimenti la correzione stessa poteva introdurre un secondo doppione.
        if (!esito.userOk) {
          await win.webContents.executeJavaScript(`(() => { ${MERCK_COLLEZIONA_RADICI} const c = cercaCoppia(); if (c && c.u) c.u.focus(); return true; })()`, true).catch(() => null);
          win.webContents.selectAll();
          await win.webContents.insertText(credenziali.user);
        }
        if (!esito.passOk) {
          await win.webContents.executeJavaScript(`(() => { ${MERCK_COLLEZIONA_RADICI} const c = cercaCoppia(); if (c && c.p) c.p.focus(); return true; })()`, true).catch(() => null);
          win.webContents.selectAll();
          await win.webContents.insertText(credenziali.password);
        }
        await new Promise(r => setTimeout(r, 200));
        const ricontrollo = await win.webContents.executeJavaScript(`(() => {
          ${MERCK_COLLEZIONA_RADICI}
          const c = cercaCoppia();
          if (!c) return null;
          return { userValore: c.u ? c.u.value : null, passValore: c.p ? c.p.value : null };
        })()`, true).catch(() => null);
        if (ricontrollo) {
          esito.userOk = ricontrollo.userValore === credenziali.user;
          esito.passOk = ricontrollo.passValore === credenziali.password;
          merckInviaDiagnostica(`Dopo il tentativo di correzione — user: ${esito.userOk ? 'OK' : 'ancora sbagliato'} · password: ${esito.passOk ? 'OK' : 'ancora sbagliata'}.` + (!esito.userOk || !esito.passOk ? ' Il portale potrebbe bloccare la digitazione automatica su questo campo: prova a scrivere le credenziali a mano in questa finestra.' : ''), win);
        }
      } else {
        merckInviaDiagnostica(`Credenziali inserite correttamente (user e password verificati carattere per carattere).`, win);
      }
    }
    // Spunta obbligatoria. Le checkbox Salesforce (pattern SLDS) hanno l'input nativo
    // visivamente nascosto con una label stilizzata sopra: un click alle coordinate
    // dell'input non aggancia nulla (verificato sul portale reale — la spunta restava
    // false e Sign In disabilitato). Strategia robusta in ordine: 1) focus + SPAZIO
    // (eventi tastiera fidati come un utente); 2) click reale sulla LABEL associata
    // (grande e visibile); 3) click reale sull'input.
    if (stato.chk && !stato.chk.checked) {
      await win.webContents.executeJavaScript(`(() => {
        ${MERCK_COLLEZIONA_RADICI}
        const c = cercaCoppia();
        if (!c) return false;
        const tutte = [...c.root.querySelectorAll('input[type=checkbox]')];
        const chk = tutte.find(x => /agre|accept|terms|privacy|consen|condiz|gdpr/i.test((x.id || '') + ' ' + (x.name || ''))) || tutte[0];
        if (chk && !chk.checked) { chk.focus(); return true; }
        return false;
      })()`, true).catch(() => null);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'space' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'space' });
      await new Promise(r => setTimeout(r, 400));
      const chkStato = await win.webContents.executeJavaScript(`(() => {
        ${MERCK_COLLEZIONA_RADICI}
        const c = cercaCoppia();
        if (!c) return null;
        const tutte = [...c.root.querySelectorAll('input[type=checkbox]')];
        const chk = tutte.find(x => /agre|accept|terms|privacy|consen|condiz|gdpr/i.test((x.id || '') + ' ' + (x.name || ''))) || tutte[0];
        if (!chk) return null;
        const label = c.root.querySelector('label[for="' + chk.id + '"]') || chk.closest('label');
        const el = label || chk;
        const r = el.getBoundingClientRect();
        return { checked: chk.checked, x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`, true).catch(() => null);
      if (chkStato && !chkStato.checked && chkStato.x > 0) clickReale(win, chkStato.x, chkStato.y);
      esito.spuntaMessa = true;
      esito.spuntaStato = chkStato ? chkStato.checked : null;
    }
    // Bottone: si preme solo quando il portale lo ha abilitato, con coordinate fresche —
    // MAI nello stesso tick in cui è stata messa la spunta (il click può spostare il layout).
    // Mai se la verifica sopra (anche dopo il tentativo di correzione) ha accertato che uno
    // dei due campi NON contiene il valore atteso: inviare comunque sprecherebbe un
    // tentativo di login — alcuni portali bloccano l'account dopo poche credenziali errate
    // consecutive, l'ultima cosa che serve è che sia l'app a bruciarle per un bug di autofill.
    const credenzialiVerificate = esito.userOk !== false && esito.passOk !== false;
    if (stato.btn && !stato.btn.disabled && !esito.spuntaMessa && credenzialiVerificate) {
      clickReale(win, stato.btn.x, stato.btn.y);
      esito.submitted = true;
      merckInviaDiagnostica('Form inviato. Se il portale risponde ancora "credenziali non valide", il problema è lato portale (password scaduta/da aggiornare, account bloccato dopo tentativi precedenti) — prova ad accedere scrivendo a mano in questa finestra per avere un messaggio d\'errore diretto dal portale.', win);
    } else if (stato.btn && stato.btn.disabled) {
      // Diagnostica precisa sul PERCHÉ resta disabilitato, invece di un generico "manca
      // qualche condizione": se non c'è alcuna checkbox e il bottone resta comunque
      // disabilitato, la condizione mancante è qualcos'altro (altro campo obbligatorio,
      // validazione formato, ecc.) — serve vedere la pagina reale per saperlo di sicuro.
      const dettaglioSpunta = !stato.chk
        ? 'nessuna casella di spunta individuata sulla pagina: la condizione che blocca il pulsante è probabilmente un\'altra (altro campo obbligatorio? formato non valido?) — usa "Salva HTML pagina di login" per farmela vedere'
        : (esito.spuntaStato === true ? 'la casella di spunta risulta selezionata, ma il pulsante resta comunque disabilitato: il portale richiede probabilmente anche altro'
           : 'la casella di spunta è stata individuata ma NON risulta selezionata dopo il tentativo — il click automatico potrebbe non "agganciare" su questo portale: usa "Salva HTML pagina di login" per farmela vedere');
      merckInviaDiagnostica(`Pulsante di accesso trovato ma ancora disabilitato dal portale — ${dettaglioSpunta}.`, win);
    } else if (stato.btn && !credenzialiVerificate) {
      merckInviaDiagnostica('Invio evitato: i campi non contengono le credenziali attese nemmeno dopo il tentativo di correzione. Prova a scrivere le credenziali a mano in questa finestra.', win);
    }
  } catch { /* finestra distrutta o pagina in transizione: tick successivo */ }
  return esito;
}

// Estrazione della tabella elenco chiamate DALLA PAGINA RENDERIZZATA (portali SPA come
// Salesforce Lightning/ServiceMax): attraversa documento + iframe + shadow DOM, trova la
// tabella con più righe e restituisce { intestazioni, righe }. L'HTML piatto di queste
// pagine è un guscio vuoto: senza questo passaggio il parser non vedrebbe nulla.
const MERCK_ESTRAI_TABELLA_SCRIPT = `(() => {
  ${MERCK_COLLEZIONA_RADICI}
  const estrai = (tab) => {
    const righe = [...tab.querySelectorAll('tr')];
    if (righe.length < 2) return null;
    const intestazioni = [...righe[0].querySelectorAll('th,td')].map(c => c.textContent.replace(/\\s+/g, ' ').trim());
    if (intestazioni.filter(Boolean).length < 2) return null;
    const righeOut = [];
    for (const tr of righe.slice(1)) {
      const celle = [...tr.querySelectorAll('td,th')].map(c => c.textContent.replace(/\\s+/g, ' ').trim());
      if (celle.join('').length < 3) continue;
      righeOut.push(celle);
    }
    return righeOut.length ? { intestazioni, righe: righeOut } : null;
  };
  let migliore = null;
  for (const root of radici) {
    [...root.querySelectorAll('table')].forEach(t => {
      const e = estrai(t);
      if (e && (!migliore || e.righe.length > migliore.righe.length)) migliore = e;
    });
  }
  return migliore;
})()`;

// Scaricamento via finestra nascosta con rendering completo: serve per i portali
// "SPA" (es. Salesforce Lightning) dove il semplice fetch restituisce la shell
// senza dati. Se la pagina caricata è quella di login e ci sono credenziali
// salvate, compila e invia il form, poi attende la navigazione post-login.
// L'estrazione della tabella viene ritentata: dopo il login Lightning impiega
// qualche secondo a caricare l'elenco dati.
async function merckScaricaRenderizzato(url) {
  const credenziali = merckCredenziali();
  return await new Promise((resolve) => {
    let concluso = false;
    let win = null;
    const concludi = (ris) => {
      if (concluso) return;
      concluso = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
      resolve(ris);
    };
    try {
      win = new BrowserWindow({
        show: false, width: 1360, height: 900,
        webPreferences: { session: merckSessione(), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: false }
      });
    } catch (e) { resolve({ ok: false, errore: e.message || String(e) }); return; }
    win.loadURL(url).catch(() => {});
    win.webContents.on('did-fail-load', (e, code, desc, vurl, isMainFrame) => {
      if (isMainFrame) concludi({ ok: false, errore: 'Caricamento pagina fallito: ' + desc });
    });
    win.webContents.on('did-finish-load', async () => {
      try {
        // Auto-login se la pagina mostrata è quella di login: tentativi ripetuti su tutti
        // i frame (il form può comparire dopo il load, via JavaScript, o stare in un iframe).
        let inviato = false;
        if (credenziali) {
          let nonTrovato = 0;
          for (let i = 0; i < 8 && !inviato; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (!win || win.isDestroyed()) return;
            const esito = await merckProvaAutofill(win, credenziali).catch(() => null);
            if (esito && esito.submitted) inviato = true;
            else if (!esito || !esito.trovato) { nonTrovato++; if (nonTrovato >= 2) break; } // pagina senza form di login
            else nonTrovato = 0;
          }
          if (inviato) await new Promise(r => setTimeout(r, 10000)); // attesa navigazione post-login
        }
        await new Promise(r => setTimeout(r, 3000)); // finestra di grazia per il rendering SPA
        // Estrazione della tabella elenco con re-tentativi: Lightning carica i dati
        // della lista qualche secondo dopo il rendering della pagina.
        let tabella = null;
        for (let tent = 0; tent < 3 && !tabella; tent++) {
          if (tent) await new Promise(r => setTimeout(r, 6000));
          if (!win || win.isDestroyed()) return;
          tabella = await win.webContents.executeJavaScript(MERCK_ESTRAI_TABELLA_SCRIPT, true).catch(() => null);
        }
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
        concludi({ ok: true, html, tabella });
      } catch (e) {
        concludi({ ok: false, errore: e.message || String(e) });
      }
    });
    setTimeout(() => concludi({ ok: false, errore: 'Timeout caricamento pagina portale (75s)' }), 75000);
  });
}

// ============================================================================
// ACCESSO AL PORTALE IN BACKGROUND
// ============================================================================
function merckImpostaStato(stato, dettaglio = '') {
  merckStato = { stato, dettaglio };
  try {
    if (finestraPrincipale && !finestraPrincipale.isDestroyed()) finestraPrincipale.webContents.send('merck:stato', merckStato);
  } catch { /* finestra principale non pronta */ }
}

function merckMostraFinestra() {
  const w = merckFinestraLogin;
  if (!w || w.isDestroyed()) return false;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return true;
}

// Stato della pagina attualmente caricata nella finestra del portale: c'è ancora un campo
// password visibile (= non si è entrati) e il portale mostra un errore di credenziali?
const MERCK_STATO_PAGINA_SCRIPT = `(() => {
  ${MERCK_COLLEZIONA_RADICI}
  let passwordVisibile = false, errore = false;
  for (const root of radici) {
    try {
      for (const p of root.querySelectorAll('input[type=password]')) {
        const r = p.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) passwordVisibile = true;
      }
      // Conta solo il testo di errore VISIBILE: molte pagine contengono nel DOM il messaggio
      // di errore già pronto ma nascosto (display:none), che non va scambiato per un rifiuto.
      const re = /login attempt has failed|username and password are correct|credenziali non valide|accesso non riuscito|invalid (username|password)/i;
      for (const el of root.querySelectorAll('*')) {
        if (el.children.length || !re.test(el.textContent || '')) continue;
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') { errore = true; break; }
      }
    } catch (e) {}
  }
  return { passwordVisibile, errore, url: location.href };
})()`;

function merckFermaMonitor() {
  if (merckMonitor) { clearInterval(merckMonitor.timer); merckMonitor = null; }
}

// Controlla periodicamente la pagina per capire se l'accesso è riuscito. `risolvi` riceve UNA
// sola volta l'esito (connesso / non connesso con motivo) entro ATTESA_ESITO_MS; il controllo
// prosegue poi a bassa frequenza per qualche minuto, così un accesso completato a mano nella
// finestra (es. dopo un'intervento richiesto dal portale) aggiorna comunque lo stato.
function merckAvviaMonitorAccesso(win, risolvi) {
  merckFermaMonitor();
  const ATTESA_ESITO_MS = 45000, DURATA_TOTALE_MS = 10 * 60 * 1000;
  const inizio = Date.now();
  let risolto = false, connessiDiSeguito = 0;
  const fine = (ris) => { if (risolto) return; risolto = true; if (risolvi) risolvi(ris); };
  const tick = async () => {
    if (!win || win.isDestroyed()) { merckFermaMonitor(); fine({ connesso: false, dettaglio: 'Finestra del portale chiusa prima della fine dell\'accesso' }); return; }
    const trascorso = Date.now() - inizio;
    if (trascorso > DURATA_TOTALE_MS) { merckFermaMonitor(); return; }
    if (trascorso > ATTESA_ESITO_MS && !risolto) {
      const motivo = merckUltimaDiagnostica || 'Il portale non ha risposto all\'invio delle credenziali';
      if (merckStato.stato === 'accesso') merckImpostaStato('errore', motivo);
      fine({ connesso: false, dettaglio: motivo });
    }
    if (win.webContents.isLoading()) return;
    let s = null;
    try { s = await win.webContents.executeJavaScript(MERCK_STATO_PAGINA_SCRIPT, true); } catch { return; }
    if (!s || !/^https?:/i.test(s.url || '')) return;
    if (s.errore && s.passwordVisibile) {
      connessiDiSeguito = 0;
      const motivo = 'Il portale ha rifiutato le credenziali (verifica user/password salvati o aprine la finestra).';
      merckImpostaStato('errore', motivo);
      fine({ connesso: false, dettaglio: motivo });
      return;
    }
    const sulLogin = /\/login\b/i.test(s.url);
    if (!s.passwordVisibile && !sulLogin) {
      // Due controlli consecutivi, per non scambiare per "entrato" il vuoto di una navigazione in corso.
      if (++connessiDiSeguito >= 2) {
        if (merckStato.stato !== 'connesso') merckImpostaStato('connesso', 'Connesso al portale');
        fine({ connesso: true, dettaglio: 'Connesso al portale' });
      }
    } else {
      connessiDiSeguito = 0;
    }
  };
  merckMonitor = { timer: setInterval(tick, 1500), fine };
}

// Crea (nascosta, salvo `visibile` o assenza di credenziali) la finestra del portale, avvia
// l'auto-compilazione del login e restituisce una promise con l'esito. L'auto-compilazione NON
// gira una sola volta al load: molti portali disegnano il form via JavaScript dopo il
// caricamento o lo mettono in un iframe. Polling ogni 900ms per ~15s, su tutti i frame, finché
// il form non viene compilato e inviato (o non c'è più la finestra).
function avviaLoginMerck(url, { visibile = false } = {}) {
  return new Promise((resolve) => {
    if (merckFinestraLogin && !merckFinestraLogin.isDestroyed()) {
      if (visibile) merckMostraFinestra();
      resolve({ ok: true, connesso: merckStato.stato === 'connesso', manuale: merckStato.stato === 'manuale', dettaglio: merckStato.dettaglio, stato: merckStato.stato });
      return;
    }
    const credenziali = merckCredenziali();
    const mostra = visibile || !credenziali;
    const win = new BrowserWindow({
      show: mostra, width: 1180, height: 880, title: 'Accesso al portale Merck', backgroundColor: '#f5f5f7',
      // backgroundThrottling disattivato: una finestra nascosta non deve rallentare i timer
      // della pagina (il portale Lightning disegna e verifica la sessione via JavaScript).
      webPreferences: { session: merckSessione(), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, navigateOnDragDrop: false, backgroundThrottling: false }
    });
    merckFinestraLogin = win;
    win.setMenuBarVisibility(false);
    merckUltimaDiagnostica = '';
    merckImpostaStato(credenziali ? 'accesso' : 'manuale',
      credenziali ? 'Accesso in corso in background…' : 'Nessuna credenziale salvata: accedi a mano nella finestra del portale');

    let tick = 0;
    if (merckAutofillTimer) clearInterval(merckAutofillTimer);
    merckAutofillTimer = setInterval(async () => {
      tick++;
      try {
        if (!win || win.isDestroyed()) { clearInterval(merckAutofillTimer); merckAutofillTimer = null; return; }
        const cred = merckCredenziali();
        if (!cred) { clearInterval(merckAutofillTimer); merckAutofillTimer = null; return; } // login manuale
        const esito = await merckProvaAutofill(win, cred);
        if (esito.submitted) {
          console.log('[Merck] Login auto-compilato e inviato dopo', tick, 'tentativi');
          clearInterval(merckAutofillTimer); merckAutofillTimer = null;
        } else if (tick >= 16) {
          clearInterval(merckAutofillTimer); merckAutofillTimer = null;
        }
      } catch { /* tick successivo */ }
    }, 900);

    win.webContents.on('did-fail-load', (e, code, desc, vurl, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 = caricamento annullato (navigazione successiva)
      merckImpostaStato('errore', 'Impossibile raggiungere il portale: ' + desc);
      if (merckMonitor) merckMonitor.fine({ connesso: false, dettaglio: 'Impossibile raggiungere il portale: ' + desc });
    });
    win.once('closed', () => {
      if (merckAutofillTimer) { clearInterval(merckAutofillTimer); merckAutofillTimer = null; }
      const fine = merckMonitor && merckMonitor.fine;
      merckFermaMonitor();
      if (fine) fine({ connesso: false, dettaglio: 'Finestra del portale chiusa prima della fine dell\'accesso' });
      if (merckFinestraLogin === win) merckFinestraLogin = null;
      // La sessione (cookie) resta valida anche a finestra chiusa: se si era connessi si resta
      // "connesso"; negli altri casi si torna a "inattivo".
      if (merckStato.stato !== 'connesso') merckImpostaStato('inattivo', '');
    });
    win.loadURL(url).catch(() => {});

    if (!credenziali) {
      merckAvviaMonitorAccesso(win, null); // aggiorna lo stato quando l'utente completa l'accesso a mano
      resolve({ ok: true, connesso: false, manuale: true, dettaglio: merckStato.dettaglio, stato: 'manuale' });
      return;
    }
    merckAvviaMonitorAccesso(win, (ris) => resolve({ ok: true, manuale: false, stato: merckStato.stato, ...ris }));
  });
}

function registraCanaliMerck() {
  // Credenziali: salvate cifrate (safeStorage), lette solo dal main. La password
  // NON viene mai restituita al renderer — solo user e data di aggiornamento.
  ipcMain.handle('merck:salvaCredenziali', (event, user, password) => {
    if (typeof user !== 'string' || typeof password !== 'string') return { ok: false, errore: 'Valori non validi' };
    user = user.trim();
    if (!user) return { ok: false, errore: 'Inserisci lo user del portale' };
    if (!password) return { ok: false, errore: 'Inserisci la password' };
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, errore: 'Cifratura del sistema operativo non disponibile: la password non può essere salvata in sicurezza.' };
    const cfg = leggiConfig();
    cfg.merck = { user, passEnc: safeStorage.encryptString(password).toString('base64'), aggiornataIl: new Date().toISOString() };
    salvaConfig(cfg);
    return { ok: true, user, aggiornataIl: cfg.merck.aggiornataIl };
  });

  ipcMain.handle('merck:credenzialiInfo', () => {
    const c = merckCredenziali();
    return { presente: !!c, user: c ? c.user : '', aggiornataIl: c ? c.aggiornataIl : null };
  });

  // Accesso al portale IN BACKGROUND: la finestra viene creata nascosta e, con le credenziali
  // salvate, il form si compila e si invia da solo; l'invoke si risolve quando l'esito è noto
  // (connesso / errore) o subito se serve l'accesso manuale (nessuna credenziale salvata: in quel
  // caso la finestra viene mostrata, altrimenti non si potrebbe accedere). La finestra si può
  // mostrare in qualsiasi momento col pulsante "Merck" in alto (merck:mostraFinestra).
  ipcMain.handle('merck:login', (event, urlGrezzo) => {
    const url = validaUrlPortale(urlGrezzo);
    if (!url) return { ok: false, errore: 'URL del portale non valido (deve iniziare con https://)' };
    return avviaLoginMerck(url, { visibile: false });
  });

  // Mostra la finestra del portale (quella in background se esiste; altrimenti ne apre una
  // visibile sul portale: la sessione è condivisa, quindi di norma si è già connessi).
  ipcMain.handle('merck:mostraFinestra', (event, urlGrezzo) => {
    if (merckMostraFinestra()) return { ok: true };
    const url = validaUrlPortale(urlGrezzo);
    if (!url) return { ok: false, errore: "Imposta prima l'URL del portale Merck nelle Impostazioni." };
    avviaLoginMerck(url, { visibile: true }); // non si attende l'esito: la finestra è sotto gli occhi dell'utente
    return { ok: true };
  });

  ipcMain.handle('merck:statoCorrente', () => merckStato);

  // Scaricamento HTTP semplice (basta per portali classici a tabelle/HTML)
  ipcMain.handle('merck:scarica', async (event, urlGrezzo) => {
    const url = validaUrlPortale(urlGrezzo);
    if (!url) return { ok: false, errore: 'URL del portale non valido' };
    try {
      const res = await merckSessione().fetch(url, { redirect: 'follow', bypassCustomProtocolHandlers: true });
      const html = await res.text();
      return { ok: res.ok, status: res.status, urlFinale: res.url || url, html, sembraLogin: paginaDiLogin(html) };
    } catch (e) {
      return { ok: false, errore: 'Errore di rete: ' + (e.message || e) };
    }
  });

  // Scaricamento con rendering completo (portali JavaScript/SPA)
  ipcMain.handle('merck:scaricaRender', async (event, urlGrezzo) => {
    const url = validaUrlPortale(urlGrezzo);
    if (!url) return { ok: false, errore: 'URL del portale non valido' };
    try {
      const res = await merckScaricaRenderizzato(url);
      if (res.ok) res.sembraLogin = paginaDiLogin(res.html);
      return res;
    } catch (e) {
      return { ok: false, errore: e.message || String(e) };
    }
  });

  ipcMain.handle('merck:logout', async () => {
    try {
      await merckSessione().clearStorageData();
      // Sessione cancellata: la finestra in background (se c'è) non è più connessa a nulla.
      if (merckFinestraLogin && !merckFinestraLogin.isDestroyed()) merckFinestraLogin.destroy();
      merckImpostaStato('inattivo', '');
      return { ok: true };
    }
    catch (e) { return { ok: false, errore: e.message || String(e) }; }
  });

  // Debug: salva l'HTML scaricato per calibrare il parser sul portale reale
  ipcMain.handle('merck:salvaHtml', async (event, html) => {
    if (typeof html !== 'string' || !html) return { ok: false, errore: 'Nessun HTML da salvare' };
    const res = await dialog.showSaveDialog({ title: "Salva HTML del portale (per calibrare l'estrazione)", defaultPath: 'merck-pagina.html' });
    if (res.canceled || !res.filePath) return { ok: false };
    await fsp.writeFile(res.filePath, html, 'utf8');
    return { ok: true, percorso: res.filePath };
  });

  // Debug: cattura la pagina di login ATTUALMENTE aperta (documento + iframe + shadow DOM,
  // vedi MERCK_SERIALIZZA_RADICI) — serve a vedere la VERA struttura del form quando
  // l'autofill si blocca (es. bottone sempre disabilitato) senza dover indovinare. Le
  // password digitate vengono mascherate prima del salvataggio.
  ipcMain.handle('merck:salvaHtmlLogin', async () => {
    if (!merckFinestraLogin || merckFinestraLogin.isDestroyed()) {
      return { ok: false, errore: 'Nessuna finestra di login del portale è aperta al momento.' };
    }
    const testo = await merckFinestraLogin.webContents.executeJavaScript(MERCK_SERIALIZZA_RADICI, true).catch((e) => null);
    if (!testo) return { ok: false, errore: 'Impossibile leggere il contenuto della pagina.' };
    const res = await dialog.showSaveDialog({ title: "Salva struttura pagina di login (per calibrare l'autofill)", defaultPath: 'merck-login.html' });
    if (res.canceled || !res.filePath) return { ok: false };
    await fsp.writeFile(res.filePath, testo, 'utf8');
    return { ok: true, percorso: res.filePath };
  });
}

// Menu minimale di produzione:
//  · niente "Toggle Developer Tools" (nel menu di default sono raggiungibili anche nell'app
//    pacchettizzata);
//  · su macOS il menu Modifica va mantenuto: Cmd+C/V/X sono gestiti dai ruoli del menu,
//    senza il menu Edit gli incolla/copiati smettono di funzionare nei campi di testo.
function installaMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Modifica',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'Vista',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Riferimento alla finestra principale: serve a inoltrarle in tempo reale la diagnostica
// dei tentativi di autofill del portale Merck (vedi merckInviaDiagnostica), così l'utente la
// vede nella card "Portale Merck" delle Impostazioni senza dover aprire i DevTools — che
// nel menu di produzione non ci sono.
let finestraPrincipale = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 1170, // +30% rispetto ai 900px originali
    minWidth: 1024,
    minHeight: 700,
    title: 'Assistenza Tecnica IVD',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f5f5f7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Preload minimale: espone solo i canali IPC dell'archivio su cartella (vedi
      // preload.js). Nessuna API Node al renderer, sandbox resta ATTIVA.
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      // Con sandbox attiva disabilitiamo esplicitamente anche le funzioni Node-adjacent
      // che restano esposte in una BrowserWindow (difesa in profondità).
      webviewTag: false,
      navigateOnDragDrop: false
    },
    show: false
  });

  finestraPrincipale = win;
  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');
  win.once('closed', () => {
    finestraPrincipale = null;
    // La finestra del portale Merck può restare viva (nascosta) in background: chiudendo
    // l'app va chiusa anche lei, altrimenti window-all-closed non scatta e il processo resta.
    if (merckFinestraLogin && !merckFinestraLogin.isDestroyed()) merckFinestraLogin.destroy();
  });
}

// Hardening applicato a OGNI webContents dell'app (finestra principale, finestre di
// stampa create via window.open, future finestre): registra gli handler qui e non sulla
// singola BrowserWindow, così nessuna finestra ne resta fuori.
app.on('web-contents-created', (event, contents) => {
  // Finestra di stampa: l'app apre una finestra vuota via window.open('','_blank',...) e vi
  // scrive l'anteprima (verbali, D.D.T., elenchi) — è l'unico window.open legittimo.
  // Qualsiasi altro target (http/https/file/data/...) viene NEGANato: gli URL web, se mai
  // servisse, vanno aperti nel browser di sistema esplicitamente, non dentro l'app.
  contents.setWindowOpenHandler(({ url }) => {
    if (url === '' || url === 'about:blank') return { action: 'allow' };
    // Finestre del portale Merck (partizione dedicata, cookie separati dall'app):
    // popup e link del portale restano nell'app. Tutte le altre finestre come prima.
    if (/^https?:\/\//i.test(url) && contents.session === merckSessione()) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url); // solo http/https, mai scheme arbitrari (ftp:, smb:, custom)
    }
    return { action: 'deny' };
  });

  // Navigazione diretta (link senza target="_blank", location.href, drag&drop): permessa
  // SOLO verso l'app stessa (reload interno). Tutto il resto viene bloccato; gli URL
  // http/https vengono delegati al browser di sistema.
  // Eccezione: le finestre del portale Merck (partizione dedicata) navigano liberamente
  // il portale — compresi i redirect tra host dei sistemi di login (es. Salesforce) —
  // perché è il loro compito. Gli schemi non-http restano bloccati e nessun'altra
  // finestra ne beneficia.
  contents.on('will-navigate', (event, url) => {
    if (url === APP_URL || url.startsWith(APP_URL.split('#')[0])) return; // stesso documento (es. reload)
    if (/^https?:\/\//i.test(url) && contents.session === merckSessione()) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Nessun permesso del browser è necessario (niente notifiche, media, geolocalizzazione,
  // clipboard di sistema...): nega tutto di default. Senza handler, Electron APPROVEREBBE
  // tutte le richieste di permessi.
  contents.session.setPermissionRequestHandler((wc, permission, callback) => {
    console.warn(`[Sicurezza] Permesso richiesto e negato: ${permission}`);
    return callback(false);
  });
  contents.session.setPermissionCheckHandler(() => false);
});

app.whenReady().then(() => {
  registraCanaliArchivio();
  registraCanaliMerck();
  installaMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Prima di uscire (chiusura finestra su Windows/Linux, Cmd+Q su macOS) si attende il
// completamento delle scritture dell'archivio già richieste dal renderer: prima il processo
// terminava subito e l'ultimo salvataggio, ancora in coda o a metà, andava perso. Attesa
// massima 8s per non bloccare l'uscita se la cartella non risponde.
let _uscitaGestita = false;
app.on('before-quit', (event) => {
  if (_uscitaGestita) return;
  _uscitaGestita = true;
  event.preventDefault();
  Promise.race([_writeQueue, new Promise(r => setTimeout(r, 8000))]).finally(() => app.exit(0));
});

// Profilo userData alternativo per test/diagnostica (es. riprodurre un problema con una
// copia dell'archivio senza toccare il profilo reale): IVD_USER_DATA_DIR=<cartella>
if (process.env.IVD_USER_DATA_DIR) {
  app.setPath('userData', process.env.IVD_USER_DATA_DIR);
}
