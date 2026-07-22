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
if (!gitRepo) {
  console.error('no repository: run `gabbro <path>` or set GIT_REPO (https URL or local filesystem path)')
  process.exit(1)
}

const isUrl = /^https?:\/\//i.test(gitRepo)

// URL → hosted (v1 Dokploy path, untouched). Local path WITH a .git dir →
// local (operate directly on the user's clone, their identity/credentials/
// branch). Path without .git keeps the v1 behavior (clone into DATA_DIR).
// GABBRO_MODE=hosted|local overrides the detection.
function detectMode () {
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
  repoPath: mode === 'local' ? path.resolve(gitRepo) : null,
  repoName: deriveName(gitRepo),

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
