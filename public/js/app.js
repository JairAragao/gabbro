// App orchestration: global state, toolbar, tabs, branch switching, view/edit
// modes, diff mode, history mode, saves, local-mode chrome (sync, ahead/behind
// badge, identity banner, repo switcher), toasts.

import * as api from './api.js'
import { parseDBML } from './parser.js'
import { diffModels, diffSummaryLine, buildUnionModel } from './diff.js'
import * as diagram from './diagram.js'
import { initDocs, renderDocs, scrollToTable } from './docs.js'
import * as hist from './history.js'

const $ = id => document.getElementById(id)

const state = {
  config: null,
  branches: [],
  branch: null,
  tab: 'diagram',
  mode: 'view',
  diffOn: false,
  // history mode: viewing one commit — Diagram/Docs render commit vs parent
  hist: null, // { hash, meta, model, parentModel, diff }
  models: new Map(), // branch -> { text, model } (may hold unsaved edits)
  baselines: new Map(), // branch -> { text, model } as last fetched/saved (commit-msg prefill)
  positions: { version: 1, tables: {} },
  posDirty: false,
  dbmlDirty: false,
  currentBranch: null, // local mode: the repo's checked-out branch (kept fresh via sync-state)
  syncState: null
}

/* ---------- toast ---------- */
let toastTimer = null
function toast (msg, type) {
  const el = $('toast')
  el.textContent = msg
  el.className = 'show' + (type === 'error' ? ' error' : type === 'warn' ? ' warn' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = '' }, type ? 6000 : 3500)
}
const fail = e => toast(e && e.message ? e.message : 'unexpected error', 'error')
// Accumulated push warning from the server ({reason, detail, fix}) — yellow,
// non-blocking: the commit itself succeeded.
function warnToast (w) {
  if (!w) return
  toast(`push pending (${w.reason}): ${w.detail || ''}${w.fix ? ' — ' + w.fix : ''}`, 'warn')
}

/* ---------- data ---------- */
const draftKey = b => 'gabbro:' + b

async function ensureModel (b, force) {
  if (!force && state.models.has(b)) return state.models.get(b)
  const text = await api.getDbml(b)
  const entry = { text, model: parseDBML(text) }
  state.models.set(b, entry)
  state.baselines.set(b, entry)
  return entry
}

function applyDraft (b) {
  try {
    const raw = localStorage.getItem(draftKey(b))
    if (!raw) return
    const draft = JSON.parse(raw)
    if (draft && draft.tables) {
      Object.assign(state.positions.tables, draft.tables)
      state.posDirty = true
    }
  } catch (e) { /* corrupt draft — ignore */ }
}
function clearDrafts () {
  const gone = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && k.startsWith('gabbro:')) gone.push(k)
  }
  gone.forEach(k => localStorage.removeItem(k))
}

/* ---------- render ---------- */
const isLocal = () => state.config && state.config.mode === 'local'
// The only branch that accepts writes: local → the checked-out branch,
// hosted → EDIT_BRANCH (v1 behavior untouched).
function editableBranch () {
  return isLocal() ? state.currentBranch : state.config.editBranch
}
function canEdit () {
  return state.mode === 'edit' && !state.diffOn && !state.hist &&
    !state.config.readOnly && state.branch === editableBranch()
}
function updateChrome () {
  const editing = state.mode === 'edit' && !state.diffOn && !state.hist
  document.body.classList.toggle('mode-view', !editing)
  document.body.classList.toggle('mode-edit', editing)
  $('modeView').classList.toggle('on', state.mode === 'view')
  $('modeEdit').classList.toggle('on', state.mode === 'edit')
  $('modeEdit').disabled = state.diffOn || !!state.hist
  // readOnly (local without identity): no edit chrome at all — pure reader
  $('modeToggle').classList.toggle('hidden', !!state.config.readOnly)
  diagram.setEditorVisible(editing && state.tab === 'diagram')
  // dragging only when the layout can actually be saved
  diagram.setDraggable(canEdit())

  const ok = canEdit()
  $('btnSaveDbml').hidden = !editing || state.config.readOnly
  $('btnSavePos').hidden = !editing || state.config.readOnly
  $('btnSaveDbml').disabled = !ok || !state.dbmlDirty
  $('btnSavePos').disabled = !ok || !state.posDirty

  const banner = $('banner')
  if (editing && state.branch !== editableBranch()) {
    banner.textContent = editableBranch()
      ? `read-only branch — switch to ${editableBranch()} to edit`
      : 'repository is in detached HEAD — checkout a branch to edit'
    banner.classList.remove('hidden')
  } else banner.classList.add('hidden')

  $('identityBanner').classList.toggle('hidden', !(isLocal() && !state.config.identity))

  const hb = $('histBanner')
  if (state.hist) {
    const m = state.hist.meta
    $('histBannerText').textContent =
      `Viewing commit ${m.shortHash || state.hist.hash.slice(0, 7)} — ${hist.firstLine(m.message)}`
    hb.classList.remove('hidden')
  } else hb.classList.add('hidden')

  if (isLocal()) $('branchSel').classList.toggle('current', state.branch === state.currentBranch)
}
function updateMeta () {
  const s = diagram.getStats()
  $('meta').textContent = s ? `${s.tables} tables · ${s.groups} groups · ${s.refs} refs` : ''
}

