// Basalt pattern: start the EXISTING express backend on a free loopback port
// and open a window on that URL (same origin, no CORS).

'use strict'

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron')
const { autoUpdater } = require('electron-updater')

Menu.setApplicationMenu(null)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

let mainWindow = null
let serverListener = null

function createWindow (url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    backgroundColor: '#232a36',
    title: 'Gabbro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.loadURL(url)
  mainWindow.maximize()

  // External links open in the default browser, not an Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) { shell.openExternal(target); return { action: 'deny' } }
    return { action: 'allow' }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

// Auto-update from public GitHub Releases (no token). Downloads in background;
// the renderer shows a "restart to update" banner (update:status IPC), no
// native dialogs.
const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000
let updateReady = false

function sendUpdStatus (state, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', { state, ...(extra || {}) })
  }
}

function setupAutoUpdate () {
  if (!app.isPackaged || updateReady) return
  updateReady = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', info => sendUpdStatus('available', { version: info && info.version }))
  autoUpdater.on('download-progress', p => sendUpdStatus('downloading', { percent: Math.round((p && p.percent) || 0) }))
  autoUpdater.on('update-downloaded', info => sendUpdStatus('downloaded', { version: info && info.version }))
  autoUpdater.on('error', e => console.error('[updater]', (e && e.message) || e))
  const check = () => autoUpdater.checkForUpdates().catch(e => console.error('[updater] check', (e && e.message) || e))
  check()
  setInterval(check, UPDATE_INTERVAL_MS)
}

ipcMain.on('update:install', () => {
  // silent NSIS install + relaunch (the assisted wizard stays manual-install-only)
  try { autoUpdater.quitAndInstall(true, true) } catch (e) { console.error('[updater] install', (e && e.message) || e) }
})

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a git clone (repo with the DBML file)',
    properties: ['openDirectory']
  })
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
})

// Resolve the repo BEFORE requiring the server (config.js reads env at require
// time): saved lastRepo, else ask with the native picker.
function resolveRepoOrAsk () {
  const settings = require('../server/settings')
  const s = settings.read()
  if (typeof s.lastRepo === 'string' && s.lastRepo && fs.existsSync(path.join(s.lastRepo, '.git'))) {
    return Promise.resolve(s.lastRepo)
  }
  return dialog.showOpenDialog({
    title: 'Gabbro — choose the git clone of your DBML repo',
    properties: ['openDirectory']
  }).then(res => {
    if (res.canceled || !res.filePaths.length) return null
    const p = res.filePaths[0]
    if (!fs.existsSync(path.join(p, '.git'))) {
      dialog.showErrorBox('Gabbro', `Not a git repository (missing .git):\n${p}`)
      return null
    }
    settings.rememberRepo(p)
    return p
  })
}

function startServer () {
  return new Promise((resolve, reject) => {
    let server
    try { server = require('../server/index') } catch (e) { return reject(e) }
    serverListener = server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${serverListener.address().port}/`)
    })
    serverListener.on('error', reject)
  })
}

app.whenReady().then(async () => {
  try {
    const repoPath = await resolveRepoOrAsk()
    if (!repoPath) { app.quit(); return }
    process.env.GABBRO_REPO = repoPath
    const url = await startServer()
    createWindow(url)
    setupAutoUpdate()
  } catch (e) {
    dialog.showErrorBox('Gabbro — failed to start', String((e && e.message) || e))
    app.quit()
  }
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => {
  if (serverListener) { try { serverListener.close() } catch { /* noop */ } }
})
