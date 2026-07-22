'use strict'

// ~/.gabbro/settings.json — persisted user preferences for local mode
// (last opened repo + recents). Atomic write (tmp + rename) so a crash
// mid-write never corrupts the file.

const fs = require('fs')
const os = require('os')
const path = require('path')

const SETTINGS_DIR = path.join(os.homedir(), '.gabbro')
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json')

function read () {
  try {
    const obj = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

function write (obj) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true })
  const tmp = SETTINGS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, SETTINGS_FILE)
}

// Records a repo as the last one opened and prepends it to the recents list
// (deduped, capped at 10).
function rememberRepo (repoPath) {
  const s = read()
  s.lastRepo = repoPath
  const recents = Array.isArray(s.recentRepos)
    ? s.recentRepos.filter(p => typeof p === 'string' && p !== repoPath)
    : []
  recents.unshift(repoPath)
  s.recentRepos = recents.slice(0, 10)
  write(s)
  return s
}

module.exports = { read, write, rememberRepo, SETTINGS_FILE }