async function renderAll (opts) {
  opts = opts || {}
  if (state.hist) {
    // history mode: commit rendered against its parent with the same diff
    // decoration as branch diff; current positions drive the layout
    const h = state.hist
    const union = buildUnionModel(h.parentModel, h.model, h.diff)
    diagram.loadModel(union, state.positions, h.diff, { fitView: opts.fitView !== false, dirty: false })
    renderDocs(union, h.diff)
  } else if (state.diffOn) {
    const base = $('diffBase').value, target = $('diffTarget').value
    const [b, t] = await Promise.all([ensureModel(base), ensureModel(target)])
    const d = diffModels(b.model, t.model)
    const union = buildUnionModel(b.model, t.model, d)
    diagram.loadModel(union, state.positions, d, { fitView: opts.fitView !== false, dirty: state.posDirty })
    renderDocs(union, d)
  } else {
    const entry = await ensureModel(state.branch)
    diagram.loadModel(entry.model, state.positions, null, { fitView: opts.fitView !== false, dirty: state.posDirty })
    renderDocs(entry.model, null)
    if (opts.syncEditor !== false) diagram.setEditorText(entry.text)
  }
  updateMeta()
  updateChrome()
}

async function switchBranch (b) {
  if (state.hist) { state.hist = null; hist.setActive(null) } // picking a branch leaves history mode
  state.branch = b
  $('branchSel').value = b
  state.dbmlDirty = false
  applyDraft(b)
  await renderAll({ fitView: true })
}

/* ---------- history mode ---------- */
async function openHistoryCommit (c) {
  try {
    if (state.diffOn) setDiffUi(false) // diff mode and history mode are mutually exclusive
    const r = await api.getCommit(c.hash)
    const model = parseDBML(r.content || '')
    const parentModel = parseDBML(r.parentContent || '')
    state.hist = {
      hash: c.hash,
      meta: r.meta || c,
      model,
      parentModel,
      diff: diffModels(parentModel, model)
    }
    state.mode = 'view'
    hist.setActive({ ...c, ...(r.meta || {}) })
    setTab('diagram') // show the structural diff right away; History tab keeps the detail panel
    await renderAll({ fitView: false })
  } catch (e) { fail(e) }
}

function exitHistory () {
  if (!state.hist) return
  state.hist = null
  hist.setActive(null)
  renderAll({ fitView: false }).catch(fail)
}

/* ---------- toolbar wiring ---------- */
function setTab (tab) {
  state.tab = tab
  localStorage.setItem('gabbro:tab', tab)
  document.querySelectorAll('#tabs .tab').forEach(el => el.classList.toggle('on', el.dataset.tab === tab))
  $('diagramSection').classList.toggle('hidden', tab !== 'diagram')
  $('docsSection').classList.toggle('hidden', tab !== 'docs')
  $('historySection').classList.toggle('hidden', tab !== 'history')
  $('searchWrap').classList.toggle('hidden', tab !== 'diagram')
  if (tab === 'history') hist.ensureLoaded().catch(fail)
  updateChrome()
}

