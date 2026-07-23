// normalizeHistory/relativeTime have no DOM dependency so the smoke script can
// exercise them in plain node.

import * as api from './api.js'

const PAGE = 30

// Every commit is guaranteed the fields the list renders, whatever the server sent.
export function normalizeHistory (payload) {
  const raw = payload && Array.isArray(payload.commits) ? payload.commits : []
  const commits = raw
    .filter(c => c && typeof c.hash === 'string' && c.hash)
    .map(c => ({
      hash: c.hash,
      shortHash: typeof c.shortHash === 'string' && c.shortHash ? c.shortHash : c.hash.slice(0, 7),
      date: typeof c.date === 'string' ? c.date : '',
      authorName: typeof c.authorName === 'string' ? c.authorName : '',
      authorEmail: typeof c.authorEmail === 'string' ? c.authorEmail : '',
      message: typeof c.message === 'string' ? c.message : '',
      files: Array.isArray(c.files) ? c.files.filter(f => typeof f === 'string') : []
    }))
  return { commits, hasMore: !!(payload && payload.hasMore) }
}

export function relativeTime (iso, now = Date.now()) {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return String(iso || '')
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'agora mesmo'
  const m = Math.round(s / 60)
  if (m < 60) return `há ${m}min`
  const h = Math.round(m / 60)
  if (h < 24) return `há ${h}h`
  const d = Math.round(h / 24)
  if (d < 30) return `há ${d}d`
  const mo = Math.round(d / 30)
  if (mo < 12) return `há ${mo} ${mo === 1 ? 'mês' : 'meses'}`
  const y = Math.round(mo / 12)
  return `há ${y} ano${y === 1 ? '' : 's'}`
}

export function absoluteTime (iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso || '')
  return d.toLocaleString('pt-BR')
}

export const firstLine = msg => (msg || '').split('\n')[0] || '(sem mensagem)'

const $ = id => document.getElementById(id)

const state = {
  commits: [],
  skip: 0,
  hasMore: false,
  loading: false,
  loaded: false,
  activeHash: null,
  diffShownFor: null,
  allFiles: false // false = só commits do schema; true = todos os arquivos do repo
}

let hooks = { onOpenCommit: () => {}, onExit: () => {}, fail: () => {} }

export function initHistory (h) {
  hooks = { ...hooks, ...h }
  $('histMore').addEventListener('click', () => loadPage().catch(hooks.fail))
  $('histDetailClose').addEventListener('click', () => hooks.onExit())
  $('histDiffToggle').addEventListener('click', () => toggleTextDiff().catch(hooks.fail))
}

export async function ensureLoaded () {
  if (state.loaded || state.loading) return
  await reload()
}

// snapshot pros consumidores externos (sidebar do modo histórico)
export function getCommits () { return state.commits.slice() }
export function getActiveHash () { return state.activeHash }
export function hasMore () { return state.hasMore }
export async function loadMore () {
  if (!state.hasMore || state.loading) return
  await loadPage()
}
let changeCb = null
export function onListChanged (cb) { changeCb = cb }
function emitChanged () { if (changeCb) changeCb() }

export function isAllFiles () { return state.allFiles }
export async function setAllFiles (v) {
  if (state.allFiles === !!v) return
  state.allFiles = !!v
  await reload()
}

export function invalidate () {
  state.loaded = false
  state.commits = []
  state.skip = 0
  state.hasMore = false
  const list = typeof document !== 'undefined' && document.getElementById('histList')
  if (list) list.innerHTML = ''
}

export async function reload () {
  state.commits = []
  state.skip = 0
  state.hasMore = false
  state.loaded = false
  $('histList').innerHTML = ''
  await loadPage()
  state.loaded = true
}

