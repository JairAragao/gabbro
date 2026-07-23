// Basalt pattern: start the EXISTING express backend on a free loopback port
// and open a window on that URL (same origin, no CORS). A frameless splash
// covers the boot; the main window reveals when the renderer signals ready.

'use strict'

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron')
// electron-updater carrega o app.getVersion() no require — lazy pra não
// quebrar em dev (electron . / não empacotado); só instancia ao atualizar
let _autoUpdater = null
function autoUpdater () {
  if (!_autoUpdater) _autoUpdater = require('electron-updater').autoUpdater
  return _autoUpdater
}

Menu.setApplicationMenu(null)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

const APP_ICON = path.join(__dirname, 'icon.png')

let mainWindow = null
let splashWin = null
let serverListener = null
let revealed = false
let splashAt = 0
const MIN_SPLASH_MS = 2400 // the splash bar fills in ~2.2s

// Opens instantly (tiny local HTML) while the backend boots and the renderer
// loads. Frameless, same size as the main window, always on top until reveal.
function createSplash () {
  splashWin = new BrowserWindow({
    width: 1280,
    height: 820,
    frame: false,
    center: true,
    backgroundColor: '#0b0e12',
    skipTaskbar: true,
    alwaysOnTop: true,
    show: true,
    icon: APP_ICON
  })
  splashWin.maximize() // matches the maximized main window
  splashWin.loadFile(path.join(__dirname, 'splash.html'))
  splashWin.on('closed', () => { splashWin = null })
  splashAt = Date.now()
}

// Shows the main window and closes the splash (idempotent, honors the
// minimum splash time so the bar animation completes).
function reveal () {
  if (revealed) return
  const waited = splashAt ? Date.now() - splashAt : MIN_SPLASH_MS
  if (waited < MIN_SPLASH_MS) { setTimeout(reveal, MIN_SPLASH_MS - waited); return }
  revealed = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    // maximize() already SHOWS the window — that's why it runs here and not at
    // creation, otherwise the app would flash before the splash finished.
    mainWindow.maximize()
    if (!mainWindow.isVisible()) mainWindow.show()
  }
  if (splashWin) { splashWin.close(); splashWin = null }
}

function createWindow (url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false, // revealed when the renderer signals ready (closes the splash)
    frame: false, // barra de título custom (logo + repo + modo na própria barra)
    backgroundColor: '#1a1f21',
    title: 'Gabbro',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.loadURL(url)

  // Reveal fallbacks in case the renderer never signals (the IPC path wins).
  mainWindow.webContents.once('did-finish-load', () => setTimeout(reveal, 5000))
  setTimeout(reveal, 12000) // hard fallback

  // avisa o renderer quando maximiza/restaura (ícone do botão alterna)
  const sendMax = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMax)
  mainWindow.on('unmaximize', sendMax)

  // External links open in the default browser, not an Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) { shell.openExternal(target); return { action: 'deny' } }
    return { action: 'allow' }
  })
  mainWindow.on('closed', () => { mainWindow = null })
}

// Renderer finished booting (welcome screen or full app) → reveal.
ipcMain.on('app:ready', () => reveal())

// Auto-update from public GitHub Releases (no token). Downloads in background;
// the renderer shows a "restart to update" banner (update:status IPC), no
// native dialogs.
const UPDATE_INTERVAL_MS = 3 * 60 * 60 * 1000
let updateReady = false
let updTimer = null

// O intervalo escolhido na aba Atualizações persiste em ~/.gabbro/settings.json
// (via IPC) — assim o "Desligado" vale já no BOOT, antes de o renderer subir.
function savedUpdInterval () {
  try {
    const s = require('../server/settings').read()
    const v = Number(s.updateIntervalMs)
    return Number.isFinite(v) && v >= 0 ? v : UPDATE_INTERVAL_MS
  } catch (e) {
    return UPDATE_INTERVAL_MS
  }
}
let updIntervalMs = savedUpdInterval()