function fillSelect (sel, branches, value, currentB) {
  sel.innerHTML = ''
  for (const b of branches) {
    const o = document.createElement('option')
    o.value = b
    o.textContent = currentB && b === currentB ? `${b} (current)` : b
    sel.appendChild(o)
  }
  if (value && branches.includes(value)) sel.value = value
}
function fillBranchSelects () {
  const cur = isLocal() ? state.currentBranch : null
  fillSelect($('branchSel'), state.branches, state.branch, cur)
  fillSelect($('diffBase'), state.branches, $('diffBase').value)
  fillSelect($('diffTarget'), state.branches, $('diffTarget').value)
}

function setDiffUi (on) {
  state.diffOn = on
  $('btnDiff').classList.toggle('on', on)
  $('diffCtrls').classList.toggle('hidden', !on)
}
async function toggleDiff (on) {
  if (on && state.hist) { state.hist = null; hist.setActive(null) } // mutually exclusive
  setDiffUi(on)
  try {
    await renderAll({ fitView: true })
  } catch (e) { fail(e) }
}

async function doRefresh () {
  const btn = $('btnRefresh')
  btn.disabled = true
  try {
    await api.refresh()
    state.models.clear()
    state.branches = await api.getBranches()
    fillBranchSelects()
    if (!state.posDirty) {
      const p = await api.getPositions()
      if (p && p.tables) state.positions = { version: p.version || 1, tables: p.tables }
    }
    await renderAll({ fitView: false })
    if (state.tab === 'history') hist.reload().catch(() => { /* best-effort */ })
    else hist.invalidate()
    refreshSyncBadge()
    toast('refreshed from remote')
  } catch (e) { fail(e) } finally { btn.disabled = false }
}

/* ---------- saves ---------- */
function saveFail (e) {
  if (e && e.status === 409) toast('branch changed underneath — reload the page', 'error')
  else fail(e)
  updateChrome()
}

async function saveDbml () {
  if (!canEdit()) return
  const text = diagram.getEditorText()
  // prefill: structural summary of what changed vs the last fetched/saved state
  let prefill = ''
  const base = state.baselines.get(state.branch)
  if (base) {
    try { prefill = diffSummaryLine(diffModels(base.model, parseDBML(text))) } catch (e) { /* parse error — no prefill */ }
  }
  const message = window.prompt('Commit message (optional):', prefill)
  if (message === null) return
  const btn = $('btnSaveDbml')
  btn.disabled = true
  try {
    const res = await api.putDbml(text, message, isLocal() ? state.branch : undefined)
    const entry = { text, model: parseDBML(text) }
    state.models.set(state.branch, entry)
    state.baselines.set(state.branch, entry)
    state.dbmlDirty = false
    updateChrome()
    toast(`DBML committed to ${res.branch} (${String(res.commit).slice(0, 7)})`)
    warnToast(res.warning)
    refreshSyncBadge()
  } catch (e) { saveFail(e) }
}

async function savePositions () {
  if (!canEdit()) return
  const btn = $('btnSavePos')
  btn.disabled = true
  try {
    Object.assign(state.positions.tables, diagram.getDirtyPositions().tables)
    const res = await api.putPositions(state.positions, isLocal() ? state.branch : undefined)
    clearDrafts()
    state.posDirty = false
    diagram.clearDirty()
    updateChrome()
    toast(`positions committed to ${res.branch} (${String(res.commit).slice(0, 7)})`)
    warnToast(res.warning)
    refreshSyncBadge()
  } catch (e) { saveFail(e) }
}

/* ---------- local mode: sync + badge + repo switcher ---------- */
function applySyncState (s) {
  if (!s) return
  state.syncState = s
  // the user may have switched branches in the terminal — follow it
  if (s.branch !== undefined && s.branch !== state.currentBranch) {
    state.currentBranch = s.branch
    state.config.currentBranch = s.branch
    fillBranchSelects()
    updateChrome()
  }
  const el = $('syncBadge')
  const parts = []
  if (s.ahead) parts.push(`↑${s.ahead}`)
  if (s.behind) parts.push(`↓${s.behind}`)
  el.textContent = parts.length ? parts.join(' ') : (s.pushWarning ? '!' : '')
  el.classList.toggle('hidden', !parts.length && !s.pushWarning)
  el.classList.toggle('warn', !!s.pushWarning)
  el.title = s.pushWarning
    ? `push pending (${s.pushWarning.reason}): ${s.pushWarning.detail || ''} — ${s.pushWarning.fix || ''}`
    : (s.hasUpstream ? `ahead ${s.ahead} · behind ${s.behind} vs ${s.upstream}` : 'no upstream configured')
  // uncommitted external changes on the tracked files (edited outside gabbro)
  const dirty = Array.isArray(s.dirty) && s.dirty.length
  const db = $('dirtyBanner')
  if (db) {
    db.classList.toggle('hidden', !dirty)
    if (dirty) db.textContent = `uncommitted changes in the worktree: ${s.dirty.join(', ')} — saving from Gabbro will include them in the commit`
  }
}

