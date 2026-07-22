'use strict'

// Local-mode git operations: the server works directly on the user's clone,
// with the user's own identity, credentials and checked-out branch. Patterns
// ported from basalt/server/git.js to plain execFile (no simple-git).
//
// Contract: commit is awaited (fast, local); push runs in background,
// coalesced and best-effort — a push failure never breaks the local write, it
// accumulates as a warning surfaced on the next response and in sync-state.

const fs = require('fs')
const path = require('path')
const cfg = require('./config')
const { git, serialize } = require('./git')

function oneLine (s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
}

// ── Identity ─────────────────────────────────────────────────────────────────
// Effective user.name/user.email (local > global). null per missing field —
// NEVER a hardcoded fallback (attribution must be real).
async function getIdentity () {
  let name = null
  let email = null
  try { name = (await git(['config', '--get', 'user.name'])).trim() || null } catch { name = null }
  try { email = (await git(['config', '--get', 'user.email'])).trim() || null } catch { email = null }
  return { name, email }
}

// Throws 422 when the repo has no usable identity — the route surfaces the fix.
async function ensureIdentity () {
  const id = await getIdentity()
  if (!id.name || !id.email) {
    const e = new Error('git identity not configured — run: git config --global user.name "Your Name" && git config --global user.email "you@example.com"')
    e.status = 422
    throw e
  }
  return id
}

