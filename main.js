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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout (${Math.round(ms / 1000)}s) sull'operazione "${operazione}" — la cartella archivio non risponde (iCloud/sync o disco non disponibile?)`)), ms))
  ]);
}
const OP_TIMEOUT_MS = 20000;

function leggiFileConTimeout(p) { return conTimeout(p, OP_TIMEOUT_MS, 'lettura'); }
function scriviConTimeout(p) { return conTimeout(p, OP_TIMEOUT_MS, 'scrittura'); }

function registraCanaliArchivio() {
  cartellaDati = risolviCartellaDati();
  cartellaBackupOverride = leggiConfig().cartellaBackup || null;

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

  ipcMain.handle('archivio:scrivi', (event, payload) => inCoda(async () => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Payload non valido');
    }
    await assicuraCartelle();
    const { dati } = percorsi();
    for (const nome of Object.keys(payload)) {
      if (!FILE_WHITELIST.includes(nome)) throw new Error('Nome file non consentito: ' + nome);
      if (typeof payload[nome] !== 'string') throw new Error('Contenuto non valido per ' + nome);
      await scriviFileAtomico(path.join(dati, nome), payload[nome]);
    }
    return { ok: true, scritti: Object.keys(payload) };
  }));

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
let merckHostCorrente = null;

function merckSessione() {
  return session.fromPartition(MERCK_PARTITION);
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

// Credenziali salvate: decifrate SOLO qui nel main, mai inviate al renderer
function merckCredenziali() {
  const cfg = leggiConfig();
  if (!cfg.merck || !cfg.merck.passEnc) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return {
      user: cfg.merck.user || '',
      password: safeStorage.decryptString(Buffer.from(cfg.merck.passEnc, 'base64')),
      aggiornataIl: cfg.merck.aggiornataIl || null
    };
  } catch { return null; }
}

// Script eseguito NELLA pagina di login del portale per compilare i campi e inviare
// il form. Heuristica generica: primo input email/testo visibile + primo input
// password visibile + submit (bottone o form). Non tocca campi già compilati (così
// il login manuale resta sempre possibile).
function merckAutofillScript(credenziali) {
  return `(() => {
    const user = ${JSON.stringify(credenziali.user)};
    const pass = ${JSON.stringify(credenziali.password)};
    const visibile = (el) => el && el.offsetParent !== null && !el.disabled && !el.readOnly;
    const trova = (sel) => [...document.querySelectorAll(sel)].find(visibile);
    const inpPass = trova('input[type=password]');
    if (!inpPass) return { riempito: false, motivo: 'nessun campo password' };
    const inpUser = trova('input[type=email]') || trova('input[type=text]') || trova('input:not([type])');
    if (!inpUser) return { riempito: false, motivo: 'nessun campo utente' };
    if (inpUser.value || inpPass.value) return { riempito: false, motivo: 'campi già compilati' };
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setVal(inpUser, user);
    setVal(inpPass, pass);
    const btn = trova('button[type=submit], input[type=submit], button[id*=login i], button[name*=login i], input[name*=login i], button[class*=login i], button[id*=Logon]');
    if (btn) { btn.click(); return { riempito: true, inviato: 'bottone' }; }
    const form = inpPass.closest('form');
    if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); return { riempito: true, inviato: 'form' }; }
    return { riempito: true, inviato: false };
  })()`;
}