async function refreshSyncBadge () {
  if (!isLocal()) return
  try {
    applySyncState(await api.getSyncState())
  } catch (e) { /* badge is best-effort */ }
}

async function doSync () {
  const btn = $('btnSync')
  btn.disabled = true
  btn.classList.add('busy')
  try {
    const r = await api.sync()
    applySyncState(r.syncState)
    if (!r.ok) {
      toast(`sync failed at ${r.step} (${r.reason}): ${r.fix || r.detail || ''}`, 'error')
      return
    }
    // pull may have rewritten the tracked files — reload everything visible
    state.models.clear()
    state.baselines.clear()
    state.branches = await api.getBranches()
    fillBranchSelects()
    if (!state.posDirty) {
      const p = await api.getPositions()
      if (p && p.tables) state.positions = { version: p.version || 1, tables: p.tables }
    }
    if (!state.hist) await renderAll({ fitView: false })
    if (state.tab === 'history') hist.reload().catch(() => {})
    else hist.invalidate()
    toast('synced with remote')
  } catch (e) { fail(e) } finally {
    btn.disabled = false
    btn.classList.remove('busy')
  }
}

async function switchRepo (p) {
  try {
    await api.putRepo(p)
    location.reload() // full reboot: new repo, new branches, new everything
  } catch (e) { fail(e) }
}

function initRepoSwitcher () {
  const btn = $('repoBtn'), menu = $('repoMenu')
  btn.classList.add('clickable')
  $('repoCaret').classList.remove('hidden')
  btn.addEventListener('click', async () => {
    if (!menu.classList.contains('hidden')) { menu.classList.add('hidden'); return }
    try {
      const r = await api.getRepo()
      const list = $('repoRecents')
      list.innerHTML = ''
      const recents = (r.recents || []).filter(x => x !== r.path)
      for (const rp of recents) {
        const it = document.createElement('button')
        it.className = 'rm-item'
        it.textContent = rp
        it.title = rp
        it.addEventListener('click', () => switchRepo(rp))
        list.appendChild(it)
      }
      $('repoNoRecents').classList.toggle('hidden', recents.length > 0)
      $('repoPath').value = ''
      menu.classList.remove('hidden')
      $('repoPath').focus()
    } catch (e) { fail(e) }
  })
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#repoMenu') && !e.target.closest('#repoBtn')) menu.classList.add('hidden')
  })
  $('repoOpen').addEventListener('click', () => {
    const p = $('repoPath').value.trim()
    if (p) switchRepo(p)
  })
  $('repoPath').addEventListener('keydown', e => { if (e.key === 'Enter') $('repoOpen').click() })
}

function setupLocalChrome () {
  $('btnSync').classList.remove('hidden')
  $('btnSync').addEventListener('click', doSync)
  $('btnRefresh').title = 'Fetch latest from remote (read-only) — use Sync to integrate'
  initRepoSwitcher()
  refreshSyncBadge()
  setInterval(refreshSyncBadge, 60000)
}

function handleHash () {
  if (location.hash.startsWith('#tbl-')) {
    const name = decodeURIComponent(location.hash.slice(5))
    if (state.tab !== 'docs') setTab('docs')
    scrollToTable(name)
  }
}

