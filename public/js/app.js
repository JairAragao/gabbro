import * as api from './api.js'
import { parseDBML } from './parser.js'
import { diffModels, diffSummaryLine, buildUnionModel } from './diff.js'
import * as diagram from './diagram.js'
import { initDocs, renderDocs, scrollToTable } from './docs.js'
import * as hist from './history.js'
import { enhanceSelects } from './selectui.js'

const $ = id => document.getElementById(id)

const state = {
  config: null,
  branches: [],
  branch: null,
  tab: 'diagram',
  mode: 'view',
  diffOn: false,
  diffTabs: [], // comparações abertas: [{base, target}] — viram abas no topo
  diffIdx: null, // índice da comparação ativa (null = modo normal)
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

let toastTimer = null
function toast (msg, type) {
  const el = $('toast')
  el.textContent = msg
  el.className = 'show' + (type === 'error' ? ' error' : type === 'warn' ? ' warn' : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.className = '' }, type ? 6000 : 3500)
}
const fail = e => toast(e && e.message ? e.message : 'erro inesperado', 'error')
// Accumulated push warning from the server ({reason, detail, fix}) — yellow,
// non-blocking: the commit itself succeeded.
function warnToast (w) {
  if (!w) return
  toast(`push pendente (${w.reason}): ${w.detail || ''}${w.fix ? ' — ' + w.fix : ''}`, 'warn')
}

// prefixo próprio: clearDrafts() NÃO pode varrer 'gabbro:*' inteiro — as
// preferências (autosave, sync-prefs, update-interval, tab, mini-mode) moram lá
const draftKey = b => 'gabbro:draft:' + b

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
    if (k && k.startsWith('gabbro:draft:')) gone.push(k)
  }
  gone.forEach(k => localStorage.removeItem(k))
}

const isLocal = () => state.config && state.config.mode === 'local'
// The only branch that accepts writes: local → the checked-out branch,
// hosted → EDIT_BRANCH (v1 behavior untouched).
function editableBranch () {
  if (!state.config) return null
  return isLocal() ? state.currentBranch : state.config.editBranch
}
function canEdit () {
  return !!state.config && state.mode === 'edit' && !state.diffOn && !state.hist &&
    !state.config.readOnly && state.branch === editableBranch()
}
// Branches com edição de DBML não salva (texto do cache difere do baseline).
// A flag dbmlDirty é só da branch ATUAL — cache sujo de outra branch vive aqui.
function dirtyDbmlBranches () {
  const out = new Set()
  for (const [b, e] of state.models) {
    const base = state.baselines.get(b)
    if (base && e.text !== base.text) out.add(b)
  }
  return out
}
function updateChrome () {
  if (!state.config) return // boot falhou/incompleto — sem chrome pra atualizar
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
  const save = $('btnSave')
  const nDirty = (state.dbmlDirty ? 1 : 0) + (state.posDirty ? 1 : 0)
  save.hidden = !editing || state.config.readOnly
  save.disabled = !ok || !nDirty
  // o rótulo diz o que será salvo (schema, posições ou ambos)
  save.textContent = state.dbmlDirty && state.posDirty ? 'Salvar tudo'
    : state.posDirty && !state.dbmlDirty ? 'Salvar posições'
      : 'Salvar'
  save.title = state.dbmlDirty && state.posDirty ? 'Commita o schema e as posições'
    : state.dbmlDirty ? 'Commita o schema (DBML)'
      : state.posDirty ? 'Commita as posições das tabelas'
        : 'Nada para salvar'

  const banner = $('banner')
  if (editing && state.branch !== editableBranch()) {
    banner.textContent = editableBranch()
      ? `branch somente leitura — troque para ${editableBranch()} para editar`
      : 'repositório em detached HEAD — faça checkout de uma branch para editar'
    banner.classList.remove('hidden')
  } else banner.classList.add('hidden')

  $('identityBanner').classList.toggle('hidden', !(isLocal() && !state.config.identity))

  const hb = $('histBanner')
  if (state.hist) {
    const m = state.hist.meta
    $('histBannerText').textContent =
      `Visualizando commit ${m.shortHash || state.hist.hash.slice(0, 7)} — ${hist.firstLine(m.message)}`
    hb.classList.remove('hidden')
  } else hb.classList.add('hidden')

  if (isLocal()) $('branchSel').classList.toggle('current', state.branch === state.currentBranch)
}
function updateMeta () {
  const s = diagram.getStats()
  $('metaChip').textContent = s ? `${s.tables} tabelas · ${s.groups} grupos · ${s.refs} refs` : ''
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
    updateDiffNav(h.diff)          // painel MUDANÇAS (igual diff normal)
    diagram.setDiffDim(diffDim)    // escurece o que não mudou
  } else if (state.diffOn && activeDiffTab()) {
    const { base, target } = activeDiffTab()
    const [b, t] = await Promise.all([ensureModel(base), ensureModel(target)])
    const d = diffModels(b.model, t.model)
    const union = buildUnionModel(b.model, t.model, d)
    diagram.loadModel(union, state.positions, d, { fitView: opts.fitView !== false, dirty: state.posDirty })
    renderDocs(union, d)
    updateDiffNav(d)
    diagram.setDiffDim(diffDim)
  } else {
    const entry = await ensureModel(state.branch)
    diagram.loadModel(entry.model, state.positions, null, { fitView: opts.fitView !== false, dirty: state.posDirty })
    renderDocs(entry.model, null)
    if (opts.syncEditor !== false) diagram.setEditorText(entry.text)
    $('diffNav').classList.add('hidden') // sem diff/histórico: sem painel de mudanças
    diagram.setDiffDim(false)
  }
  updateMeta()
  updateChrome()
}

async function switchBranch (b) {
  if (state.hist) { state.hist = null; hist.setActive(null) } // picking a branch leaves history mode
  state.branch = b
  $('branchSel').value = b
  // edição não salva vive no cache por branch — voltar pra uma branch suja
  // reativa a flag (e o botão Salvar), em vez de zerar incondicionalmente
  state.dbmlDirty = dirtyDbmlBranches().has(b)
  applyDraft(b)
  if (state.diffTabs.length) renderTabBar() // a aba principal mostra a branch atual
  await renderAll({ fitView: true })
}

/* ---------- modo histórico (dialog quase tela cheia, 3 colunas) ---------- */