function sendUpdStatus (state, extra) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', { state, ...(extra || {}) })
  }
}

function checkForUpdates () {
  if (!app.isPackaged) { sendUpdStatus('uptodate'); return }
  autoUpdater().checkForUpdates().catch(e => {
    console.error('[updater] check', (e && e.message) || e)
    sendUpdStatus('error')
  })
}

// 0 = desligado. O renderer manda o intervalo salvo (aba Atualizações).
function scheduleUpdateChecks () {
  if (updTimer) { clearInterval(updTimer); updTimer = null }
  if (updIntervalMs > 0) updTimer = setInterval(checkForUpdates, updIntervalMs)
}

function setupAutoUpdate () {
  if (!app.isPackaged || updateReady) return
  updateReady = true
  const au = autoUpdater()
  au.autoDownload = true
  au.autoInstallOnAppQuit = true
  au.on('checking-for-update', () => sendUpdStatus('checking'))
  au.on('update-not-available', () => sendUpdStatus('uptodate'))
  au.on('update-available', info => sendUpdStatus('available', { version: info && info.version }))
  au.on('download-progress', p => sendUpdStatus('downloading', { percent: Math.round((p && p.percent) || 0) }))
  au.on('update-downloaded', info => sendUpdStatus('downloaded', { version: info && info.version }))
  au.on('error', e => {
    console.error('[updater]', (e && e.message) || e)
    sendUpdStatus('error')
  })
  // intervalo 0 = desligado: nada de check nem download automático no boot
  if (updIntervalMs > 0) {
    checkForUpdates()
    scheduleUpdateChecks()
  }
}

// controles da janela frameless (barra de título custom)
ipcMain.on('window:minimize', () => { if (mainWindow) mainWindow.minimize() })
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize()
})
ipcMain.on('window:close', () => { if (mainWindow) mainWindow.close() })
ipcMain.handle('window:isMaximized', () => !!(mainWindow && mainWindow.isMaximized()))

ipcMain.on('update:install', () => {
  // silent NSIS install + relaunch (the assisted wizard stays manual-install-only)
  try { autoUpdater().quitAndInstall(true, true) } catch (e) { console.error('[updater] install', (e && e.message) || e) }
})

ipcMain.on('update:check', () => checkForUpdates())

ipcMain.on('update:set-interval', (_e, ms) => {
  const v = Number(ms)
  updIntervalMs = Number.isFinite(v) && v >= 0 ? v : UPDATE_INTERVAL_MS
  try {
    const settings = require('../server/settings')
    const s = settings.read()
    s.updateIntervalMs = updIntervalMs
    settings.write(s)
  } catch (e) { console.error('[updater] persist interval', (e && e.message) || e) }
  if (updateReady) scheduleUpdateChecks()
})

ipcMain.handle('dialog:pickFolder', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Escolha um clone git (repo com o arquivo DBML)',
    properties: ['openDirectory']
  })
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0]
})

// Resolve the saved repo BEFORE requiring the server (config.js reads env at
// require time). No repo saved (or gone) → the server boots UNCONFIGURED and
// the renderer shows the welcome screen — never a blocking native dialog.
function resolveSavedRepo () {
  const settings = require('../server/settings')
  const s = settings.read()
  if (typeof s.lastRepo === 'string' && s.lastRepo && fs.existsSync(path.join(s.lastRepo, '.git'))) {
    return s.lastRepo
  }
  return null
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
  createSplash()
  try {
    const repoPath = resolveSavedRepo()
    if (repoPath) process.env.GABBRO_REPO = repoPath
    const url = await startServer()
    createWindow(url)
    setupAutoUpdate()
  } catch (e) {
    if (splashWin) { splashWin.close(); splashWin = null }
    dialog.showErrorBox('Gabbro — falha ao iniciar', String((e && e.message) || e))
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
