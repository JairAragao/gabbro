'use strict'

const fs = require('fs')
const path = require('path')
const express = require('express')
const cfg = require('./config')
const repo = require('./git')
const local = require('./local')
const settings = require('./settings')

const app = express()
app.use(express.json({ limit: '10mb' }))

// Local mode is unauthenticated on 127.0.0.1 — reject any non-loopback Host
// header (DNS rebinding: a malicious site resolving its own domain to
// 127.0.0.1 would send that domain as Host, which fails this check), and any
// state-changing request whose Origin is not loopback (CSRF via simple
// requests, e.g. a form POST from a web page — curl and same-origin have no
// Origin or a loopback one).
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i
if (cfg.mode === 'local') {
  app.use((req, res, next) => {
    const host = String(req.headers.host || '')
    if (!host || !LOCAL_HOST.test(host)) {
      return res.status(403).json({ error: 'forbidden: non-local host' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = String(req.headers.origin || '')
      if (origin && origin !== 'null' && !LOCAL_ORIGIN.test(origin)) {
        return res.status(403).json({ error: 'forbidden: non-local origin' })
      }
    }
    next()
  })
}

// Repo clone/bootstrap runs async on boot; API answers 503 until it is ready.
// Unconfigured (Electron welcome screen) is NOT 503 — the front must not
// retry, it must show the welcome screen (409 + code). /repo stays reachable
// so the welcome screen can list recents and configure the first repo.
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/repo') return next()
  if (!cfg.configured()) {
    return res.status(409).json({ error: 'no repository configured', code: 'unconfigured' })
  }
  if (!repo.state.repoCloned) return res.status(503).json({ error: 'repository not ready' })
  next()
})

const wrap = fn => (req, res, next) => fn(req, res).catch(next)

app.get('/api/health', (req, res) => {
  if (repo.state.initError) {
    return res.status(503).json({ ok: false, error: 'repository init failed', repoCloned: false })
  }
  res.json({ ok: true, configured: cfg.configured(), repoCloned: repo.state.repoCloned, lastFetch: repo.state.lastFetch })
})

app.get('/api/config', wrap(async (req, res) => {
  const base = {
    mode: cfg.mode,
    dbmlFile: cfg.dbmlFile,
    editBranch: cfg.editBranch,
    repoName: cfg.repoName,
    repoPath: cfg.mode === 'local' ? cfg.repoDir() : null
  }
  if (cfg.mode === 'local') {
    const id = await local.getIdentity()
    const identity = id.name && id.email ? id : null
    return res.json({
      ...base,
      identity,
      currentBranch: await local.currentBranch(),
      // Derived, never configured: without identity the local app degrades
      // gracefully to a pure reader (view/docs/diff/history keep working).
      readOnly: !identity
    })
  }
  res.json({ ...base, identity: null, currentBranch: cfg.editBranch, readOnly: false })
}))

app.get('/api/branches', wrap(async (req, res) => {
  await repo.fetchIfStale(false)
  res.json(await repo.listBranches())
}))

app.get('/api/dbml/:branch', wrap(async (req, res) => {
  await repo.fetchIfStale(false)
  const content = await repo.showFile(req.params.branch, cfg.dbmlFile)
  if (content === null) return res.status(404).json({ error: 'branch or file not found' })
  res.type('text/plain').send(content)
}))

// Positions are presentation, not schema. Hosted: always from the edit branch
// (every branch renders with the same coordinates). Local: straight from the
// worktree of the current branch.
app.get('/api/positions', wrap(async (req, res) => {
  if (cfg.mode === 'local') {
    let content = null
    try {
      content = fs.readFileSync(path.join(cfg.repoDir(), cfg.positionsFile), 'utf8')
    } catch {
      content = null
    }
    if (content === null) return res.json({ version: 1, tables: {} })
    return res.type('application/json').send(content)
  }
  await repo.fetchIfStale(false)
  const content = await repo.showFile(cfg.editBranch, cfg.positionsFile)
  if (content === null) return res.json({ version: 1, tables: {} })
  res.type('application/json').send(content)
}))

// Local writes require the client to say WHICH branch it is editing — the
// commit lands on the current branch only, 409 if the client is stale.
function requireBranch (body) {
  const b = body && body.branch
  if (typeof b !== 'string' || !b.trim()) {
    const e = new Error('body must include branch (the branch being edited)')
    e.status = 400
    throw e
  }
  return b.trim()
}