const histView = { commits: [], skip: 0, hasMore: false, loading: false, active: null }
const isSchemaCommit = c => Array.isArray(c.files) && state.config && c.files.includes(state.config.dbmlFile)

async function openHistoryCommit (c) {
  try {
    if (state.diffOn) { state.diffIdx = null; setDiffUi(false) } // diff e histórico são exclusivos
    $('settingsModal').classList.add('hidden'); $('btnSettings').classList.remove('on')
    document.body.classList.add('hist-mode')
    if (!histView.commits.length) await loadHistViewPage()
    await showHistCommit(c.hash, c)
  } catch (e) { fail(e) }
}

async function loadHistViewPage () {
  if (histView.loading) return
  histView.loading = true
  try {
    const r = await api.getHistoryAll(histView.skip, 40)
    const commits = (r && r.commits) || []
    histView.skip += commits.length
    histView.hasMore = !!(r && r.hasMore)
    histView.commits.push(...commits)
    renderHistSideList()
    $('histSideMore').classList.toggle('hidden', !histView.hasMore)
  } finally { histView.loading = false }
}

function renderHistSideList () {
  const box = $('histSideList')
  box.innerHTML = ''
  for (const c of histView.commits) {
    const schema = isSchemaCommit(c)
    const el = document.createElement(schema ? 'button' : 'div')
    el.className = 'hv-row' + (schema ? '' : ' locked') + (histView.active === c.hash ? ' on' : '')
    el.title = schema ? c.message : 'Commit sem mudança de schema (posições/outros)'
    el.innerHTML =
      `<div class="hv-top"><span class="hist-pill mono">${escHtml(c.shortHash || '')}</span>` +
      `<span class="hv-msg">${escHtml(hist.firstLine(c.message))}</span></div>` +
      `<div class="hv-sub"><span>${escHtml(c.authorName || c.authorEmail || 'desconhecido')}</span>` +
      `<span class="hist-sep">·</span><span title="${escHtml(hist.absoluteTime(c.date))}">${escHtml(hist.relativeTime(c.date))}</span></div>`
    if (schema) el.addEventListener('click', () => showHistCommit(c.hash, c).catch(fail))
    box.appendChild(el)
  }
}

async function showHistCommit (hash, meta) {
  const r = await api.getCommit(hash)
  const model = parseDBML(r.content || '')
  const parentModel = parseDBML(r.parentContent || '')
  state.hist = { hash, meta: r.meta || meta || {}, model, parentModel, diff: diffModels(parentModel, model) }
  state.mode = 'view'
  histView.active = hash
  renderHistSideList()
  const m = state.hist.meta
  $('histTopInfo').textContent = `${(m.shortHash || hash.slice(0, 7))} — ${hist.firstLine(m.message)}`
  setTab('diagram')
  await renderAll({ fitView: true })
  // código: diff textual do commit (lado a lado)
  const pre = $('histCodePre')
  pre.textContent = 'Carregando…'
  try {
    const txt = await api.getCommitDiff(hash)
    pre.innerHTML = txt.trim() ? renderDiffTextSplit(txt) : '<div class="sp-hunk">(sem diff textual)</div>'
  } catch (e) { pre.textContent = e.message || 'falha ao carregar o código' }
}

function exitHistory () {
  if (!document.body.classList.contains('hist-mode') && !state.hist) return
  document.body.classList.remove('hist-mode')
  state.hist = null
  histView.active = null
  renderAll({ fitView: true }).catch(fail)
}

function setTab (tab) {
  if (tab !== 'diagram' && tab !== 'docs') tab = 'diagram' // 'history' saiu do topo
  state.tab = tab
  localStorage.setItem('gabbro:tab', tab)
  document.querySelectorAll('#tabs .tab').forEach(el => el.classList.toggle('on', el.dataset.tab === tab))
  $('diagramSection').classList.toggle('hidden', tab !== 'diagram')
  $('docsSection').classList.toggle('hidden', tab !== 'docs')
  document.body.classList.toggle('tab-diagram', tab === 'diagram') // busca central só no diagrama
  updateChrome()
}

