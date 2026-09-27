// Preload (sandbox attivo): espone al renderer SOLO i metodi per l'archivio su cartella,
// via contextBridge. Nessun percorso passa dal renderer: i nomi dei file sono validati
// da una whitelist nel processo main (main.js). Espone solo ipcRenderer.invoke verso
// canali "archivio:*" — niente accesso generico a ipcRenderer o a Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ivdFS', {
  info: () => ipcRenderer.invoke('archivio:info'),
  leggiTutto: () => ipcRenderer.invoke('archivio:leggiTutto'),
  scrivi: (payload) => ipcRenderer.invoke('archivio:scrivi', payload),
  backupSnapshot: (contenuto) => ipcRenderer.invoke('archivio:backupSnapshot', contenuto),
  apriCartella: () => ipcRenderer.invoke('archivio:apriCartella'),
  scegliCartella: () => ipcRenderer.invoke('archivio:scegliCartella'),
  spostaArchivio: () => ipcRenderer.invoke('archivio:sposta'),
});