async function loadPage () {
  if (state.loading) return
  state.loading = true
  const btn = $('histMore')
  btn.disabled = true
  btn.textContent = 'Carregando…'
  try {
    const page = normalizeHistory(await (state.allFiles ? api.getHistoryAll : api.getHistory)(state.skip, PAGE))
    const startIndex = state.commits.length
    state.commits = state.commits.concat(page.commits)
    state.skip += page.commits.length
    state.hasMore = page.hasMore
    renderRows(page.commits, startIndex)
    $('histEmpty').classList.toggle('hidden', state.commits.length > 0)
    emitChanged()
  } finally {
    state.loading = false
    btn.disabled = false
    btn.textContent = 'Carregar mais'
    btn.classList.toggle('hidden', !state.hasMore)
  }
}

function renderRows (commits, startIndex) {
  const list = $('histList')
  commits.forEach((c, i) => {
    const idx = startIndex + i
    const li = document.createElement('li')
    li.className = 'hist-row'
    li.dataset.hash = c.hash

    const top = document.createElement('div')
    top.className = 'hist-top'
    const pill = document.createElement('span')
    pill.className = 'hist-pill mono'
    pill.textContent = c.shortHash
    top.appendChild(pill)
    const msg = document.createElement('span')
    msg.className = 'hist-msg'
    msg.textContent = firstLine(c.message)
    msg.title = c.message
    top.appendChild(msg)
    if (idx === 0) {
      const cur = document.createElement('span')
      cur.className = 'hist-pill current'
      cur.textContent = 'atual'
      top.appendChild(cur)
    }
    li.appendChild(top)

    const sub = document.createElement('div')
    sub.className = 'hist-sub'
    const when = document.createElement('span')
    when.textContent = relativeTime(c.date)
    when.title = absoluteTime(c.date)
    const files = document.createElement('span')
    files.className = 'hist-files mono'
    files.textContent = c.files.join(' · ')
    sub.append(author(c), sep(), when, sep(), files)
    li.appendChild(sub)

    li.addEventListener('click', () => hooks.onOpenCommit(c))
    list.appendChild(li)
  })
  markActive()
}

const sep = () => Object.assign(document.createElement('span'), { className: 'hist-sep', textContent: '·' })
function author (c) {
  const el = document.createElement('span')
  el.className = 'hist-author'
  el.textContent = c.authorName || c.authorEmail || 'desconhecido'
  el.title = c.authorEmail
  return el
}

export function setActive (commit) {
  state.activeHash = commit ? commit.hash : null
  markActive()
  const panel = $('histDetail')
  if (!commit) {
    panel.classList.add('hidden')
    hideTextDiff()
    return
  }
  $('histDetailHash').textContent = commit.shortHash || commit.hash.slice(0, 7)
  $('histDetailMsg').textContent = firstLine(commit.message)
  $('histDetailMeta').textContent =
    `${commit.authorName || commit.authorEmail || 'desconhecido'} · ${absoluteTime(commit.date)}`
  if (state.diffShownFor !== commit.hash) hideTextDiff()
  panel.classList.remove('hidden')
}

function markActive () {
  document.querySelectorAll('#histList .hist-row').forEach(el => {
    el.classList.toggle('on', !!state.activeHash && el.dataset.hash === state.activeHash)
  })
  emitChanged()
}

function hideTextDiff () {
  $('histDiffPre').classList.add('hidden')
  $('histDiffToggle').textContent = 'Mostrar diff textual'
  state.diffShownFor = null
}

async function toggleTextDiff () {
  const pre = $('histDiffPre')
  if (!pre.classList.contains('hidden')) return hideTextDiff()
  if (!state.activeHash) return
  const btn = $('histDiffToggle')
  btn.disabled = true
  try {
    if (state.diffShownFor !== state.activeHash || !pre.textContent) {
      pre.textContent = 'Carregando…'
      pre.classList.remove('hidden')
      pre.textContent = (await api.getCommitDiff(state.activeHash)) || '(sem diff textual)'
      state.diffShownFor = state.activeHash
    } else {
      pre.classList.remove('hidden')
    }
    btn.textContent = 'Ocultar diff textual'
  } finally {
    btn.disabled = false
  }
}