function fillSelect (sel, branches, value, currentB) {
  sel.innerHTML = ''
  for (const b of branches) {
    const o = document.createElement('option')
    o.value = b
    o.textContent = currentB && b === currentB ? `${b} (atual)` : b
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
  $('diffCtrls').classList.toggle('hidden', !on)
  document.body.classList.toggle('diff-on', on) // tema âmbar no modo diff
  if (!on) hideDiffTools()
  renderTabBar()
}

/* ---------- barra de abas no topo (aba da branch + abas de comparação) ---------- */

const activeDiffTab = () => (state.diffIdx != null ? state.diffTabs[state.diffIdx] : null)

function renderTabBar () {
  const bar = $('diffTabs')
  const hasTabs = state.diffTabs.length > 0
  document.body.classList.toggle('has-tabs', hasTabs)
  bar.classList.toggle('hidden', !hasTabs)
  bar.innerHTML = ''
  if (!hasTabs) return

  const mkTab = (cls, title, inner, onClick) => {
    const t = document.createElement('button')
    t.className = 'vtab ' + cls
    t.title = title
    // orelhas curvas (estilo Chrome) via pseudo-elementos no CSS
    t.innerHTML = `<span class="vt-in">${inner}</span>`
    t.addEventListener('click', onClick)
    bar.appendChild(t)
  }

  // aba principal: a branch atual (visualização normal), sempre presente
  mkTab(state.diffIdx == null ? 'on' : '', `Branch ${state.branch}`,
    `<span class="vt-dot live"></span><span class="vt-lbl">${escHtml(state.branch || '—')}</span>`,
    () => activateDiff(null))

  // uma aba por comparação de diff
  state.diffTabs.forEach((t, i) => {
    mkTab('diff' + (state.diffIdx === i ? ' on' : ''), `Comparar ${t.base} → ${t.target}`,
      `<span class="vt-dot"></span><span class="vt-lbl">${escHtml(t.base)} → ${escHtml(t.target)}</span>` +
      `<span class="vt-x" title="Fechar">✕</span>`,
      e => { if (e.target.closest('.vt-x')) { closeDiffTab(i); return } activateDiff(i) })
  })
}

function activateDiff (idx) {
  if (idx != null && state.hist) { state.hist = null; hist.setActive(null) } // exclusivos
  state.diffIdx = idx
  setDiffUi(idx != null)
  renderAll({ fitView: true }).catch(fail)
  if (idx != null) openDiffText() // comparação abre já com o diff textual
}

function openDiffText () {
  diffPaneOpen = true
  $('diffPane').classList.remove('hidden')
  $('btnDiffText').classList.add('on')
  loadDiffText()
}

function closeDiffTab (i) {
  const wasActive = state.diffIdx === i
  state.diffTabs.splice(i, 1)
  if (wasActive) { activateDiff(null); return }
  if (state.diffIdx != null && state.diffIdx > i) state.diffIdx--
  renderTabBar()
}

// botão Comparar desabilitado quando base === alvo (nada pra comparar)
function refreshDiffGo () {
  const same = $('diffBase').value === $('diffTarget').value
  $('diffGo').disabled = same
  $('diffSameWarn').classList.toggle('hidden', !same)
}

function openDiffModal () {
  const base = $('diffBase'), target = $('diffTarget')
  fillSelect(base, state.branches, base.value || (state.branches.includes('master') ? 'master' : state.branches[0]))
  fillSelect(target, state.branches, target.value || state.branch)
  refreshDiffGo()
  $('diffModal').classList.remove('hidden')
}
function closeDiffModal () { $('diffModal').classList.add('hidden') }

function confirmDiff () {
  const base = $('diffBase').value, target = $('diffTarget').value
  if (!base || !target || base === target) return
  closeDiffModal()
  const existing = state.diffTabs.findIndex(t => t.base === base && t.target === target)
  if (existing !== -1) { activateDiff(existing); return }
  state.diffTabs.push({ base, target })
  activateDiff(state.diffTabs.length - 1)
}

/* ---------- modo diff: navegador de mudanças + diff textual ---------- */

let diffDim = true
let diffPaneOpen = false

function hideDiffTools () {
  $('diffNav').classList.add('hidden')
  $('diffPane').classList.add('hidden')
  $('btnDiffText').classList.remove('on')
  diffPaneOpen = false
  diagram.setDiffDim(false)
}

function updateDiffNav (d) {
  const nav = $('diffNav')
  const groups = { added: [], modified: [], removed: [] }
  for (const [nm, td] of Object.entries(d.tables)) if (td.status !== 'same') groups[td.status].push(nm)
  Object.values(groups).forEach(a => a.sort())
  const total = groups.added.length + groups.modified.length + groups.removed.length
  nav.classList.remove('hidden')
  if (!total) {
    nav.innerHTML = '<div class="dn-head">Mudanças</div><div class="dn-empty">sem diferenças estruturais</div>'
    return
  }
  const block = (status, label, names) => names.length
    ? `<div class="dn-sec"><span class="diff-tag ${status}">${label} ${names.length}</span></div>` +
      names.map(nm => `<button class="dn-item" data-t="${escHtml(nm)}">${escHtml(nm)}</button>`).join('')
    : ''
  nav.innerHTML = `<div class="dn-head">Mudanças <span class="doc-count">${total}</span></div><div class="dn-list">` +
    block('added', 'NOVAS', groups.added) +
    block('modified', 'ALTERADAS', groups.modified) +
    block('removed', 'REMOVIDAS', groups.removed) + '</div>'
  nav.querySelectorAll('.dn-item').forEach(b =>
    b.addEventListener('click', () => diagram.centerOnTable(b.dataset.t)))
}

let dpMode = 'unified' // 'unified' | 'split'
let dpLastTxt = ''

function renderDiffTextHtml (txt) {
  return txt.split('\n').map(l => {
    const cls = /^(\+\+\+|---)/.test(l) ? 'dh' : l[0] === '+' ? 'da' : l[0] === '-' ? 'dr' : l.startsWith('@@') ? 'dm' : ''
    return `<span class="dl${cls ? ' ' + cls : ''}">${escHtml(l) || ' '}</span>`
  }).join('\n')
}

// lado a lado: emparelha blocos de removidas (esquerda) com adicionadas (direita);
// contexto alinha nos dois lados; cabeçalhos de hunk (@@) marcam bloco
function renderDiffTextSplit (txt) {
  const rows = []
  const pushPair = (delA, delB) => {
    const n = Math.max(delA.length, delB.length)
    for (let i = 0; i < n; i++) rows.push({ l: delA[i], r: delB[i], t: 'chg' })
  }
  let delA = [], delB = []
  for (const raw of txt.split('\n')) {
    if (/^(diff --git|index |\+\+\+|---)/.test(raw)) continue // ruído de cabeçalho do git
    if (raw.startsWith('@@')) { pushPair(delA, delB); delA = []; delB = []; rows.push({ hunk: raw }); continue }
    if (raw[0] === '-') { delA.push(raw.slice(1)); continue }
    if (raw[0] === '+') { delB.push(raw.slice(1)); continue }
    pushPair(delA, delB); delA = []; delB = []
    rows.push({ l: raw.replace(/^ /, ''), r: raw.replace(/^ /, ''), t: 'ctx' })
  }
  pushPair(delA, delB)
  const cell = (v, side) => {
    if (v == null) return `<div class="sp-cell sp-empty"></div>`
    return `<div class="sp-cell sp-${side}">${escHtml(v) || ' '}</div>`
  }
  return rows.map(r => {
    if (r.hunk != null) return `<div class="sp-hunk">${escHtml(r.hunk)}</div>`
    if (r.t === 'ctx') return `<div class="sp-row">${cell(r.l, 'ctx')}${cell(r.r, 'ctx')}</div>`
    return `<div class="sp-row">${cell(r.l, r.l != null ? 'del' : 'x')}${cell(r.r, r.r != null ? 'add' : 'x')}</div>`
  }).join('')
}

function paintDiffText () {
  const pre = $('dpPre')
  if (!dpLastTxt.trim()) { pre.textContent = '(sem diferenças no texto entre as branches)'; return }
  if (dpMode === 'split') { pre.className = 'sp'; pre.innerHTML = renderDiffTextSplit(dpLastTxt) } else { pre.className = ''; pre.innerHTML = renderDiffTextHtml(dpLastTxt) }
}

async function loadDiffText () {
  const tabD = activeDiffTab()
  if (!tabD) return
  const pre = $('dpPre')
  pre.className = ''
  pre.textContent = 'Carregando…'
  try {
    dpLastTxt = await api.getDiffText(tabD.base, tabD.target)
    paintDiffText()
  } catch (e) { pre.textContent = e.message || 'falha ao carregar o diff' }
}

// Recarrega o cache de modelos preservando edição de DBML não salva (em
// qualquer branch): entries sujas sobrevivem e ganham baseline novo do disco.
// Retorna o Map das branches preservadas — usado pra decidir syncEditor.
async function reloadModelsKeepDirty () {
  const kept = new Map()
  for (const b of dirtyDbmlBranches()) kept.set(b, state.models.get(b))
  state.models.clear()
  state.baselines.clear()
  for (const [b, e] of kept) {
    state.models.set(b, e)
    try {
      const text = await api.getDbml(b)
      state.baselines.set(b, { text, model: parseDBML(text) })
    } catch (e2) { /* branch pode ter sumido — segue sem baseline */ }
  }
  return kept
}

async function doRefresh () {
  const btn = $('btnRefresh')
  btn.disabled = true
  try {
    await api.refresh()
    const kept = await reloadModelsKeepDirty()
    state.dbmlDirty = kept.has(state.branch)
    state.branches = await api.getBranches()
    fillBranchSelects()
    if (!state.posDirty) {
      const p = await api.getPositions()
      if (p && p.tables) state.positions = { version: p.version || 1, tables: p.tables }
    }
    await renderAll({ fitView: false, syncEditor: !kept.has(state.branch) })
    if (state.tab === 'history') hist.reload().catch(() => { /* best-effort */ })
    else hist.invalidate()
    refreshSyncBadge()
    if (kept.size) toast('atualizado — sua edição de DBML não salva foi preservada no editor', 'warn')
    else toast('atualizado do remoto')
  } catch (e) { fail(e) } finally { btn.disabled = false }
}

function saveFail (e) {
  if (e && e.status === 409) toast('a branch mudou por fora — recarregue a página', 'error')
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
  const message = window.prompt('Mensagem do commit (opcional):', prefill)
  if (message === null) return false
  $('btnSave').disabled = true
  try {
    const res = await api.putDbml(text, message, isLocal() ? state.branch : undefined)
    const entry = { text, model: parseDBML(text) }
    state.models.set(state.branch, entry)
    state.baselines.set(state.branch, entry)
    state.dbmlDirty = false
    updateChrome()
    toast(`DBML commitado em ${res.branch} (${String(res.commit).slice(0, 7)})`)
    warnToast(res.warning)
    refreshSyncBadge()
    return true
  } catch (e) { saveFail(e); return false }
}

let posSaveInFlight = false
async function savePositions () {
  if (!canEdit() || posSaveInFlight) return
  $('btnSave').disabled = true
  posSaveInFlight = true
  try {
    Object.assign(state.positions.tables, diagram.getDirtyPositions().tables)
    const res = await api.putPositions(state.positions, isLocal() ? state.branch : undefined)
    clearDrafts()
    state.posDirty = false
    diagram.clearDirty()
    updateChrome()
    toast(`posições commitadas em ${res.branch} (${String(res.commit).slice(0, 7)})`)
    warnToast(res.warning)
    refreshSyncBadge()
  } catch (e) { saveFail(e) } finally { posSaveInFlight = false }
}

// botão único: commita o que estiver sujo (schema e/ou posições)
async function saveAll () {
  if (!canEdit()) return
  if (state.dbmlDirty) { const ok = await saveDbml(); if (!ok) return }
  if (state.posDirty) await savePositions()
}

/* ---------- salvamento automático de posições (configurável) ---------- */

const AUTOSAVE_KEY = 'gabbro:autosave'
const autosave = { on: false, secs: 30 }
let autosaveLastTry = 0

function loadAutosave () {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTOSAVE_KEY))
    if (raw && typeof raw === 'object') {
      autosave.on = !!raw.on
      const s = Number(raw.secs)
      if (Number.isFinite(s)) autosave.secs = Math.max(5, Math.min(3600, Math.round(s)))
    }
  } catch (e) { /* config corrompida — usa o padrão */ }
}
function persistAutosave () {
  try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(autosave)) } catch (e) { /* storage cheio */ }
}

