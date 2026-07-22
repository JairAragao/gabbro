// Context-isolated: the renderer gets the folder picker and the update channel
// — nothing else.

'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('gabbroDesktop', {
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  onUpdateStatus: cb => ipcRenderer.on('update:status', (_e, payload) => cb(payload)),
  installUpdate: () => ipcRenderer.send('update:install')
})
