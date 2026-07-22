// App orchestration: global state, toolbar, tabs, branch switching, view/edit
// modes, diff mode, saves, toasts.

import * as api from './api.js'
import { parseDBML } from './parser.js'
import { diffModels, buildUnionModel } from './diff.js'
import * as diagram from './diagram.js'
import { initDocs, renderDocs, scrollToTable } from './docs.js'

const $ = id => document.getElementById(id)

const state = {
  config: null,
  branches: [],
  branch: null,
  tab: 'diagram',
  mode: 'view',
  diffOn: false,
  models: new Map(), // branch -> { text, model }
  positions: { version: 1, tables: {} },
  posDirty: false,
  dbmlDirty: false
}

/* ---------- toast ---------- */
let toastTimer = null
function toast (msg, type) {
  const el = $('toast')
  el.textContent = msg
  el.className = 'show' + (type === 'error' ? ' error' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = '' }, type === 'error' ? 6000 : 3500)
}
const fail = e => toast(e && e.message ? e.message : 'unexpected error', 'error')

/* ---------- data ---------- */
const draftKey = b => 'gabbro:' + b

async function ensureModel (b, force) {
  if (!force && state.models.has(b)) return state.models.get(b)
  const text = await api.getDbml(b)
  const entry = { text, model: parseDBML(text) }
  state.models.set(b, entry)
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
function canEdit () {
  return state.mode === 'edit' && !state.diffOn && state.branch === state.config.editBranch
}
function updateChrome () {
  document.body.classList.toggle('mode-view', state.mode !== 'edit' || state.diffOn)
  document.body.classList.toggle('mode-edit', state.mode === 'edit' && !state.diffOn)
  $('modeView').classList.toggle('on', state.mode === 'view')
  $('modeEdit').classList.toggle('on', state.mode === 'edit')
  $('modeEdit').disabled = state.diffOn
  diagram.setEditorVisible(state.mode === 'edit' && !state.diffOn && state.tab === 'diagram')

  const editing = state.mode === 'edit' && !state.diffOn
  $('btnSaveDbml').hidden = !editing
  $('btnSavePos').hidden = !editing
  const ok = canEdit()
  $('btnSaveDbml').disabled = !ok || !state.dbmlDirty
  $('btnSavePos').disabled = !ok || !state.posDirty

  const banner = $('banner')
  if (editing && state.branch !== state.config.editBranch) {
    banner.textContent = `read-only branch — switch to ${state.config.editBranch} to edit`
    banner.classList.remove('hidden')
  } else banner.classList.add('hidden')
}
function updateMeta () {
  const s = diagram.getStats()
  $('meta').textContent = s ? `${s.tables} tables · ${s.groups} groups · ${s.refs} refs` : ''
}

async function renderAll (opts) {
  opts = opts || {}
  if (state.diffOn) {
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
  state.branch = b
  $('branchSel').value = b
  state.dbmlDirty = false
  applyDraft(b)
  await renderAll({ fitView: true })
}

/* ---------- toolbar wiring ---------- */
function setTab (tab) {
  state.tab = tab
  document.querySelectorAll('#tabs .tab').forEach(el => el.classList.toggle('on', el.dataset.tab === tab))
  $('diagramSection').classList.toggle('hidden', tab !== 'diagram')
  $('docsSection').classList.toggle('hidden', tab !== 'docs')
  $('search').classList.toggle('hidden', tab !== 'diagram')
  updateChrome()
}

function fillSelect (sel, branches, value) {
  sel.innerHTML = ''
  for (const b of branches) {
    const o = document.createElement('option')
    o.value = b; o.textContent = b
    sel.appendChild(o)
  }
  if (value && branches.includes(value)) sel.value = value
}

async function toggleDiff (on) {
  state.diffOn = on
  $('btnDiff').classList.toggle('on', on)
  $('diffCtrls').classList.toggle('hidden', !on)
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
    fillSelect($('branchSel'), state.branches, state.branch)
    fillSelect($('diffBase'), state.branches, $('diffBase').value)
    fillSelect($('diffTarget'), state.branches, $('diffTarget').value)
    if (!state.posDirty) {
      const p = await api.getPositions()
      if (p && p.tables) state.positions = { version: p.version || 1, tables: p.tables }
    }
    await renderAll({ fitView: false })
    toast('refreshed from remote')
  } catch (e) { fail(e) } finally { btn.disabled = false }
}

async function saveDbml () {
  if (!canEdit()) return
  const message = window.prompt('Commit message (optional):', '')
  if (message === null) return
  const btn = $('btnSaveDbml')
  btn.disabled = true
  try {
    const text = diagram.getEditorText()
    const res = await api.putDbml(text, message)
    state.models.set(state.branch, { text, model: parseDBML(text) })
    state.dbmlDirty = false
    updateChrome()
    toast(`DBML committed to ${res.branch} (${String(res.commit).slice(0, 7)})`)
  } catch (e) { fail(e); updateChrome() }
}

async function savePositions () {
  if (!canEdit()) return
  const btn = $('btnSavePos')
  btn.disabled = true
  try {
    Object.assign(state.positions.tables, diagram.getDirtyPositions().tables)
    const res = await api.putPositions(state.positions)
    clearDrafts()
    state.posDirty = false
    diagram.clearDirty()
    updateChrome()
    toast(`positions committed to ${res.branch} (${String(res.commit).slice(0, 7)})`)
  } catch (e) { fail(e); updateChrome() }
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
    if (state.diffOn) return
    state.mode = 'edit'
    const entry = state.models.get(state.branch)
    if (entry) diagram.setEditorText(entry.text)
    updateChrome()
  })
  $('btnSaveDbml').addEventListener('click', saveDbml)
  $('btnSavePos').addEventListener('click', savePositions)
  $('search').addEventListener('keydown', e => { if (e.key === 'Enter') diagram.searchTable(e.target.value) })
  $('search').addEventListener('input', e => { if (e.target.value.length > 2) diagram.searchTable(e.target.value) })
  window.addEventListener('hashchange', handleHash)

  try {
    state.config = await api.getConfig()
    document.title = `Gabbro — ${state.config.repoName}`
    $('repoName').textContent = state.config.repoName
    state.branches = await api.getBranches()
    if (!state.branches.length) { toast('repository has no branches yet', 'error'); return }

    const initial = state.branches.includes('master') ? 'master'
      : (state.branches.includes(state.config.editBranch) ? state.config.editBranch : state.branches[0])
    fillSelect($('branchSel'), state.branches, initial)
    fillSelect($('diffBase'), state.branches, state.branches.includes('master') ? 'master' : state.branches[0])
    fillSelect($('diffTarget'), state.branches,
      state.branches.includes(state.config.editBranch) ? state.config.editBranch : state.branches[0])

    const p = await api.getPositions()
    if (p && p.tables) state.positions = { version: p.version || 1, tables: p.tables }

    await switchBranch(initial)
    handleHash()
  } catch (e) { fail(e) }
}

boot()