/* ---------- sincronização automática + estratégia de conflito ---------- */

const SYNC_PREFS_KEY = 'gabbro:sync-prefs'
const syncPrefs = { intervalMs: 0, strategy: 'rebase' }
let autosyncLastTry = 0

const STRATEGY_HINTS = {
  rebase: 'O remoto vence: rebase automático das suas mudanças por cima dele, com aviso quando não der.',
  safe: 'Só aplica quando dá fast-forward; divergência não toca seus arquivos e te avisa.',
  ask: 'Em divergência o Gabbro pergunta o que fazer (no sync automático, só avisa).'
}

function loadSyncPrefs () {
  try {
    const raw = JSON.parse(localStorage.getItem(SYNC_PREFS_KEY))
    if (raw && typeof raw === 'object') {
      const ms = Number(raw.intervalMs)
      if ([0, 60000, 300000, 900000].includes(ms)) syncPrefs.intervalMs = ms
      if (['rebase', 'safe', 'ask'].includes(raw.strategy)) syncPrefs.strategy = raw.strategy
    }
  } catch (e) { /* prefs corrompidas — usa o padrão */ }
}
function persistSyncPrefs () {
  try { localStorage.setItem(SYNC_PREFS_KEY, JSON.stringify(syncPrefs)) } catch (e) { /* storage cheio */ }
}

