const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'Assistenza Tecnica IVD',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#f5f5f7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // L'app non usa alcuna API Node/Electron dal renderer (solo IndexedDB, localStorage,
      // fetch verso Supabase e le CDN già usate nel browser): nessun preload necessario.
      sandbox: false
    },
    show: false
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');

  // L'app apre una finestra vuota via window.open('','_blank',...) per l'anteprima di stampa
  // (verbali, D.D.T., elenchi) — va sempre permessa. Un vero link http/https (es. un
  // eventuale link cliccato in una pagina) va invece aperto nel browser di sistema, mai in
  // una nuova finestra Electron.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Segue lo stesso criterio per la navigazione diretta (link cliccati senza target="_blank").
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file://')) return; // navigazione interna all'app, es. reload
    event.preventDefault();
    shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