app.put('/api/dbml', wrap(async (req, res) => {
  const { content, message } = req.body || {}
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'body must be {content: string, message?: string}' })
  }
  const msg = typeof message === 'string' && message.trim()
    ? message.replace(/\s+/g, ' ').trim().slice(0, 200)
    : 'update via gabbro'
  if (cfg.mode === 'local') {
    const branch = requireBranch(req.body)
    const r = await local.commitFile(cfg.dbmlFile, content, `docs(dbml): ${msg}`, branch)
    return res.json({ ok: true, branch: r.branch, commit: r.commit, warning: r.warning })
  }
  const commit = await repo.commitPushFile(cfg.dbmlFile, content, `docs(dbml): ${msg}`)
  res.json({ ok: true, branch: cfg.editBranch, commit })
}))

app.put('/api/positions', wrap(async (req, res) => {
  const p = req.body
  const badShape = !p || typeof p !== 'object' || Array.isArray(p) ||
    typeof p.version !== 'number' ||
    !p.tables || typeof p.tables !== 'object' || Array.isArray(p.tables) ||
    Object.values(p.tables).some(t =>
      !t || typeof t !== 'object' ||
      typeof t.x !== 'number' || !Number.isFinite(t.x) ||
      typeof t.y !== 'number' || !Number.isFinite(t.y))
  if (badShape) {
    return res.status(400).json({ error: 'body must be {version: number, tables: {name: {x: number, y: number}}}' })
  }
  const branch = cfg.mode === 'local' ? requireBranch(req.body) : null
  delete p.branch // transport-only field — must never land in the committed file
  p.updated_at = new Date().toISOString()
  const json = JSON.stringify(p, null, 2) + '\n'
  if (cfg.mode === 'local') {
    const r = await local.commitFile(cfg.positionsFile, json, 'chore(positions): update via gabbro', branch)
    return res.json({ ok: true, branch: r.branch, commit: r.commit, warning: r.warning })
  }
  const commit = await repo.commitPushFile(cfg.positionsFile, json, 'chore(positions): update via gabbro')
  res.json({ ok: true, branch: cfg.editBranch, commit })
}))

app.post('/api/refresh', wrap(async (req, res) => {
  await repo.fetchIfStale(true)
  res.json({ ok: true, lastFetch: repo.state.lastFetch })
}))

function localOnly (res) {
  if (cfg.mode !== 'local') {
    res.status(400).json({ error: 'this endpoint is local-mode only' })
    return false
  }
  return true
}

app.post('/api/sync', wrap(async (req, res) => {
  if (!localOnly(res)) return
  const r = await local.sync()
  repo.state.lastFetch = Date.now()
  res.json({ ...r, syncState: await local.syncState() })
}))

app.get('/api/sync-state', wrap(async (req, res) => {
  if (!localOnly(res)) return
  await repo.fetchIfStale(false) // best-effort in local mode (never throws)
  res.json(await local.syncState())
}))

app.get('/api/repo', (req, res) => {
  // Hosted: never expose local filesystem paths/recents of the host machine.
  if (cfg.mode !== 'local') {
    return res.json({ mode: cfg.mode, configured: true, path: null, repoName: cfg.repoName, recents: [] })
  }
  const s = settings.read()
  res.json({
    mode: cfg.mode,
    configured: cfg.configured(),
    path: cfg.configured() ? cfg.repoDir() : null,
    repoName: cfg.repoName,
    recents: Array.isArray(s.recentRepos) ? s.recentRepos.filter(p => typeof p === 'string') : []
  })
})

// Switch the local instance to another clone. The path must be an existing
// git worktree — no cloning, gabbro only ever operates on repos the user has.
app.put('/api/repo', wrap(async (req, res) => {
  if (!localOnly(res)) return
  const p = req.body && req.body.path
  if (typeof p !== 'string' || !p.trim()) {
    return res.status(400).json({ error: 'body must be {path: string}' })
  }
  const abs = path.resolve(p.trim())
  if (!fs.existsSync(path.join(abs, '.git'))) {
    return res.status(400).json({ error: `not a git repository (missing .git): ${abs}` })
  }
  // Serialized so the switch never lands mid-commit of the previous repo.
  await repo.serialize(async () => {
    cfg.setRepo(abs)
    cfg.autoDetectDbml()
    local.onRepoSwitch()
    repo.state.lastFetch = 0
    repo.state.initError = null
    repo.initLocal() // first configuration after an unconfigured boot flips repoCloned
    settings.rememberRepo(abs)
  })
  res.json({ ok: true, path: abs, repoName: cfg.repoName, currentBranch: await local.currentBranch() })
}))

