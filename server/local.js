'use strict'

// Local mode operates directly on the user's clone — their identity,
// credentials and checked-out branch. Commit is awaited (fast, local); push
// runs in background, coalesced and best-effort — a push failure never breaks
// the local write, it accumulates as a warning surfaced on the next response.

const fs = require('fs')
const path = require('path')
const cfg = require('./config')
const { git, serialize, sanitize } = require('./git')

function oneLine (s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
}

// null per missing field — NEVER a hardcoded fallback (attribution must be real).
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
    const e = new Error('identidade git não configurada — rode: git config --global user.name "Seu Nome" && git config --global user.email "voce@exemplo.com"')
    e.status = 422
    throw e
  }
  return id
}

// null when HEAD is detached. symbolic-ref (not rev-parse) so an unborn branch
// in a fresh repo still resolves to its name.
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

async function dirtyStatus (files) {
  const args = ['status', '--porcelain']
  if (Array.isArray(files) && files.length) args.push('--', ...files)
  const out = await git(args)
  return out.split('\n').filter(Boolean).map(l => ({
    status: l.slice(0, 2).trim(),
    file: l.slice(3).trim()
  }))
}

function classifyReason (msg) {
  const m = String(msg || '').toLowerCase()
  if (/no remote|origin missing|origin ausente|does not appear to be a git repository|no tracking information|no upstream/.test(m)) return 'no-remote'
  if (/timeout|timed out/.test(m)) return 'timeout'
  if (/authentication|could not read username|could not read password|permission denied|publickey|access denied|terminal prompts disabled|http basic|401|403/.test(m)) return 'auth'
  if (/non-fast-forward|fetch first|\[rejected\]|updates were rejected|not possible to fast-forward|cannot fast-forward|divergent|diverged|conflict|needs merge|could not apply|unmerged|rebase/.test(m)) return 'diverged'
  return 'other'
}

const FIXES = {
  'no-remote': 'configure um remoto/upstream: git remote add origin <url> (ou git push -u origin <branch>)',
  auth: 'configure um credential helper ou chave SSH (ex.: git config credential.helper store, ou troque o origin pra URL SSH)',
  diverged: 'use Sincronizar para integrar as mudanças remotas (pull --rebase) e enviar de novo',
  timeout: 'verifique sua conexão de rede com o remoto e tente de novo',
  other: 'verifique a mensagem de detalhe e a sua configuração do git'
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

// NEVER throws — { ok } or { ok:false, reason, error }.
async function pushNow () {
  try {
    const remotes = (await git(['remote'])).split('\n').map(s => s.trim()).filter(Boolean)
    if (!remotes.length) return { ok: false, reason: 'no-remote', error: 'nenhum remoto configurado (origin ausente)' }
    await git(['push'])
    return { ok: true }
  } catch (err) {
    const detail = oneLine(err.message)
    return { ok: false, reason: classifyReason(detail), error: detail }
  }
}

// NEVER throws. GUARANTEE: the worktree is never left mid-rebase — on error a
// best-effort `rebase --abort` runs (swallowed when no rebase is in progress).
async function pullRebase () {
  try {
    const remotes = (await git(['remote'])).split('\n').map(s => s.trim()).filter(Boolean)
    if (!remotes.length) return { ok: false, reason: 'no-remote', detail: 'nenhum remoto configurado (origin ausente)' }
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
        detail: 'o pull trouxe conflito com mudanças locais não commitadas; o worktree foi restaurado — suas mudanças locais estão guardadas no stash (git stash list)'
      }
    }
    return { ok: true, message: oneLine(out) || 'pull concluído' }
  } catch (err) {
    try { await git(['rebase', '--abort']) } catch { /* no rebase in progress */ }
    const detail = oneLine(err.message)
    return { ok: false, reason: classifyReason(detail), detail }
  }
}

// Estratégia "safe": só integra quando dá fast-forward — divergência nunca
// toca os arquivos do usuário, volta como 'diverged' pro app decidir.
// Mesma guarda de autostash do pullRebase. NEVER throws.
async function pullFF () {
  try {
    const remotes = (await git(['remote'])).split('\n').map(s => s.trim()).filter(Boolean)
    if (!remotes.length) return { ok: false, reason: 'no-remote', detail: 'nenhum remoto configurado (origin ausente)' }
    const out = await git(['pull', '--ff-only', '--autostash'])
    const unmerged = (await git(['ls-files', '-u'])).trim()
    if (unmerged) {
      await git(['reset', '--hard', 'HEAD'])
      return {
        ok: false,
        reason: 'diverged',
        detail: 'o pull trouxe conflito com mudanças locais não commitadas; o worktree foi restaurado — suas mudanças locais estão guardadas no stash (git stash list)'
      }
    }
    return { ok: true, message: oneLine(out) || 'pull concluído' }
  } catch (err) {
    const detail = oneLine(err.message)
    return { ok: false, reason: classifyReason(detail), detail }
  }
}

// Push that SELF-HEALS on non-fast-forward — integrates the remote
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
  return { ok: false, reason: 'diverged', error: 'push rejeitado repetidamente: o remoto não para de mudar — tente sincronizar de novo' }
}

