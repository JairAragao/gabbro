'use strict'

const path = require('path')
const express = require('express')
const cfg = require('./config')
const repo = require('./git')

const app = express()
app.use(express.json({ limit: '10mb' }))

// Repo clone/bootstrap runs async on boot; API answers 503 until it is ready.
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next()
  if (!repo.state.repoCloned) return res.status(503).json({ error: 'repository not ready' })
  next()
})

const wrap = fn => (req, res, next) => fn(req, res).catch(next)

app.get('/api/health', (req, res) => {
  if (repo.state.initError) {
    return res.status(503).json({ ok: false, error: 'repository init failed', repoCloned: false })
  }
  res.json({ ok: true, repoCloned: repo.state.repoCloned, lastFetch: repo.state.lastFetch })
})

app.get('/api/config', (req, res) => {
  res.json({ dbmlFile: cfg.dbmlFile, editBranch: cfg.editBranch, repoName: cfg.repoName })
})

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

// Positions always come from the edit branch: layout is presentation, not
// schema — every branch renders with the same coordinates.
app.get('/api/positions', wrap(async (req, res) => {
  await repo.fetchIfStale(false)
  const content = await repo.showFile(cfg.editBranch, cfg.positionsFile)
  if (content === null) return res.json({ version: 1, tables: {} })
  res.type('application/json').send(content)
}))

app.put('/api/dbml', wrap(async (req, res) => {
  const { content, message } = req.body || {}
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'body must be {content: string, message?: string}' })
  }
  const msg = typeof message === 'string' && message.trim()
    ? message.replace(/\s+/g, ' ').trim().slice(0, 200)
    : 'update via gabbro'
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
  p.updated_at = new Date().toISOString()
  const commit = await repo.commitPushFile(
    cfg.positionsFile, JSON.stringify(p, null, 2) + '\n', 'chore(positions): update via gabbro')
  res.json({ ok: true, branch: cfg.editBranch, commit })
}))

app.post('/api/refresh', wrap(async (req, res) => {
  await repo.fetchIfStale(true)
  res.json({ ok: true, lastFetch: repo.state.lastFetch })
}))

app.use(express.static(path.join(__dirname, '..', 'public')))

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : err.expose ? 400 : 500)
  console.error(repo.sanitize(err.message))
  res.status(status).json({ error: repo.sanitize(err.message) })
})

app.listen(cfg.port, () => {
  console.log(`gabbro listening on :${cfg.port} — repo ${cfg.repoName}, edit branch ${cfg.editBranch}`)
})

repo.ensureClone()
  .then(() => repo.bootstrap())
  .then(() => console.log('repository ready'))
  .catch(e => {
    repo.state.initError = repo.sanitize(e.message)
    console.error(`repository init failed: ${repo.state.initError}`)
  })
