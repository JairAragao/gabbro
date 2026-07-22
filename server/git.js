'use strict'

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const cfg = require('./config')

const BRANCH_RE = /^[\w./-]+$/

const state = {
  repoCloned: false,
  lastFetch: 0,
  initError: null
}

// Git errors can echo the remote URL (which embeds the token) — always mask it.
function sanitize (msg) {
  let out = String(msg)
  if (cfg.gitToken) out = out.split(cfg.gitToken).join('***')
  return out.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@')
}

function git (args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: opts.cwd || cfg.repoDir(),
      maxBuffer: 64 * 1024 * 1024,
      // Never hang waiting for a password prompt — fail fast instead (push/
      // fetch against an authenticated remote without a credential helper).
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    }, (err, stdout, stderr) => {
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

// Hosted-only: clones into DATA_DIR and sets the service identity. Local mode
// never runs this — it operates directly on the user's clone with THEIR
// identity (never a fake one).
async function ensureClone () {
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  if (!fs.existsSync(path.join(cfg.repoDir(), '.git'))) {
    // Full clone on purpose: `git show origin/<branch>:<file>` needs all branches.
    await git(['clone', remoteUrl(), cfg.repoDir()], { cwd: cfg.dataDir })
  }
  await git(['config', 'user.name', cfg.gitUserName])
  await git(['config', 'user.email', cfg.gitUserEmail])
  state.repoCloned = true
  state.lastFetch = Date.now()
}

// Local-mode init: no clone, just validate the worktree and mark ready.
function initLocal () {
  if (!fs.existsSync(path.join(cfg.repoDir(), '.git'))) {
    throw new Error(`not a git repository (missing .git): ${cfg.repoDir()}`)
  }
  state.repoCloned = true
  state.lastFetch = 0
}

async function fetchIfStale (force) {
  if (!state.repoCloned) return
  if (!force && Date.now() - state.lastFetch < cfg.fetchTtlMs) return
  try {
    await git(['fetch', 'origin', '--prune'])
  } catch (e) {
    // Local clones may have no remote (or no credentials) — reads must keep
    // working; only the hosted path treats a failed fetch as fatal.
    if (cfg.mode !== 'local') throw e
  }
  state.lastFetch = Date.now()
}

// Local: the user's local branches (no origin/ prefix — what they can actually
// check out and edit). Hosted: remote branches as in v1.
async function listBranches () {
  if (cfg.mode === 'local') {
    const out = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    return out.split('\n').map(b => b.trim()).filter(Boolean)
  }
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
  if (cfg.mode === 'local') {
    // Current branch reads straight from the worktree (shows the user's real
    // state, including uncommitted edits); other local branches via git show.
    const cur = await require('./local').currentBranch()
    if (branch === cur) {
      try {
        return fs.readFileSync(path.join(cfg.repoDir(), file), 'utf8')
      } catch {
        return null
      }
    }
    return showFileRaw(`refs/heads/${branch}`, file)
  }
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
  const abs = path.join(cfg.repoDir(), file)
  if (fs.existsSync(abs)) return
  fs.writeFileSync(abs, content)
}

async function bootstrap () {
  const branches = await listBranches()
  const hasOnMaster = branches.includes('master') && (await showFileRaw('origin/master', cfg.dbmlFile)) !== null
  const hasOnDevelop = branches.includes('develop') && (await showFileRaw('origin/develop', cfg.dbmlFile)) !== null
  if (hasOnMaster || hasOnDevelop) {
    // DBML already tracked, but the edit branch may still be missing (e.g. repo only has master).
    if (!branches.includes(cfg.editBranch)) {
      const base = branches.includes('master') ? 'origin/master' : `origin/${branches[0]}`
      await git(['checkout', '-B', cfg.editBranch, base])
      await git(['push', 'origin', cfg.editBranch])
      await fetchIfStale(true)
    }
    return
  }

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

// In-memory mutex: concurrent git writes (hosted PUTs, local commits and sync)
// are serialized into a promise queue so two operations never race over the
// same worktree/index.
let lock = Promise.resolve()

function serialize (fn) {
  const job = lock.then(fn)
  lock = job.catch(() => {})
  return job
}

// Hosted-only write path: rebuilds the edit branch from origin and pushes with
// the service identity. Local mode commits via local.commitFile instead.
function commitPushFile (file, content, message) {
  return serialize(() => doCommitPush(file, content, message))
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
    fs.writeFileSync(path.join(cfg.repoDir(), file), content)
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

// ── History ──────────────────────────────────────────────────────────────────
// logAll: paginated commit log of `ref`, filtered to the tracked files (or one
// specific file). Field separator \x1f, record marker \x1e (never appear in
// commit metadata). Asks for limit+1 to know hasMore without a separate count.
async function logAll ({ skip = 0, limit = 30, file = null, ref = 'HEAD' } = {}) {
  const off = Math.max(0, Number(skip) || 0)
  const lim = Math.min(200, Math.max(1, Number(limit) || 30))
  const MARK = '\x1eCMT\x1f'
  const FMT = `${MARK}%H%x1f%h%x1f%aI%x1f%an%x1f%ae%x1f%s`
  const paths = file ? [file] : [cfg.dbmlFile, cfg.positionsFile]
  let out
  try {
    out = await git([
      'log', `--format=${FMT}`, '--name-only',
      `--skip=${off}`, `--max-count=${lim + 1}`, ref, '--', ...paths
    ])
  } catch (e) {
    if (/does not have any commits|bad revision|unknown revision/i.test(e.message)) {
      return { commits: [], hasMore: false }
    }
    throw e
  }
  const parts = String(out || '').split(MARK).filter(s => s && s.trim())
  const commits = []
  for (const p of parts) {
    const nl = p.indexOf('\n')
    const headLine = nl === -1 ? p : p.slice(0, nl)
    const rest = nl === -1 ? '' : p.slice(nl + 1)
    const [hash, shortHash, date, authorName, authorEmail, message] = headLine.split('\x1f')
    commits.push({
      hash: (hash || '').trim(),
      shortHash: (shortHash || '').trim(),
      date: (date || '').trim(),
      authorName: (authorName || '').trim(),
      authorEmail: (authorEmail || '').trim(),
      message: (message || '').trim(),
      files: rest.split('\n').map(l => l.trim()).filter(Boolean)
    })
  }
  const hasMore = commits.length > lim
  return { commits: commits.slice(0, lim), hasMore }
}

// showAt: file content at `ref` (e.g. "<hash>", "<hash>^"). Missing path or
// unresolvable ref (root commit's parent) → '' — history diffs against empty.
async function showAt (ref, file) {
  try {
    return await git(['show', `${ref}:${file}`])
  } catch (e) {
    if (/exists on disk, but not in|does not exist|unknown revision|bad revision|invalid object|fatal: path/i.test(e.message)) {
      return ''
    }
    throw e
  }
}

// Resolves any revision expression to a full commit SHA, '' when it does not
// exist. Internal — takes git syntax like "<hash>^".
async function resolveRev (expr) {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', `${expr}^{commit}`])).trim() || ''
  } catch {
    return ''
  }
}

// resolveCommit: user-facing — validates the hash FORMAT (400) before touching
// git, then resolves to the full SHA ('' when unknown → route answers 404).
async function resolveCommit (hash) {
  if (!/^[0-9a-f]{4,40}$/i.test(String(hash || ''))) {
    const e = new Error('invalid commit hash')
    e.status = 400
    throw e
  }
  return resolveRev(hash)
}

// Empty-tree hash: diff base for root commits. hash-object keeps it correct on
// SHA-256 repos; fallback is the well-known SHA-1 constant.
let _emptyTree = null
async function emptyTreeHash () {
  if (_emptyTree) return _emptyTree
  try {
    _emptyTree = (await git(['hash-object', '-t', 'tree', process.platform === 'win32' ? 'NUL' : '/dev/null'])).trim()
  } catch {
    _emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  }
  return _emptyTree
}

// Unified text diff of one file between a commit and its parent (empty tree
// for the root commit).
async function diffFile (hash, file) {
  let base = await resolveRev(`${hash}^`)
  if (!base) base = await emptyTreeHash()
  return git(['diff', base, hash, '--', file])
}

// Metadata of a single commit (for the /api/commit/:hash response).
async function commitMeta (hash) {
  const FMT = '%H%x1f%h%x1f%aI%x1f%an%x1f%ae%x1f%s'
  const out = await git(['log', '-1', `--format=${FMT}`, hash])
  const [h, shortHash, date, authorName, authorEmail, message] = out.trim().split('\x1f')
  return { hash: h, shortHash, date, authorName, authorEmail, message }
}

module.exports = {
  state,
  git,
  sanitize,
  ensureClone,
  initLocal,
  bootstrap,
  fetchIfStale,
  listBranches,
  showFile,
  serialize,
  commitPushFile,
  logAll,
  showAt,
  resolveCommit,
  emptyTreeHash,
  diffFile,
  commitMeta
}