function updateLastSyncLabel () {
  const el = $('lastSyncLbl')
  if (!el) return
  if (!lastSyncAt) { el.textContent = '—'; return }
  const d = new Date(lastSyncAt)
  const pad = n => String(n).padStart(2, '0')
  el.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function autosyncTick () {
  if (!syncPrefs.intervalMs || !isLocal() || state.hist) return
  // nunca sincroniza por cima de edição não salva — em QUALQUER branch
  if (state.dbmlDirty || state.posDirty || syncInFlight || dirtyDbmlBranches().size) return
  if (Date.now() - autosyncLastTry < syncPrefs.intervalMs) return
  autosyncLastTry = Date.now()
  doSync({ quiet: true, auto: true })
}

/* ---------- saúde do git (aba Sincronização) ---------- */

async function loadGitHealth () {
  if (!isLocal()) return
  const btn = $('ghRefresh')
  btn.disabled = true
  try {
    const h = await api.getGitHealth()
    const pill = $('ghPill')
    pill.classList.remove('hidden')
    pill.textContent = h.ok ? 'tudo OK' : 'atenção'
    pill.classList.toggle('warn', !h.ok)
    $('ghMeta').innerHTML =
      `<span>branch: <b>${escHtml(h.branch || '—')}</b></span>` +
      `<span>usuário: <b>${h.identity ? escHtml(h.identity.name + ' <' + h.identity.email + '>') : '— não configurado'}</b></span>` +
      `<span>remoto: <b>${escHtml(h.remoteUrl || '— nenhum')}</b></span>`
    const ul = $('ghChecks')
    ul.innerHTML = ''
    for (const c of h.checks || []) {
      const li = document.createElement('li')
      li.className = 'gh-check' + (c.ok ? '' : ' bad')
      li.innerHTML = `<span class="gh-ico">${c.ok ? '✓' : '✕'}</span>` +
        `<span class="gh-txt"><span class="gh-lbl">${escHtml(c.label)}</span>` +
        `<span class="gh-det" title="${escHtml(c.detail || '')}">${escHtml(c.detail || '')}</span></span>`
      ul.appendChild(li)
    }
  } catch (e) {
    $('ghChecks').innerHTML = `<li class="gh-check bad"><span class="gh-ico">✕</span><span class="gh-txt"><span class="gh-lbl">Falha ao consultar o git</span><span class="gh-det">${escHtml(e.message || '')}</span></span></li>`
  } finally { btn.disabled = false }
}

const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

/* ---------- atualizações (aba Atualizações) ---------- */

const UPD_INTERVAL_KEY = 'gabbro:update-interval'
const UPD_INTERVALS = ['0', '1800000', '3600000', '10800000', '21600000', '86400000']
const UPD_STATE_LABELS = {
  idle: 'Pronto para verificar.',
  checking: 'Verificando atualizações…',
  uptodate: 'Você está na versão mais recente.',
  available: 'Baixando atualização…',
  downloading: 'Baixando atualização…',
  downloaded: 'Atualização pronta para instalar.',
  error: 'Falha ao verificar atualização.'
}
let changelogLoaded = false

function loadUpdInterval () {
  try {
    const v = localStorage.getItem(UPD_INTERVAL_KEY)
    return UPD_INTERVALS.includes(v) ? v : '10800000'
  } catch (e) { return '10800000' }
}

function applyUpdStatus (s) {
  if (!s || !s.state) return
  const row = $('updStatusRow')
  row.classList.remove('hidden')
  const label = s.state === 'downloading' && s.percent
    ? `Baixando atualização… ${s.percent}%`
    : (UPD_STATE_LABELS[s.state] || '')
  $('updStatus').textContent = label
  const dot = $('updDot')
  dot.className = 'upd-dot ' + (
    ['downloaded', 'available', 'downloading'].includes(s.state) ? 'busy'
      : s.state === 'uptodate' ? 'ok'
        : s.state === 'error' ? 'err' : '')
  $('updInstall').classList.toggle('hidden', s.state !== 'downloaded')
  $('updCheck').disabled = s.state === 'checking' || s.state === 'downloading'
}

async function loadChangelog () {
  const box = $('changelogList')
  box.innerHTML = '<p class="sm-empty">Carregando…</p>'
  try {
    const r = await api.getChangelog()
    $('updVersion').textContent = r.version ? 'v' + r.version : '—'
    const versions = parseChangelog(r.markdown || '')
    if (!versions.length) { box.innerHTML = '<p class="sm-empty">Sem changelog.</p>'; return }
    box.innerHTML = ''
    for (const v of versions) {
      const sec = document.createElement('div')
      sec.className = 'cl-ver'
      let html = `<div class="cl-ver-head"><span class="cl-tag">${escHtml(v.tag)}</span>` +
        (v.date ? `<span class="cl-date">${escHtml(v.date)}</span>` : '') +
        (r.version && v.tag === 'v' + r.version ? '<span class="cl-current">atual</span>' : '') + '</div>'
      for (const blk of v.blocks) {
        if (blk.type === 'head') html += `<div class="cl-head">${escHtml(blk.text)}</div>`
        else if (blk.type === 'list') html += '<ul class="cl-items">' + blk.items.map(it => `<li>${escHtml(it)}</li>`).join('') + '</ul>'
        else html += `<p class="cl-p">${escHtml(blk.text)}</p>`
      }
      sec.innerHTML = html
      box.appendChild(sec)
    }
    changelogLoaded = true
  } catch (e) {
    box.innerHTML = `<p class="sm-empty">${escHtml(e.message || 'Falha ao carregar o changelog.')}</p>`
  }
}

// parse leve do keep-a-changelog: "## [x] - data" vira versão; blocos = '###',
// listas '-' ou parágrafos (padrão portado do Basalt).
function parseChangelog (md) {
  const out = []
  let cur = null
  let list = null
  const pushList = () => { if (list && list.items.length) cur.blocks.push(list); list = null }
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const mv = /^##\s+\[?([^\]]+?)\]?\s*(?:[-—]\s*(.+))?$/.exec(line)
    if (/^##\s+/.test(line) && mv) {
      if (cur) pushList()
      const ver = (mv[1] || '').trim()
      cur = { tag: /^\d/.test(ver) ? 'v' + ver : ver, date: (mv[2] || '').trim(), blocks: [] }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (/^###\s+/.test(line)) { pushList(); cur.blocks.push({ type: 'head', text: line.replace(/^###\s+/, '') }); continue }
    const mi = /^[-*]\s+(.+)/.exec(line)
    if (mi) { if (!list) list = { type: 'list', items: [] }; list.items.push(mi[1].replace(/\*\*/g, '')); continue }
    if (!line.trim()) { pushList(); continue }
    pushList()
    cur.blocks.push({ type: 'p', text: line.replace(/\*\*/g, '') })
  }
  if (cur) pushList()
  return out.slice(0, 40)
}

/* ---------- modal de configurações ---------- */

function setSettingsTab (tab) {
  document.querySelectorAll('.sm-tab').forEach(el => el.classList.toggle('on', el.dataset.set === tab))
  $('setGeneral').classList.toggle('hidden', tab !== 'general')
  $('setSync').classList.toggle('hidden', tab !== 'sync')
  $('setHistory').classList.toggle('hidden', tab !== 'history')
  $('setKeys').classList.toggle('hidden', tab !== 'keys')
  $('setUpdates').classList.toggle('hidden', tab !== 'updates')
  if (tab === 'sync') {
    // sync automático + saúde do git são do modo local — no hosted os
    // controles somem e fica só o aviso, em vez de um painel morto
    const local = isLocal()
    $('syncPrefsSec').classList.toggle('hidden', !local)
    $('ghSec').classList.toggle('hidden', !local)
    $('syncHostedNote').classList.toggle('hidden', local)
    if (local) loadGitHealth()
  }
  if (tab === 'history') hist.ensureLoaded().catch(fail)
  if (tab === 'updates') {
    // valor persistido vem do settings.json via config — localStorage não
    // sobrevive à troca de porta do Electron entre launches
    if (window.gabbroDesktop && state.config && state.config.updateIntervalMs != null) {
      const usel = $('updIntervalSel')
      const v = String(state.config.updateIntervalMs)
      if (UPD_INTERVALS.includes(v) && usel.value !== v) {
        usel.value = v
        usel.dispatchEvent(new Event('change'))
      }
    }
    if (!changelogLoaded) loadChangelog()
  }
}

function initSettingsUi () {
  loadAutosave()
  loadSyncPrefs()
  // relógio do autosave parte do boot — nunca commita no primeiro drag da sessão
  autosaveLastTry = Date.now()
  autosyncLastTry = Date.now()
  const btn = $('btnSettings'), modal = $('settingsModal')
  const open = () => {
    modal.classList.remove('hidden'); btn.classList.add('on'); updateLastSyncLabel()
    $('routesOn').checked = diagram.getOrthoAvoid() // pode ter mudado pelo botão Rotas
  }
  const close = () => { modal.classList.add('hidden'); btn.classList.remove('on') }
  btn.addEventListener('click', () => modal.classList.contains('hidden') ? open() : close())
  $('settingsClose').addEventListener('click', close)
  modal.addEventListener('mousedown', e => { if (e.target === modal) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close() })
  document.querySelectorAll('.sm-tab').forEach(el => el.addEventListener('click', () => setSettingsTab(el.dataset.set)))

  // Geral — autosave de posições
  const chk = $('autosaveOn'), secs = $('autosaveSecs')
  chk.checked = autosave.on
  secs.value = autosave.secs
  secs.disabled = !autosave.on
  chk.addEventListener('change', () => {
    autosave.on = chk.checked
    secs.disabled = !autosave.on
    autosaveLastTry = Date.now() // o relógio zera ao ligar — nunca salva na hora
    persistAutosave()
    toast(autosave.on ? `salvamento automático ativado (a cada ${autosave.secs}s)` : 'salvamento automático desativado')
  })
  secs.addEventListener('change', () => {
    const v = Math.max(5, Math.min(3600, Math.round(Number(secs.value) || 30)))
    secs.value = v
    autosave.secs = v
    persistAutosave()
  })
  setInterval(() => {
    if (!autosave.on || !canEdit() || !state.posDirty) return
    if (posSaveInFlight || diagram.isDragging()) return
    if (Date.now() - autosaveLastTry < autosave.secs * 1000) return
    autosaveLastTry = Date.now()
    savePositions()
  }, 1000)

  // Geral — roteamento das linhas (mesmo estado do botão Rotas)
  $('routesOn').addEventListener('change', () => diagram.setOrthoAvoid($('routesOn').checked))

  // Sincronização — intervalo + estratégia
  const asel = $('autosyncSel'), ssel = $('strategySel')
  asel.value = String(syncPrefs.intervalMs)
  ssel.value = syncPrefs.strategy
  const syncHints = () => {
    $('autosyncHint').textContent = syncPrefs.intervalMs === 0
      ? 'O Gabbro só sincroniza quando você clicar em Sincronizar.'
      : 'O Gabbro sincroniza com o remoto nesse intervalo — nunca por cima de edição não salva.'
    $('strategyHint').textContent = STRATEGY_HINTS[syncPrefs.strategy] || ''
  }
  syncHints()
  asel.addEventListener('change', () => {
    syncPrefs.intervalMs = Number(asel.value) || 0
    autosyncLastTry = Date.now()
    persistSyncPrefs()
    syncHints()
  })
  ssel.addEventListener('change', () => {
    if (['rebase', 'safe', 'ask'].includes(ssel.value)) syncPrefs.strategy = ssel.value
    persistSyncPrefs()
    syncHints()
  })
  $('ghRefresh').addEventListener('click', loadGitHealth)
  setInterval(autosyncTick, 15000)

  // Histórico — alternar entre commits do schema e todos os arquivos
  $('histAllFiles').addEventListener('change', e => hist.setAllFiles(e.target.checked).catch(fail))

  // Atualizações
  const desktop = !!window.gabbroDesktop
  $('updWebNote').classList.toggle('hidden', desktop)
  $('updCheck').classList.toggle('hidden', !desktop)
  $('updIntervalSec').classList.toggle('hidden', !desktop)
  $('clReload').addEventListener('click', loadChangelog)
  if (desktop) {
    const usel = $('updIntervalSel')
    usel.value = loadUpdInterval()
    const updHint = () => {
      $('updIntervalHint').textContent = usel.value === '0'
        ? 'Desligado — o Gabbro só procura atualização quando você clicar em "Verificar agora".'
        : 'O Gabbro procura uma versão nova nesse intervalo e avisa quando estiver pronta.'
    }
    updHint()
    // sem push no boot: o main process já leu o valor persistido do
    // settings.json — empurrar o default daqui religaria o auto-update
    usel.addEventListener('change', () => {
      if (!UPD_INTERVALS.includes(usel.value)) return
      // mantém o config em sincronia — senão reentrar na aba compara com o
      // valor estagnado do boot e reverte a escolha do usuário
      if (state.config) state.config.updateIntervalMs = Number(usel.value)
      try { localStorage.setItem(UPD_INTERVAL_KEY, usel.value) } catch (e) { /* storage cheio */ }
      try { window.gabbroDesktop.setUpdateInterval(Number(usel.value)) } catch (e) { /* preload antigo */ }
      updHint()
    })
    $('updCheck').addEventListener('click', () => {
      try { window.gabbroDesktop.checkUpdates() } catch (e) { /* preload antigo */ }
    })
    $('updInstall').addEventListener('click', () => window.gabbroDesktop.installUpdate())
    window.gabbroDesktop.onUpdateStatus(applyUpdStatus)
  }
}

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
    ? `push pendente (${s.pushWarning.reason}): ${s.pushWarning.detail || ''} — ${s.pushWarning.fix || ''}`
    : (s.hasUpstream ? `${s.ahead} à frente · ${s.behind} atrás de ${s.upstream}` : 'sem upstream configurado')
  // uncommitted external changes on the tracked files (edited outside gabbro)
  const dirty = Array.isArray(s.dirty) && s.dirty.length
  const db = $('dirtyBanner')
  if (db) {
    db.classList.toggle('hidden', !dirty)
    if (dirty) db.textContent = `mudanças não commitadas no worktree: ${s.dirty.map(d => d.file || d).join(', ')} — salvar pelo Gabbro vai incluí-las no commit`
  }
}

async function refreshSyncBadge () {
  if (!isLocal()) return
  try {
    applySyncState(await api.getSyncState())
  } catch (e) { /* badge is best-effort */ }
}

let lastSyncAt = null
let syncInFlight = false

// Estratégia efetiva enviada ao servidor. 'ask' vai de 'safe' e, se divergir,
// pergunta (só em sync manual — o automático nunca abre prompt).
async function runSync (auto) {
  const pref = syncPrefs.strategy
  const first = pref === 'rebase' ? 'rebase' : 'safe'
  let r = await api.sync(first)
  if (!r.ok && r.reason === 'diverged' && pref === 'ask' && !auto) {
    const go = window.confirm('O remoto divergiu das suas mudanças.\n\nRebasear suas mudanças por cima do remoto? (Cancelar deixa tudo como está.)')
    if (go) r = await api.sync('rebase')
  }
  return r
}

async function doSync (opts) {
  opts = opts || {}
  if (syncInFlight) return
  syncInFlight = true
  const btn = $('btnSync')
  btn.disabled = true
  btn.classList.add('busy')
  try {
    const r = await runSync(!!opts.auto)
    applySyncState(r.syncState)
    if (!r.ok) {
      const msg = `sincronização falhou no ${r.step === 'pull' ? 'pull' : 'push'} (${r.reason}): ${r.fix || r.detail || ''}`
      toast(msg, opts.auto && r.reason === 'diverged' ? 'warn' : 'error')
      return
    }
    // pull may have rewritten the tracked files — reload everything visible,
    // MAS edição de DBML não salva (em qualquer branch) sobrevive ao reload
    const kept = await reloadModelsKeepDirty()
    state.branches = await api.getBranches()
    fillBranchSelects()
    if (!state.posDirty) {
      const p = await api.getPositions()
      if (p && p.tables) state.positions = { version: p.version || 1, tables: p.tables }
    }
    // branch atual suja: não sobrescrever o editor com o texto do disco
    if (!state.hist) await renderAll({ fitView: false, syncEditor: !kept.has(state.branch) })
    if (state.tab === 'history') hist.reload().catch(() => {})
    else hist.invalidate()
    lastSyncAt = Date.now()
    updateLastSyncLabel()
    if (kept.size) toast('sincronizado — sua edição de DBML não salva foi preservada no editor', 'warn')
    else if (!opts.quiet) toast('sincronizado com o remoto')
  } catch (e) { if (!opts.quiet) fail(e) } finally {
    syncInFlight = false
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
  if (window.gabbroDesktop) {
    $('repoBrowse').classList.remove('hidden')
    $('repoBrowse').addEventListener('click', async () => {
      const p = await window.gabbroDesktop.pickFolder()
      if (p) switchRepo(p)
    })
  }
}

// controles da janela frameless (barra de título) — só no Electron
function initWindowControls () {
  const d = window.gabbroDesktop
  if (!d || !d.win) return
  $('winCtrls').classList.remove('hidden')
  document.body.classList.add('is-desktop')
  $('winMin').addEventListener('click', () => d.win.minimize())
  $('winMax').addEventListener('click', () => d.win.maximize())
  $('winClose').addEventListener('click', () => d.win.close())
  const setMaxIcon = m => { $('winMax').innerHTML = m ? '&#10064;' : '&#9633;'; $('winMax').title = m ? 'Restaurar' : 'Maximizar' }
  d.win.isMaximized().then(setMaxIcon).catch(() => {})
  d.win.onMaximizeChange(setMaxIcon)
}

function initDesktopUpdates () {
  if (!window.gabbroDesktop) return
  window.gabbroDesktop.onUpdateStatus(s => {
    if (s.state === 'downloaded') {
      const b = $('updateBanner')
      b.classList.remove('hidden')
      $('updateBannerText').textContent = `Atualização ${s.version || ''} pronta`
    }
  })
  $('updateRestart').addEventListener('click', () => window.gabbroDesktop.installUpdate())
}

function setupLocalChrome () {
  $('btnSync').classList.remove('hidden')
  $('btnSync').addEventListener('click', doSync)
  // local: Sincronizar já cobre o pull — o ↻ separado só confundia (fica no hosted)
  $('btnRefresh').classList.add('hidden')
  initRepoSwitcher()
  initDesktopUpdates()
  refreshSyncBadge()
  setInterval(refreshSyncBadge, 60000)
}

// Tells the Electron main process the renderer is usable → closes the splash.
function signalDesktopReady () {
  try {
    if (window.gabbroDesktop && window.gabbroDesktop.signalReady) window.gabbroDesktop.signalReady()
  } catch (e) { /* browser mode — no desktop bridge */ }
}

async function openFirstRepo (p) {
  try {
    await api.putRepo(p)
    location.reload() // full boot with the repo configured
  } catch (e) { fail(e) }
}

// Unconfigured boot (desktop, no saved repo): in-app chooser instead of a
// blocking native dialog. The choice persists in ~/.gabbro/settings.json.
function showWelcome (info) {
  document.body.classList.add('welcome-on')
  $('welcome').classList.remove('hidden')
  const list = $('wlRecents')
  list.innerHTML = ''
  const recents = (info.recents || []).filter(x => typeof x === 'string')
  for (const rp of recents) {
    const it = document.createElement('button')
    it.className = 'rm-item'
    it.textContent = rp
    it.title = rp
    it.addEventListener('click', () => openFirstRepo(rp))
    list.appendChild(it)
  }
  $('wlNoRecents').classList.toggle('hidden', recents.length > 0)
  if (window.gabbroDesktop) {
    $('wlBrowse').classList.remove('hidden')
    $('wlBrowse').addEventListener('click', async () => {
      const p = await window.gabbroDesktop.pickFolder()
      if (p) openFirstRepo(p)
    })
  }
  $('wlOpen').addEventListener('click', () => {
    const p = $('wlPath').value.trim()
    if (p) openFirstRepo(p)
  })
  $('wlPath').addEventListener('keydown', e => { if (e.key === 'Enter') $('wlOpen').click() })
  $('wlPath').focus()
}

function handleHash () {
  if (location.hash.startsWith('#tbl-')) {
    const name = decodeURIComponent(location.hash.slice(5))
    if (state.tab !== 'docs') setTab('docs')
    scrollToTable(name)
  }
}

async function boot () {
  diagram.initDiagram({ parse: parseDBML })
  initDocs()
  initSettingsUi()
  initWindowControls() // barra de título frameless (Electron)
  enhanceSelects() // dropdowns custom no tema do app (todos os <select>)
  hist.initHistory({ onOpenCommit: openHistoryCommit, onExit: exitHistory, fail })
  $('histExit').addEventListener('click', exitHistory)
  $('histExitBtn').addEventListener('click', exitHistory)
  $('histSideMore').addEventListener('click', () => loadHistViewPage().catch(fail))
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('hist-mode')) exitHistory()
  })

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
  $('btnDiff').addEventListener('click', openDiffModal)
  $('diffModalClose').addEventListener('click', closeDiffModal)
  $('diffCancel').addEventListener('click', closeDiffModal)
  $('diffGo').addEventListener('click', confirmDiff)
  $('diffBase').addEventListener('change', refreshDiffGo)
  $('diffTarget').addEventListener('change', refreshDiffGo)
  $('diffModal').addEventListener('mousedown', e => { if (e.target === $('diffModal')) closeDiffModal() })
  $('btnDiffDim').addEventListener('click', () => {
    diffDim = !diffDim
    $('btnDiffDim').classList.toggle('on', diffDim)
    diagram.setDiffDim(state.diffOn && diffDim)
  })
  $('btnDiffText').addEventListener('click', () => {
    if (diffPaneOpen) {
      diffPaneOpen = false
      $('diffPane').classList.add('hidden')
      $('btnDiffText').classList.remove('on')
    } else openDiffText()
  })
  const setDpMode = m => {
    dpMode = m
    $('dpUnified').classList.toggle('on', m === 'unified')
    $('dpSplit').classList.toggle('on', m === 'split')
    try { localStorage.setItem('gabbro:diff-text-mode', m) } catch (e) { /* storage cheio */ }
    paintDiffText()
  }
  setDpMode(localStorage.getItem('gabbro:diff-text-mode') === 'unified' ? 'unified' : 'split') // padrão lado a lado
  $('dpUnified').addEventListener('click', () => setDpMode('unified'))
  $('dpSplit').addEventListener('click', () => setDpMode('split'))
  $('dpClose').addEventListener('click', () => {
    diffPaneOpen = false
    $('diffPane').classList.add('hidden')
    $('btnDiffText').classList.remove('on')
  })
  $('modeView').addEventListener('click', () => { state.mode = 'view'; updateChrome() })
  $('modeEdit').addEventListener('click', () => {
    if (state.diffOn || state.hist || !state.config || state.config.readOnly) return
    state.mode = 'edit'
    if (state.tab === 'docs') setTab('diagram') // edição é diagrama + editor; doc é leitura
    const entry = state.models.get(state.branch)
    if (entry) diagram.setEditorText(entry.text)
    updateChrome()
  })
  $('btnSave').addEventListener('click', saveAll)
  const searchUi = r => {
    const has = r && r.total > 0
    $('searchCount').textContent = has ? `${r.idx + 1}/${r.total}` : ($('search').value.trim() ? '0' : '')
    $('searchCount').classList.toggle('hidden', !$('search').value.trim())
    $('searchPrev').classList.toggle('hidden', !has || r.total < 2)
    $('searchNext').classList.toggle('hidden', !has || r.total < 2)
  }
  // busca recolhida (lupa) → expande ao clicar/Ctrl+F; recolhe vazia (blur/Esc)
  const sw = $('searchWrap')
  const scope = () => $('searchScope').value
  const openSearch = () => { sw.classList.add('open'); $('search').focus() }
  const collapseSearch = () => { if (!$('search').value.trim()) sw.classList.remove('open') }
  $('searchBtn').addEventListener('click', () => {
    if (sw.classList.contains('open')) collapseSearch(); else openSearch()
  })
  sw.addEventListener('focusout', () => setTimeout(() => {
    if (!sw.contains(document.activeElement)) collapseSearch()
  }, 120))
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.tab === 'diagram') {
      e.preventDefault(); openSearch(); $('search').select()
    }
  })
  $('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      let r = diagram.searchStep(e.shiftKey ? -1 : 1)
      if (!r.total) r = diagram.searchTable(e.target.value, scope())
      searchUi(r)
    } else if (e.key === 'Escape') {
      if (!e.target.value) { e.target.blur(); sw.classList.remove('open'); return }
      e.target.value = ''; diagram.searchTable(''); searchUi(null)
    }
  })
  $('search').addEventListener('input', e => searchUi(diagram.searchTable(e.target.value, scope())))
  $('searchScope').addEventListener('change', () => searchUi(diagram.searchTable($('search').value, scope())))
  $('searchPrev').addEventListener('click', () => searchUi(diagram.searchStep(-1)))
  $('searchNext').addEventListener('click', () => searchUi(diagram.searchStep(1)))
  window.addEventListener('hashchange', handleHash)

  try {
    const repoInfo = await api.getRepo()
    if (repoInfo.mode === 'local' && repoInfo.configured === false) {
      showWelcome(repoInfo)
      return
    }
    state.config = await api.getConfig()
    state.currentBranch = state.config.currentBranch
    document.title = `Gabbro — ${state.config.repoName}`
    $('repoName').textContent = state.config.repoName
    if (isLocal()) setupLocalChrome()
    state.branches = await api.getBranches()
    if (!state.branches.length) { toast('o repositório ainda não tem branches', 'error'); return }

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

boot().finally(signalDesktopReady)