// Only the two tracked files are inspectable — anything else is 400 (never a
// free file-content oracle over the repo).
function historyFile (q) {
  if (!q) return null
  if (q !== cfg.dbmlFile && q !== cfg.positionsFile) {
    const e = new Error(`file must be ${cfg.dbmlFile} or ${cfg.positionsFile}`)
    e.status = 400
    throw e
  }
  return q
}

async function historyRef (branchQ) {
  if (cfg.mode === 'local') {
    if (!branchQ) return 'HEAD'
    const branches = await repo.listBranches()
    if (!branches.includes(branchQ)) {
      const e = new Error('branch not found')
      e.status = 404
      throw e
    }
    return `refs/heads/${branchQ}`
  }
  await repo.fetchIfStale(false)
  const b = branchQ || cfg.editBranch
  const branches = await repo.listBranches()
  if (!branches.includes(b)) {
    const e = new Error('branch not found')
    e.status = 404
    throw e
  }
  return `origin/${b}`
}

app.get('/api/history', wrap(async (req, res) => {
  const ref = await historyRef(req.query.branch)
  res.json(await repo.logAll({
    skip: req.query.skip,
    limit: req.query.limit,
    file: historyFile(req.query.file),
    ref
  }))
}))

// Content + parent content of one tracked file at a commit — the front parses
// both and renders the structural diff. Root commit → parentContent ''.
app.get('/api/commit/:hash', wrap(async (req, res) => {
  const full = await repo.resolveCommit(req.params.hash)
  if (!full) return res.status(404).json({ error: 'commit not found' })
  const file = historyFile(req.query.file) || cfg.dbmlFile
  const [content, parentContent, meta] = await Promise.all([
    repo.showAt(full, file),
    repo.showAt(`${full}^`, file),
    repo.commitMeta(full)
  ])
  res.json({ content, parentContent, meta })
}))

app.get('/api/commit/:hash/diff', wrap(async (req, res) => {
  const full = await repo.resolveCommit(req.params.hash)
  if (!full) return res.status(404).json({ error: 'commit not found' })
  const file = historyFile(req.query.file) || cfg.dbmlFile
  res.type('text/plain').send(await repo.diffFile(full, file))
}))

app.use(express.static(path.join(__dirname, '..', 'public')))

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : err.expose ? 400 : 500)
  console.error(repo.sanitize(err.message))
  res.status(status).json({ error: repo.sanitize(err.message) })
})

// Auto-listen under plain node (CLI/`npm start`). Under Electron the main
// process requires this module and controls the listen itself (free port,
// 127.0.0.1) — basalt pattern.
if (!process.versions.electron) {
  // Local: bind loopback only (unauthenticated API must never reach the LAN).
  // Hosted: 0.0.0.0 as in v1 (Docker/Dokploy).
  const bindHost = cfg.mode === 'local' ? '127.0.0.1' : '0.0.0.0'
  const server = app.listen(cfg.port, bindHost, () => {
    console.log(`gabbro (${cfg.mode}) listening on ${bindHost}:${cfg.port} — repo ${cfg.repoName}` +
      (cfg.mode === 'hosted' ? `, edit branch ${cfg.editBranch}` : ''))
  })
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
      console.error(`port ${cfg.port} is already in use — is another gabbro (or app) running on it?`)
      process.exit(1)
    }
    throw e
  })
}

module.exports = app

if (cfg.mode === 'local') {
  // Operate directly on the user's clone — no intermediate clone, no bootstrap,
  // no identity injection. Unconfigured boot: nothing to init — the welcome
  // screen configures the first repo via PUT /api/repo.
  if (!cfg.configured()) {
    console.log('no repository configured yet — waiting for the welcome screen')
  } else {
    try {
      cfg.autoDetectDbml()
      repo.initLocal()
      console.log(`repository ready (local worktree ${cfg.repoDir()})`)
    } catch (e) {
      repo.state.initError = repo.sanitize(e.message)
      console.error(`repository init failed: ${repo.state.initError}`)
    }
  }
} else {
  repo.ensureClone()
    .then(() => repo.bootstrap())
    .then(() => console.log('repository ready'))
    .catch(e => {
      repo.state.initError = repo.sanitize(e.message)
      console.error(`repository init failed: ${repo.state.initError}`)
    })
}
