'use strict'

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const cfg = require('./config')

const repoDir = path.join(cfg.dataDir, 'repo')
const BRANCH_RE = /^[\w./-]+$/

const state = {
  repoCloned: false,
  lastFetch: 0
}

// Git errors can echo the remote URL (which embeds the token) — always mask it.
function sanitize (msg) {
  let out = String(msg)
  if (cfg.gitToken) out = out.split(cfg.gitToken).join('***')
  return out.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@')
}

function git (args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd || repoDir, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(sanitize(`git ${args[0]} failed: ${(stderr || err.message).trim()}`))
        reject(e)
      } else {
        resolve(stdout)
      }
    })
  })
}

function remoteUrl () {
  if (cfg.isLocalRepo || !cfg.gitToken) return cfg.gitRepo
  const u = new URL(cfg.gitRepo)
  u.username = u.host.includes('github') ? 'x-access-token' : 'oauth2'
  u.password = cfg.gitToken
  return u.toString()
}

async function ensureClone () {
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    // Full clone on purpose: `git show origin/<branch>:<file>` needs all branches.
    await git(['clone', remoteUrl(), repoDir], { cwd: cfg.dataDir })
  }
  await git(['config', 'user.name', cfg.gitUserName])
  await git(['config', 'user.email', cfg.gitUserEmail])
  state.repoCloned = true
  state.lastFetch = Date.now()
}

async function fetchIfStale (force) {
  if (!state.repoCloned) return
  if (!force && Date.now() - state.lastFetch < cfg.fetchTtlMs) return
  await git(['fetch', 'origin', '--prune'])
  state.lastFetch = Date.now()
}

async function listBranches () {
  const out = await git(['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin'])
  return out.split('\n').map(b => b.trim()).filter(b => b && b !== 'HEAD')
}

async function showFileRaw (ref, file) {
  try {
    return await git(['show', `${ref}:${file}`])
  } catch (e) {
    return null
  }
}

async function showFile (branch, file) {
  if (!BRANCH_RE.test(branch)) {
    const e = new Error('invalid branch name')
    e.status = 400
    throw e
  }
  const branches = await listBranches()
  if (!branches.includes(branch)) return null
  return showFileRaw(`origin/${branch}`, file)
}

const DBML_TEMPLATE = `// ${cfg.dbmlFile} — created by Gabbro bootstrap
// Define your schema in DBML: https://dbml.dbdiagram.io/docs
//
// Example:
// Table users {
//   id int [pk, increment]
//   name varchar [not null]
// }
`

const POSITIONS_TEMPLATE = '{"version":1,"tables":{}}\n'

// Writes the file only if it does not already exist (add-only: bootstrap must
// never overwrite anything in a pre-existing repo).
function writeIfMissing (file, content) {
  const abs = path.join(repoDir, file)
  if (fs.existsSync(abs)) return
  fs.writeFileSync(abs, content)
}

async function bootstrap () {
  const branches = await listBranches()
  const hasOnMaster = branches.includes('master') && (await showFileRaw('origin/master', cfg.dbmlFile)) !== null
  const hasOnDevelop = branches.includes('develop') && (await showFileRaw('origin/develop', cfg.dbmlFile)) !== null
  if (hasOnMaster || hasOnDevelop) return

  if (branches.includes('master')) {
    await git(['checkout', '-B', 'master', 'origin/master'])
  } else if (branches.length > 0) {
    // Repo has content but no master: base it on the remote's first branch.
    await git(['checkout', '-B', 'master', `origin/${branches[0]}`])
  } else {
    // Empty repo: point the unborn HEAD at master (works whatever the default branch name is).
    await git(['symbolic-ref', 'HEAD', 'refs/heads/master'])
  }

  writeIfMissing(cfg.dbmlFile, DBML_TEMPLATE)
  writeIfMissing(cfg.positionsFile, POSITIONS_TEMPLATE)
  await git(['add', '--', cfg.dbmlFile, cfg.positionsFile])
  const status = await git(['status', '--porcelain', '--', cfg.dbmlFile, cfg.positionsFile])
  if (status.trim()) {
    await git(['commit', '-m', 'chore: gabbro bootstrap — base DBML and positions'])
  }
  await git(['push', 'origin', 'master'])

  if (branches.includes('develop')) {
    await git(['checkout', '-B', 'develop', 'origin/develop'])
    writeIfMissing(cfg.dbmlFile, DBML_TEMPLATE)
    writeIfMissing(cfg.positionsFile, POSITIONS_TEMPLATE)
    await git(['add', '--', cfg.dbmlFile, cfg.positionsFile])
    const st = await git(['status', '--porcelain', '--', cfg.dbmlFile, cfg.positionsFile])
    if (st.trim()) await git(['commit', '-m', 'chore: gabbro bootstrap — base DBML and positions'])
  } else {
    await git(['checkout', '-B', 'develop', 'master'])
  }
  await git(['push', 'origin', 'develop'])
  await fetchIfStale(true)
}

// In-memory mutex: concurrent PUTs are serialized into a promise queue so two
// commits never race over the same worktree.
let lock = Promise.resolve()

function commitPushFile (file, content, message) {
  const job = lock.then(() => doCommitPush(file, content, message))
  lock = job.catch(() => {})
  return job
}

async function doCommitPush (file, content, message) {
  await fetchIfStale(true)
  const b = cfg.editBranch
  const branches = await listBranches()
  if (branches.includes(b)) {
    await git(['checkout', '-B', b, `origin/${b}`])
  } else {
    await git(['checkout', '-B', b])
  }

  const writeAndAdd = async () => {
    fs.writeFileSync(path.join(repoDir, file), content)
    await git(['add', '--', file])
  }

  await writeAndAdd()
  const status = await git(['status', '--porcelain', '--', file])
  if (!status.trim()) return (await git(['rev-parse', 'HEAD'])).trim()

  await git(['commit', '-m', message])
  try {
    await git(['push', 'origin', b])
  } catch (e) {
    // Non-fast-forward (someone pushed meanwhile): rebuild the commit on the new tip, retry once.
    await fetchIfStale(true)
    await git(['checkout', '-B', b, `origin/${b}`])
    await writeAndAdd()
    const st = await git(['status', '--porcelain', '--', file])
    if (st.trim()) await git(['commit', '-m', message])
    await git(['push', 'origin', b])
  }
  return (await git(['rev-parse', 'HEAD'])).trim()
}

module.exports = {
  state,
  sanitize,
  ensureClone,
  bootstrap,
  fetchIfStale,
  listBranches,
  showFile,
  commitPushFile
}
