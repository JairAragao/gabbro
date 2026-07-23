// Context-isolated: the renderer gets the folder picker, the ready signal and
// the update channel — nothing else.

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gabbroDesktop', {
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  signalReady: () => ipcRenderer.send('app:ready'),
  onUpdateStatus: cb => ipcRenderer.on('update:status', (_e, payload) => cb(payload)),
  installUpdate: () => ipcRenderer.send('update:install')
})