// Scaricamento via finestra nascosta con rendering completo: serve per i portali
// "SPA" (es. Salesforce Lightning) dove il semplice fetch restituisce la shell
// senza dati. Se la pagina caricata è quella di login e ci sono credenziali
// salvate, compila e invia il form, poi attende la navigazione post-login.
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
        webPreferences: { session: merckSessione(), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, navigateOnDragDrop: false }
      });
    } catch (e) { resolve({ ok: false, errore: e.message || String(e) }); return; }
    win.loadURL(url).catch(() => {});
    win.webContents.on('did-fail-load', (e, code, desc, vurl, isMainFrame) => {
      if (isMainFrame) concludi({ ok: false, errore: 'Caricamento pagina fallito: ' + desc });
    });
    win.webContents.on('did-finish-load', async () => {
      try {
        const info = await win.webContents.executeJavaScript(`(() => ({ haPassword: !!document.querySelector('input[type=password]'), userVuoto: !(document.querySelector('input[type=email],input[type=text]') || {}).value }))()`).catch(() => null);
        if (info && info.haPassword && credenziali) {
          const esito = await win.webContents.executeJavaScript(merckAutofillScript(credenziali)).catch(() => null);
          if (esito && esito.riempito && esito.inviato) {
            await new Promise(r => setTimeout(r, 12000)); // attesa navigazione post-login
          }
        }
        await new Promise(r => setTimeout(r, 4000)); // finestra di grazia per il rendering SPA
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
        concludi({ ok: true, html });
      } catch (e) {
        concludi({ ok: false, errore: e.message || String(e) });
      }
    });
    setTimeout(() => concludi({ ok: false, errore: 'Timeout caricamento pagina portale (45s)' }), 45000);
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

  // Apre la finestra di login sul portale. Quando appare la pagina di login e ci
  // sono credenziali salvate, i campi vengono compilati e inviati automaticamente.
  ipcMain.handle('merck:login', (event, urlGrezzo) => {
    const url = validaUrlPortale(urlGrezzo);
    if (!url) return { ok: false, errore: 'URL del portale non valido (deve iniziare con https://)' };
    merckHostCorrente = new URL(url).hostname;
    if (merckFinestraLogin && !merckFinestraLogin.isDestroyed()) { merckFinestraLogin.focus(); return { ok: true }; }
    merckFinestraLogin = new BrowserWindow({
      width: 1180, height: 880, title: 'Accesso al portale Merck', backgroundColor: '#f5f5f7',
      webPreferences: { session: merckSessione(), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, navigateOnDragDrop: false }
    });
    merckFinestraLogin.setMenuBarVisibility(false);
    merckFinestraLogin.webContents.on('did-finish-load', async () => {
      try {
        const credenziali = merckCredenziali();
        if (!credenziali || !merckFinestraLogin || merckFinestraLogin.isDestroyed()) return;
        const info = await merckFinestraLogin.webContents.executeJavaScript(`(() => { const p = document.querySelector('input[type=password]'); const u = document.querySelector('input[type=email],input[type=text]'); return { haPassword: !!p, userVuoto: !!(u && !u.value) }; })()`).catch(() => null);
        if (info && info.haPassword && info.userVuoto) {
          await merckFinestraLogin.webContents.executeJavaScript(merckAutofillScript(credenziali)).catch(() => {});
        }
      } catch {}
    });
    merckFinestraLogin.loadURL(url);
    merckFinestraLogin.once('closed', () => { merckFinestraLogin = null; });
    return { ok: true };
  });

  // Scaricamento HTTP semplice (basta per portali classici a tabelle/HTML)
  ipcMain.handle('merck:scarica', async (event, urlGrezzo) => {
    const url = validaUrlPortale(urlGrezzo);
    if (!url) return { ok: false, errore: 'URL del portale non valido' };
    merckHostCorrente = new URL(url).hostname;
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
    merckHostCorrente = new URL(url).hostname;
    try {
      const res = await merckScaricaRenderizzato(url);
      if (res.ok) res.sembraLogin = paginaDiLogin(res.html);
      return res;
    } catch (e) {
      return { ok: false, errore: e.message || String(e) };
    }
  });

  ipcMain.handle('merck:logout', async () => {
    try { await merckSessione().clearStorageData(); return { ok: true }; }
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

  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');
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

// Profilo userData alternativo per test/diagnostica (es. riprodurre un problema con una
// copia dell'archivio senza toccare il profilo reale): IVD_USER_DATA_DIR=<cartella>
if (process.env.IVD_USER_DATA_DIR) {
  app.setPath('userData', process.env.IVD_USER_DATA_DIR);
}