/* ---------- boot ---------- */
async function boot () {
  diagram.initDiagram({ parse: parseDBML })
  initDocs()
  hist.initHistory({ onOpenCommit: openHistoryCommit, onExit: exitHistory, fail })
  $('histExit').addEventListener('click', exitHistory)

  diagram.onPositionsChanged(pos => {
    Object.assign(state.positions.tables, pos.tables)
    state.posDirty = true
    try { localStorage.setItem(draftKey(state.branch), JSON.stringify(state.positions)) } catch (e) { /* storage full */ }
    updateChrome()
  })
  diagram.onDbmlEdited(async (model, text) => {
    const saved = state.models.get(state.branch)
    state.models.set(state.branch, { text, model })
    state.dbmlDirty = !saved || saved.text !== text || state.dbmlDirty
    diagram.loadModel(model, state.positions, null, { fitView: false, dirty: state.posDirty })
    renderDocs(model, null)
    updateMeta()
    updateChrome()
  })

  document.querySelectorAll('#tabs .tab').forEach(el => el.addEventListener('click', () => setTab(el.dataset.tab)))
  $('branchSel').addEventListener('change', e => switchBranch(e.target.value).catch(fail))
  $('btnRefresh').addEventListener('click', doRefresh)
  $('btnDiff').addEventListener('click', () => toggleDiff(!state.diffOn))
  $('diffBase').addEventListener('change', () => state.diffOn && renderAll({ fitView: true }).catch(fail))
  $('diffTarget').addEventListener('change', () => state.diffOn && renderAll({ fitView: true }).catch(fail))
  $('modeView').addEventListener('click', () => { state.mode = 'view'; updateChrome() })
  $('modeEdit').addEventListener('click', () => {
    if (state.diffOn || state.hist || state.config.readOnly) return
    state.mode = 'edit'
    const entry = state.models.get(state.branch)
    if (entry) diagram.setEditorText(entry.text)
    updateChrome()
  })
  $('btnSaveDbml').addEventListener('click', saveDbml)
  $('btnSavePos').addEventListener('click', savePositions)
  const searchUi = r => {
    const has = r && r.total > 0
    $('searchCount').textContent = has ? `${r.idx + 1}/${r.total}` : ($('search').value.trim() ? '0' : '')
    $('searchCount').classList.toggle('hidden', !$('search').value.trim())
    $('searchPrev').classList.toggle('hidden', !has || r.total < 2)
    $('searchNext').classList.toggle('hidden', !has || r.total < 2)
  }
  const scope = () => $('searchScope').value
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      let r = diagram.searchStep(e.shiftKey ? -1 : 1)
      if (!r.total) r = diagram.searchTable(e.target.value, scope())
      searchUi(r)
    } else if (e.key === 'Escape') { e.target.value = ''; diagram.searchTable(''); searchUi(null) }
  })
  $('search').addEventListener('input', e => searchUi(diagram.searchTable(e.target.value, scope())))
  $('searchScope').addEventListener('change', () => searchUi(diagram.searchTable($('search').value, scope())))
  $('searchPrev').addEventListener('click', () => searchUi(diagram.searchStep(-1)))
  $('searchNext').addEventListener('click', () => searchUi(diagram.searchStep(1)))
  window.addEventListener('hashchange', handleHash)

  try {
    state.config = await api.getConfig()
    state.currentBranch = state.config.currentBranch
    document.title = `Gabbro — ${state.config.repoName}`
    $('repoName').textContent = state.config.repoName
    if (isLocal()) setupLocalChrome()
    state.branches = await api.getBranches()
    if (!state.branches.length) { toast('repository has no branches yet', 'error'); return }

    // local: land on the checked-out branch (the only editable one);
    // hosted: v1 behavior (master, else edit branch, else first)
    const initial = isLocal() && state.currentBranch && state.branches.includes(state.currentBranch)
      ? state.currentBranch
      : state.branches.includes('master') ? 'master'
        : (state.branches.includes(state.config.editBranch) ? state.config.editBranch : state.branches[0])
    state.branch = initial
    fillBranchSelects()
    fillSelect($('diffBase'), state.branches, state.branches.includes('master') ? 'master' : state.branches[0])
    fillSelect($('diffTarget'), state.branches,
      state.branches.includes(state.config.editBranch) ? state.config.editBranch : state.branches[0])

    const p = await api.getPositions()
    if (p && p.tables) state.positions = { version: p.version || 1, tables: p.tables }

    await switchBranch(initial)
    // restore last tab; a stale #tbl-x hash from docs anchors must not hijack the diagram on reload
    const savedTab = localStorage.getItem('gabbro:tab') || 'diagram'
    setTab(savedTab)
    if (savedTab === 'docs') handleHash()
  } catch (e) { fail(e) }
}

boot()