// One push in flight at a time; requests arriving meanwhile coalesce into a
// single re-run. Failure is stored as the accumulated warning.
// pushEpoch: um push em background que termina DEPOIS de um sync bem-sucedido
// (ou troca de repo) não pode regravar um warning obsoleto — só grava se a
// época em que ele nasceu ainda for a atual.
let pushWarning = null
let pushInFlight = null
let pushQueued = false
let pushEpoch = 0

function pushBackground () {
  if (pushInFlight) {
    pushQueued = true
    return
  }
  const epoch = pushEpoch
  pushInFlight = pushNow()
    .then(r => {
      if (epoch !== pushEpoch) return
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

// Commits ONE file on the CURRENT branch with the user's identity. Serialized
// on the same mutex as the hosted path (no two git writes race the index).
// `expectedBranch` re-checks the client's branch inside the critical section
// (409 on mismatch/detached — the client is looking at a stale branch).
function commitFile (file, content, message, expectedBranch) {
  return serialize(async () => {
    await ensureIdentity()
    const branch = await currentBranch()
    if (!branch) {
      const e = new Error('repositório em detached HEAD — faça checkout de uma branch para editar')
      e.status = 409
      throw e
    }
    if (expectedBranch !== undefined && expectedBranch !== branch) {
      const e = new Error(`branch divergente: o repositório está em "${branch}", o app está editando "${expectedBranch}" — recarregue`)
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
      warning = { reason: 'dirty-worktree', detail: `${file} tinha mudanças não commitadas no worktree — elas foram incluídas neste commit` }
    }
    return { commit: await currentHead(), branch, warning }
  })
}

// strategy: 'rebase' (padrão — remoto vence, rebase por cima) | 'safe' (só
// fast-forward; divergência volta como falha 'diverged' sem tocar em nada).
function sync (strategy) {
  return serialize(async () => {
    const pr = strategy === 'safe' ? await pullFF() : await pullRebase()
    if (!pr.ok) return { ok: false, step: 'pull', reason: pr.reason, detail: pr.detail, fix: fixFor(pr.reason) }
    const ps = strategy === 'safe' ? await pushNow() : await pushSync()
    if (!ps.ok) {
      if (strategy === 'safe' && isNonFastForward(ps.error)) {
        return { ok: false, step: 'push', reason: 'diverged', detail: ps.error, fix: fixFor('diverged') }
      }
      return { ok: false, step: 'push', reason: ps.reason || 'other', detail: ps.error, fix: fixFor(ps.reason) }
    }
    pushWarning = null
    pushEpoch++
    return { ok: true, message: pr.message }
  })
}

// Painel "Saúde do git" das Configurações (padrão do Basalt): identidade,
// remoto, upstream, divergência, push pendente e worktree — cada um com ok/detalhe.
async function gitHealth () {
  const id = await getIdentity()
  let remote = null
  try { remote = (await git(['config', '--get', 'remote.origin.url'])).trim() || null } catch { remote = null }
  const s = await syncState()
  const checks = [
    {
      id: 'identity',
      ok: !!(id.name && id.email),
      label: 'Identidade git configurada',
      detail: id.name && id.email ? `${id.name} <${id.email}>` : 'git config user.name / user.email ausentes — edição bloqueada'
    },
    {
      id: 'branch',
      ok: !s.detached,
      label: 'Branch ativa',
      detail: s.branch || 'detached HEAD — faça checkout de uma branch'
    },
    {
      id: 'remote',
      ok: !!remote,
      label: 'Remoto configurado',
      detail: remote ? sanitize(remote) : 'nenhum origin — commits ficam só locais'
    },
    {
      id: 'upstream',
      ok: s.hasUpstream,
      label: 'Upstream da branch',
      detail: s.hasUpstream ? s.upstream : 'sem upstream — git push -u origin <branch>'
    },
    {
      id: 'diverged',
      ok: !s.behind,
      label: 'Em dia com o remoto',
      detail: s.hasUpstream ? `${s.ahead} à frente · ${s.behind} atrás` : '—'
    },
    {
      id: 'push',
      ok: !s.pushWarning,
      label: 'Push',
      detail: s.pushWarning ? `${s.pushWarning.reason}: ${s.pushWarning.detail || ''}` : 'sem pendências'
    },
    {
      id: 'dirty',
      ok: !(Array.isArray(s.dirty) && s.dirty.length),
      label: 'Worktree dos arquivos rastreados',
      detail: Array.isArray(s.dirty) && s.dirty.length ? s.dirty.map(d => d.file || d).join(', ') : 'limpo'
    }
  ]
  return {
    ok: checks.every(c => c.ok),
    branch: s.branch,
    identity: id.name && id.email ? id : null,
    remoteUrl: remote ? sanitize(remote) : null,
    syncState: s,
    checks
  }
}

// NEVER throws.
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
  let dirty = []
  try { dirty = await dirtyStatus([cfg.dbmlFile, cfg.positionsFile]) } catch { /* never throws */ }
  return { branch, detached: branch === null, ahead, behind, hasUpstream, upstream, pushWarning, dirty }
}

function onRepoSwitch () {
  pushWarning = null
  pushQueued = false
  pushEpoch++
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
  pullFF,
  pushSync,
  commitFile,
  sync,
  syncState,
  gitHealth,
  onRepoSwitch
}
