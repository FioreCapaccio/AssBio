// Preload (sandbox attivo): espone al renderer SOLO i metodi per l'archivio su cartella,
// via contextBridge. I nomi dei file sono sempre validati da una whitelist nel processo
// main (main.js). L'unica eccezione che riceve un percorso testuale dal renderer è
// impostaCartellaBackup() (l'utente digita/incolla la cartella dei backup automatici in
// Impostazioni): il testo viene trattato come non fidato e validato lato main (deve essere
// un percorso assoluto, scrivibile) prima di essere usato — vedi
// archivio:impostaCartellaBackup in main.js. Espone solo ipcRenderer.invoke verso canali
// "archivio:*" — niente accesso generico a ipcRenderer o a Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ivdFS', {
  info: () => ipcRenderer.invoke('archivio:info'),
  leggiTutto: () => ipcRenderer.invoke('archivio:leggiTutto'),
  scrivi: (payload) => ipcRenderer.invoke('archivio:scrivi', payload),
  backupSnapshot: (contenuto) => ipcRenderer.invoke('archivio:backupSnapshot', contenuto),
  apriCartella: () => ipcRenderer.invoke('archivio:apriCartella'),
  scegliCartella: () => ipcRenderer.invoke('archivio:scegliCartella'),
  spostaArchivio: () => ipcRenderer.invoke('archivio:sposta'),
  impostaCartellaBackup: (percorso) => ipcRenderer.invoke('archivio:impostaCartellaBackup', percorso),
});
