'use strict'

const fs = require('fs')
const path = require('path')

const settings = require('./settings')

const env = process.env

// Repo resolution priority: CLI arg (bin/gabbro.js injects GABBRO_REPO) >
// saved lastRepo (~/.gabbro/settings.json) > env GIT_REPO (the v1/hosted path).
function resolveRepo () {
  const cli = (env.GABBRO_REPO || '').trim()
  if (cli) return cli
  const s = settings.read()
  const last = typeof s.lastRepo === 'string' ? s.lastRepo.trim() : ''
  if (last && fs.existsSync(last)) return last
  return (env.GIT_REPO || '').trim()
}

const gitRepo = resolveRepo()
// Under Electron the app may boot with NO repo — the renderer shows the
// welcome screen and configures one via PUT /api/repo. Plain node/CLI keeps
// the hard error (nothing would ever configure it there).
if (!gitRepo && !process.versions.electron) {
  console.error('sem repositório: rode `gabbro <caminho>` ou defina GIT_REPO (URL https ou caminho local)')
  process.exit(1)
}

const isUrl = /^https?:\/\//i.test(gitRepo)

// URL → hosted (v1 Dokploy path, untouched). Local path WITH a .git dir →
// local (operate directly on the user's clone, their identity/credentials/
// branch). Path without .git keeps the v1 behavior (clone into DATA_DIR).
// GABBRO_MODE=hosted|local overrides the detection.
function detectMode () {
  if (!gitRepo) return 'local' // unconfigured Electron boot — welcome screen
  const override = (env.GABBRO_MODE || '').trim().toLowerCase()
  if (override === 'hosted' || override === 'local') return override
  if (isUrl) return 'hosted'
  if (fs.existsSync(path.join(path.resolve(gitRepo), '.git'))) return 'local'
  return 'hosted'
}

const mode = detectMode()

function deriveName (s) {
  return (String(s).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo').replace(/\.git$/, '')
}

module.exports = {
  port: parseInt(env.PORT, 10) || 8080,
  gitRepo,
  mode,
  isLocalRepo: !isUrl,
  gitToken: env.GIT_TOKEN || '',
  dbmlFile: env.DBML_FILE || 'database.dbml',
  positionsFile: 'positions.json',
  editBranch: env.EDIT_BRANCH || 'develop',
  fetchTtlMs: parseInt(env.GIT_FETCH_TTL_MS, 10) || 60000,
  dataDir: path.resolve(env.DATA_DIR || '/data'),
  gitUserName: env.GIT_USER_NAME || 'gabbro',
  gitUserEmail: env.GIT_USER_EMAIL || 'gabbro@local',
  repoPath: mode === 'local' && gitRepo ? path.resolve(gitRepo) : null,
  repoName: gitRepo ? deriveName(gitRepo) : '',

  // False only on the unconfigured Electron boot (local mode, no repo yet).
  configured () {
    return this.mode !== 'local' || !!this.repoPath
  },

  // Local mode: when the configured DBML file is absent from the worktree
  // root, fall back to the (alphabetically first) *.dbml found there — repos
  // name it differently (db.dbml, schema.dbml) and the desktop app has no env
  // to tune per repo. Re-evaluated from the default on every repo switch.
  autoDetectDbml () {
    if (this.mode !== 'local' || !this.repoPath) return
    this.dbmlFile = env.DBML_FILE || 'database.dbml'
    if (fs.existsSync(path.join(this.repoPath, this.dbmlFile))) return
    try {
      const found = fs.readdirSync(this.repoPath).filter(f => f.toLowerCase().endsWith('.dbml')).sort()
      if (found.length) this.dbmlFile = found[0]
    } catch { /* unreadable dir — keep the default */ }
  },

  repoDir () {
    return this.mode === 'local' ? this.repoPath : path.join(this.dataDir, 'repo')
  },

  // Caller (PUT /api/repo) validates the path has .git.
  setRepo (p) {
    const abs = path.resolve(p)
    this.gitRepo = abs
    this.repoPath = abs
    this.repoName = deriveName(abs)
  }
}