// ── Branch state ─────────────────────────────────────────────────────────────
// Checked-out branch name, or null when HEAD is detached. symbolic-ref (not
// rev-parse) so an unborn branch in a fresh repo still resolves to its name.
async function currentBranch () {
  try {
    return (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

async function isDetached () {
  return (await currentBranch()) === null
}

async function currentHead () {
  try {
    return (await git(['rev-parse', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

// Dirty entries of the worktree, optionally scoped to specific files.
async function dirtyStatus (files) {
  const args = ['status', '--porcelain']
  if (Array.isArray(files) && files.length) args.push('--', ...files)
  const out = await git(args)
  return out.split('\n').filter(Boolean).map(l => ({
    status: l.slice(0, 2).trim(),
    file: l.slice(3).trim()
  }))
}

// ── Failure classification ───────────────────────────────────────────────────
function classifyReason (msg) {
  const m = String(msg || '').toLowerCase()
  if (/no remote|origin missing|origin ausente|does not appear to be a git repository|no tracking information|no upstream/.test(m)) return 'no-remote'
  if (/timeout|timed out/.test(m)) return 'timeout'
  if (/authentication|could not read username|could not read password|permission denied|publickey|access denied|terminal prompts disabled|http basic|401|403/.test(m)) return 'auth'
  if (/non-fast-forward|fetch first|\[rejected\]|updates were rejected|not possible to fast-forward|cannot fast-forward|divergent|diverged|conflict|needs merge|could not apply|unmerged|rebase/.test(m)) return 'diverged'
  return 'other'
}

const FIXES = {
  'no-remote': 'configure a remote/upstream: git remote add origin <url> (or git push -u origin <branch>)',
  auth: 'configure a credential helper or SSH key (e.g. git config credential.helper store, or switch origin to an SSH URL)',
  diverged: 'run Sync to integrate remote changes (pull --rebase) and push again',
  timeout: 'check your network connection to the remote and retry',
  other: 'check the detail message and your git setup'
}

function fixFor (reason) {
  return FIXES[reason] || FIXES.other
}

// Push rejected because the remote is ahead — the only failure a pull can
// cure. Auth/network/no-remote must NOT match here.
function isNonFastForward (msg) {
  const m = String(msg || '').toLowerCase()
  return /non-fast-forward|fetch first|\[rejected\]|updates were rejected|tip of your current branch is behind|cannot lock ref|failed to push some refs/.test(m)
}

// ── Push / Pull ──────────────────────────────────────────────────────────────
// pushNow: plain `git push`. NEVER throws — { ok } or { ok:false, reason, error }.
async function pushNow () {
  try {
    const remotes = (await git(['remote'])).split('\n').map(s => s.trim()).filter(Boolean)
    if (!remotes.length) return { ok: false, reason: 'no-remote', error: 'no remote configured (origin missing)' }
    await git(['push'])
    return { ok: true }
  } catch (err) {
    const detail = oneLine(err.message)
    return { ok: false, reason: classifyReason(detail), error: detail }
  }
}

// pullRebase: `git pull --rebase --autostash`. NEVER throws. GUARANTEE: the
// worktree is never left mid-rebase — on error a best-effort `rebase --abort`
// runs (swallowed when no rebase is in progress).
async function pullRebase () {
  try {
    const remotes = (await git(['remote'])).split('\n').map(s => s.trim()).filter(Boolean)
    if (!remotes.length) return { ok: false, reason: 'no-remote', detail: 'no remote configured (origin missing)' }
    const out = await git(['pull', '--rebase', '--autostash'])

    // `--autostash` can exit 0 even when the stash re-apply conflicts, leaving
    // conflict markers in the worktree. Detect unmerged entries and restore the
    // tree to the post-rebase HEAD; local changes stay safe in the stash.
    const unmerged = (await git(['ls-files', '-u'])).trim()
    if (unmerged) {
      await git(['reset', '--hard', 'HEAD'])
      return {
        ok: false,
        reason: 'diverged',
        detail: 'pull brought a conflict with uncommitted local changes; the worktree was restored — your local changes are kept in the stash (git stash list)'
      }
    }
    return { ok: true, message: oneLine(out) || 'pull done' }
  } catch (err) {
    try { await git(['rebase', '--abort']) } catch { /* no rebase in progress */ }
    const detail = oneLine(err.message)
    return { ok: false, reason: classifyReason(detail), detail }
  }
}

// pushSync: push that SELF-HEALS on non-fast-forward — integrates the remote
// (pull --rebase --autostash) and retries, up to MAX times. NEVER throws.
async function pushSync () {
  const MAX = 3
  for (let attempt = 0; attempt < MAX; attempt++) {
    const r = await pushNow()
    if (r.ok) return { ok: true }
    if (!isNonFastForward(r.error)) return r
    const pr = await pullRebase()
    if (!pr.ok) return { ok: false, reason: pr.reason, error: pr.detail }
  }
  return { ok: false, reason: 'diverged', error: 'push rejected repeatedly: the remote keeps changing — try syncing again' }
}

// ── Background push (coalesced) ──────────────────────────────────────────────
// One push in flight at a time; requests arriving meanwhile coalesce into a
// single re-run. Failure is stored as the accumulated warning.
let pushWarning = null
let pushInFlight = null
let pushQueued = false

function pushBackground () {
  if (pushInFlight) {
    pushQueued = true
    return
  }
  pushInFlight = pushNow()
    .then(r => {
      pushWarning = r.ok ? null : { reason: r.reason || 'other', detail: r.error, fix: fixFor(r.reason) }
    })
    .catch(() => { /* pushNow never throws */ })
    .finally(() => {
      pushInFlight = null
      if (pushQueued) {
        pushQueued = false
        pushBackground()
      }
    })
}

// ── Commit ───────────────────────────────────────────────────────────────────
// Commits ONE file on the CURRENT branch with the user's identity. Serialized
// on the same mutex as the hosted path (no two git writes race the index).
// `expectedBranch` re-checks the client's branch inside the critical section
// (409 on mismatch/detached — the client is looking at a stale branch).
function commitFile (file, content, message, expectedBranch) {
  return serialize(async () => {
    await ensureIdentity()
    const branch = await currentBranch()
    if (!branch) {
      const e = new Error('repository is in detached HEAD — checkout a branch to edit')
      e.status = 409
      throw e
    }
    if (expectedBranch !== undefined && expectedBranch !== branch) {
      const e = new Error(`branch mismatch: repository is on "${branch}", client is editing "${expectedBranch}" — reload`)
      e.status = 409
      e.currentBranch = branch
      throw e
    }
    // External uncommitted edits on this file get folded into the commit — the
    // client read them from the worktree, but surface it so nothing is silent.
    const wasDirty = (await dirtyStatus([file])).length > 0
    fs.writeFileSync(path.join(cfg.repoDir(), file), content)
    await git(['add', '--', file])
    const status = await git(['status', '--porcelain', '--', file])
    if (status.trim()) {
      await git(['commit', '-m', message, '--', file])
      pushBackground()
    }
    let warning = pushWarning ? { ...pushWarning } : null
    if (wasDirty && !warning) {
      warning = { reason: 'dirty-worktree', detail: `${file} had uncommitted changes in the worktree — they were included in this commit` }
    }
    return { commit: await currentHead(), branch, warning }
  })
}

// ── Sync (explicit, the toolbar button) ──────────────────────────────────────
// pull --rebase --autostash (guarded) then push with non-FF self-heal.
function sync () {
  return serialize(async () => {
    const pr = await pullRebase()
    if (!pr.ok) return { ok: false, step: 'pull', reason: pr.reason, detail: pr.detail, fix: fixFor(pr.reason) }
    const ps = await pushSync()
    if (!ps.ok) return { ok: false, step: 'push', reason: ps.reason || 'other', detail: ps.error, fix: fixFor(ps.reason) }
    pushWarning = null
    return { ok: true, message: pr.message }
  })
}

// ── Sync state (toolbar badge) ───────────────────────────────────────────────
// ahead/behind vs upstream via rev-list --count. NEVER throws.
async function syncState () {
  const branch = await currentBranch()
  let ahead = 0
  let behind = 0
  let hasUpstream = false
  let upstream = null
  try {
    upstream = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim() || null
    hasUpstream = !!upstream
    if (upstream) {
      ahead = parseInt((await git(['rev-list', '--count', '@{u}..HEAD'])).trim(), 10) || 0
      behind = parseInt((await git(['rev-list', '--count', 'HEAD..@{u}'])).trim(), 10) || 0
    }
  } catch {
    hasUpstream = false
  }
  // dirty: uncommitted external changes on the tracked files (worktree banner)
  let dirty = []
  try { dirty = await dirtyStatus([cfg.dbmlFile, cfg.positionsFile]) } catch { /* never throws */ }
  return { branch, detached: branch === null, ahead, behind, hasUpstream, upstream, pushWarning, dirty }
}

// Repo switch (PUT /api/repo): drop state tied to the previous repo.
function onRepoSwitch () {
  pushWarning = null
  pushQueued = false
}

module.exports = {
  oneLine,
  getIdentity,
  ensureIdentity,
  currentBranch,
  isDetached,
  currentHead,
  dirtyStatus,
  classifyReason,
  fixFor,
  pushNow,
  pullRebase,
  pushSync,
  commitFile,
  sync,
  syncState,
  onRepoSwitch
}
