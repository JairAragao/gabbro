import { headerStyle, groupStyle, orthPath, getPositions, colMarks, routeOrthoEdges } from './diagram.js'

const $ = id => document.getElementById(id)
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

const UNGROUPED = 'Sem grupo'

let model = null, diff = null, refBy = {}
// filtro ativo do modo doc: null (tudo) | {type:'group', name} | {type:'table', name}
let filter = null

export function initDocs () {
  $('docsSearch').addEventListener('input', e => filterIndex(e.target.value))
  $('docsSearch').addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return
    const first = $('docsIndex').querySelector('.doc-idx-item:not(.hidden)')
    if (first) setFilter({ type: 'table', name: first.dataset.table })
  })
}

function filterIndex (q) {
  q = q.trim().toLowerCase()
  for (const item of $('docsIndex').querySelectorAll('.doc-idx-item')) {
    item.classList.toggle('hidden', !!q && !item.dataset.table.toLowerCase().includes(q))
  }
  for (const sec of $('docsIndex').querySelectorAll('.doc-idx-group')) {
    const any = [...sec.querySelectorAll('.doc-idx-item')].some(i => !i.classList.contains('hidden'))
    sec.classList.toggle('hidden', !any)
    // a busca sobrepõe o estado colapsado — matches sempre visíveis
    sec.classList.toggle('search-open', !!q && any)
  }
}

export function scrollToTable (name) {
  if (!model || !model.tables[name]) return
  // com filtro ativo, navegar para uma tabela re-filtra para ela (senão o alvo
  // pode nem estar renderizado)
  if (filter) { setFilter({ type: 'table', name }); return }
  const el = document.getElementById('tbl-' + name)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function setFilter (f) {
  filter = f
  renderIndex()
  renderContent()
  filterIndex($('docsSearch').value || '')
  $('docsContent').scrollTop = 0
}

function groupNames (g) { return g.tables.filter(t => model.tables[t]) }
function ungroupedNames () {
  const grouped = new Set()
  for (const g of model.groups) groupNames(g).forEach(n => grouped.add(n))
  return model.order.filter(t => !grouped.has(t))
}
// Grupos são endereçados por CHAVE ('g:<índice>' ou '__ungrouped__'), nunca por
// nome — nomes duplicados e um TableGroup real chamado "Sem grupo" não colidem.
function findGroup (key) {
  if (key === '__ungrouped__') return { name: UNGROUPED, color: '#5b6577', tables: ungroupedNames() }
  const m = /^g:(\d+)$/.exec(key || '')
  if (!m) return null
  const g = model.groups[Number(m[1])]
  return g ? { name: g.name, color: g.color, tables: groupNames(g) } : null
}

// filtro pode apontar pra algo que sumiu (ou trocou de lugar) após troca de branch/edição
function validateFilter () {
  if (!filter) return
  if (filter.type === 'table' && !model.tables[filter.name]) filter = null
  if (filter.type === 'group') {
    const g = findGroup(filter.key)
    if (!g || g.name !== filter.name) filter = null
  }
}

function tableStatus (name) {
  if (!diff) return null
  const d = diff.tables[name]
  return d && d.status !== 'same' ? d.status : null
}
function colStatus (name, col) {
  if (!diff) return null
  if (col._removed) return { status: 'removed', changes: [] }
  const d = diff.tables[name]; if (!d) return null
  const dc = d.columns[col.name]
  return dc && dc.status !== 'same' ? dc : null
}
const STATUS_LABEL = { added: 'ADICIONADA', removed: 'REMOVIDA', modified: 'ALTERADA' }

export function renderDocs (m, diffResult) {
  model = m; diff = diffResult || null
  refBy = {}
  for (const nm of model.order) {
    for (const c of model.tables[nm].columns) {
      if (c.fk) (refBy[c.fk.table] || (refBy[c.fk.table] = [])).push({ from: nm, fromCol: c.name, toCol: c.fk.col, removed: !!c._removed })
    }
  }
  validateFilter()
  renderIndex()
  renderContent()
  filterIndex($('docsSearch').value || '')
}

function renderIndex () {
  const nav = $('docsIndex'); nav.innerHTML = ''
  const addGroup = (title, color, names, key) => {
    if (!names.length) return
    const groupActive = filter && filter.type === 'group' && filter.key === key
    const sec = document.createElement('div')
    sec.className = 'doc-idx-group' + (groupActive || (filter && filter.type === 'table' && names.includes(filter.name)) ? '' : ' collapsed')
    const gs = groupStyle(color)
    sec.innerHTML = `<div class="doc-idx-head${groupActive ? ' on' : ''}" title="Clique para ver s&oacute; as tabelas deste grupo">` +
      `<span class="doc-idx-chev">▸</span><span class="doc-idx-dot" style="background:${gs.labelBg}"></span>` +
      `<span class="doc-idx-name">${esc(title)}</span><span class="doc-idx-count">${names.length}</span></div>`
    const head = sec.firstChild
    head.querySelector('.doc-idx-chev').addEventListener('click', e => {
      e.stopPropagation()
      sec.classList.toggle('collapsed')
    })
    head.addEventListener('click', () => {
      if (filter && filter.type === 'group' && filter.key === key) setFilter(null)
      else setFilter({ type: 'group', key, name: title })
    })
    for (const nm of names) {
      const a = document.createElement('a')
      a.className = 'doc-idx-item' + (filter && filter.type === 'table' && filter.name === nm ? ' on' : '')
      a.dataset.table = nm; a.href = '#tbl-' + encodeURIComponent(nm)
      const st = tableStatus(nm)
      a.innerHTML = esc(nm) + (st ? ` <span class="diff-tag ${st}">${STATUS_LABEL[st]}</span>` : '')
      a.addEventListener('click', e => {
        e.preventDefault()
        if (filter && filter.type === 'table' && filter.name === nm) setFilter(null)
        else setFilter({ type: 'table', name: nm })
      })
      sec.appendChild(a)
    }
    nav.appendChild(sec)
  }
  model.groups.forEach((g, i) => addGroup(g.name, g.color, groupNames(g), `g:${i}`))
  addGroup(UNGROUPED, '#5b6577', ungroupedNames(), '__ungrouped__')
}

function badge (cls, label, title) { return `<span class="badge ${cls}" title="${esc(title)}">${label}</span>` }

function visibleOrder () {
  if (!filter) return model.order
  if (filter.type === 'table') return model.order.filter(t => t === filter.name)
  const g = findGroup(filter.key)
  const set = new Set(g ? g.tables : [])
  return model.order.filter(t => set.has(t))
}

function buildFilterBar () {
  const bar = document.createElement('div')
  bar.className = 'doc-filter-bar'
  const label = filter.type === 'group'
    ? `Grupo: <strong>${esc(filter.name)}</strong> <span class="doc-muted">(${visibleOrder().length} tabela${visibleOrder().length === 1 ? '' : 's'})</span>`
    : `Tabela: <strong>${esc(filter.name)}</strong>`
  bar.innerHTML = `<span>${label}</span>`
  const btn = document.createElement('button')
  btn.className = 'btn sm'
  btn.textContent = '✕ Limpar filtro'
  btn.addEventListener('click', () => setFilter(null))
  bar.appendChild(btn)
  return bar
}

function renderContent () {
  const wrap = $('docsContent'); wrap.innerHTML = ''

  if (filter) wrap.appendChild(buildFilterBar())
  if (diff && !filter) wrap.appendChild(buildDiffSummary())

  const grouped = new Map()
  for (const g of model.groups) for (const t of g.tables) if (model.tables[t] && !grouped.has(t)) grouped.set(t, g)

  for (const nm of visibleOrder()) {
    const t = model.tables[nm]
    const st = tableStatus(nm)
    const sec = document.createElement('section')
    sec.className = 'doc-tbl' + (st ? ' diff-' + st : '')
    sec.id = 'tbl-' + nm
    const hs = headerStyle(t.color)
    const g = grouped.get(nm)

    let html = `<header style="background:${hs.bg};color:${hs.fg}"><h2>${esc(nm)}</h2>`
    if (st) html += `<span class="diff-tag ${st}">${STATUS_LABEL[st]}</span>`
    if (g) html += `<span class="doc-grp">${esc(g.name)}</span>`
    html += '</header>'
    if (t.note) html += `<p class="doc-note">${esc(t.note)}</p>`

    html += '<table class="doc-cols"><thead><tr><th>Atributos</th><th>Coluna</th><th>Tipo</th><th>Padr&atilde;o</th><th>Coment&aacute;rio</th></tr></thead><tbody>'
    for (const c of t.columns) {
      const cs = colStatus(nm, c)
      const cls = cs && (!st || st === 'modified') ? ' class="diff-' + cs.status + '"' : ''
      let attrs = ''
      if (c.pk) attrs += badge('pk', 'PK', 'Chave primária')
      if (c.fk) attrs += `<a class="badge fk" href="#tbl-${encodeURIComponent(c.fk.table)}" title="Referencia ${esc(c.fk.table)}.${esc(c.fk.col)}">FK</a>`
      if (c.notnull) attrs += badge('nn', 'NN', 'Não nulo')
      if (c.unique) attrs += badge('uq', 'UQ', 'Único')
      if (c.increment) attrs += badge('ai', 'AUTO', 'Auto incremento (serial/sequence)')
      let typeCell = esc(c.type)
      let nameCell = esc(c.name)
      if (cs && cs.status === 'modified') {
        const chDesc = cs.changes.map(ch => `${ch.field}: ${ch.from == null ? '—' : ch.from} → ${ch.to == null ? '—' : ch.to}`).join('; ')
        nameCell += ` <span class="diff-changes" title="${esc(chDesc)}">${esc(chDesc)}</span>`
      }
      if (c.fk) typeCell += ` <span class="doc-fkref">→ <a href="#tbl-${encodeURIComponent(c.fk.table)}">${esc(c.fk.table)}.${esc(c.fk.col)}</a></span>`
      html += `<tr${cls}><td class="c-attrs">${attrs}</td><td class="c-name">${nameCell}</td><td class="c-type">${typeCell}</td>` +
        `<td class="c-def">${c.default != null ? esc(c.default) : ''}</td>` +
        `<td class="c-comment">${c.note ? esc(c.note) : ''}</td></tr>`
    }
    html += '</tbody></table>'

    // índices e referências em painéis próprios, separados da tabela de colunas
    const composite = (t.indexes || []).filter(ix => ix.cols.length > 1)
    const refsOut = t.columns.filter(c => c.fk)
    const refsIn = refBy[nm] || []
    if (composite.length || refsOut.length || refsIn.length) {
      html += '<div class="doc-extra">'
      if (composite.length) {
        html += `<div class="doc-panel"><div class="doc-panel-title">&Iacute;ndices compostos<span class="doc-count">${composite.length}</span></div><div class="doc-panel-body">`
        for (const ix of composite) {
          html += `<div class="ref-item"><code>(${ix.cols.map(esc).join(', ')})</code>` +
            `${ix.unique ? '<span class="badge uq">UQ</span>' : ''}` +
            `${ix.name ? `<span class="doc-muted">${esc(ix.name)}</span>` : ''}</div>`
        }
        html += '</div></div>'
      }
      if (refsOut.length) {
        html += `<div class="doc-panel"><div class="doc-panel-title"><span class="ref-dir out">&rarr;</span>Referencia<span class="doc-count">${refsOut.length}</span></div><div class="doc-panel-body">`
        for (const c of refsOut) {
          html += `<div class="ref-item${c._removed ? ' diff-removed' : ''}"><code>${esc(c.name)}</code>` +
            `<span class="ref-arrow">&rarr;</span>` +
            `<a class="ref-tbl" href="#tbl-${encodeURIComponent(c.fk.table)}">${esc(c.fk.table)}</a>` +
            `<code class="ref-col">${esc(c.fk.col)}</code></div>`
        }
        html += '</div></div>'
      }
      if (refsIn.length) {
        html += `<div class="doc-panel"><div class="doc-panel-title"><span class="ref-dir in">&larr;</span>Referenciada por<span class="doc-count">${refsIn.length}</span></div><div class="doc-panel-body">`
        for (const r of refsIn) {
          html += `<div class="ref-item${r.removed ? ' diff-removed' : ''}">` +
            `<a class="ref-tbl" href="#tbl-${encodeURIComponent(r.from)}">${esc(r.from)}</a>` +
            `<code class="ref-col">${esc(r.fromCol)}</code>` +
            `<span class="ref-arrow">&rarr;</span><code>${esc(r.toCol)}</code></div>`
        }
        html += '</div></div>'
      }
      html += '</div>'
    }

    sec.innerHTML = html
    wrap.appendChild(sec)
  }

  // links internos (#tbl-x) dentro do conteúdo respeitam o filtro ativo
  wrap.querySelectorAll('a[href^="#tbl-"]').forEach(a => {
    a.addEventListener('click', e => {
      if (!filter) return
      e.preventDefault()
      const name = decodeURIComponent(a.getAttribute('href').slice(5))
      if (model.tables[name]) setFilter({ type: 'table', name })
    })
  })

  if (filter && filter.type === 'table') wrap.appendChild(buildMiniDiagram(filter.name))
}

/* ---------- mini-diagrama de relacionamentos (filtro por tabela) ---------- */

const MINI_W = 250, MINI_HD = 30, MINI_ROW = 22, MINI_GAPY = 16
const MINI_MODE_KEY = 'gabbro:mini-mode' // 'full' (tabelas inteiras) | 'linked' (só colunas do vínculo)

function miniMode () {
  try { return localStorage.getItem(MINI_MODE_KEY) === 'linked' ? 'linked' : 'full' } catch (e) { return 'full' }
}

function miniCard (nm, cols, focal, x, y) {
  const t = model.tables[nm]
  const hs = headerStyle(t.color)
  const el = document.createElement('div')
  el.className = 'mini-tbl' + (focal ? ' focal' : '')
  el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.width = MINI_W + 'px'
  let html = `<div class="mini-hd" style="background:${hs.bg};color:${hs.fg}">${esc(nm)}</div>`
  for (const c of cols) {
    const mk = colMarks(c)
    html += `<div class="mini-col"><span class="cmark ${mk.cls}">${mk.text}</span>` +
      `<span class="mini-cname${c.pk ? ' pk' : ''}">${esc(c.name)}</span>` +
      `<span class="mini-ctype">${esc(c.type)}</span>` +
      (c.notnull ? '<span class="badge nn">NN</span>' : '') + '</div>'
  }
  el.innerHTML = html
  if (!focal) {
    el.classList.add('clickable')
    el.title = 'Ver documentação de ' + nm
    el.addEventListener('click', () => setFilter({ type: 'table', name: nm }))
  }
  return el
}

function buildMiniDiagram (name) {
  const box = document.createElement('section')
  box.className = 'doc-mini'
  const mode = miniMode()
  const head = document.createElement('div')
  head.className = 'mini-head'
  head.innerHTML = '<h3>Relacionamentos</h3>' +
    `<div class="mini-toggle">` +
    `<button data-m="full" class="${mode === 'full' ? 'on' : ''}">Tabelas inteiras</button>` +
    `<button data-m="linked" class="${mode === 'linked' ? 'on' : ''}">S&oacute; v&iacute;nculos</button></div>`
  head.querySelectorAll('.mini-toggle button').forEach(b => b.addEventListener('click', () => {
    try { localStorage.setItem(MINI_MODE_KEY, b.dataset.m) } catch (e) { /* storage cheio */ }
    box.replaceWith(buildMiniDiagram(name)) // troca in-place, sem resetar o scroll da página
  }))
  box.appendChild(head)

  const t = model.tables[name]
  const outs = t.columns.filter(c => c.fk && model.tables[c.fk.table] && c.fk.table !== name)
  const ins = (refBy[name] || []).filter(r => r.from !== name && model.tables[r.from])
  const selfRefs = t.columns.filter(c => c.fk && c.fk.table === name)

  if (!outs.length && !ins.length && !selfRefs.length) {
    const p = document.createElement('p')
    p.className = 'doc-muted'; p.style.padding = '0 16px 14px'
    p.textContent = 'Esta tabela não tem relacionamentos.'
    box.appendChild(p)
    return box
  }

  // colunas exibidas: tabela inteira ou só as envolvidas nos vínculos com a focal
  const colsFor = nm => {
    const tt = model.tables[nm]
    if (mode === 'full') return tt.columns
    const involved = new Set()
    if (nm === name) {
      outs.forEach(c => involved.add(c.name))
      ins.forEach(r => involved.add(r.toCol))
      selfRefs.forEach(c => { involved.add(c.name); involved.add(c.fk.col) })
    } else {
      outs.forEach(c => { if (c.fk.table === nm) involved.add(c.fk.col) })
      ins.forEach(r => { if (r.from === nm) involved.add(r.fromCol) })
    }
    return tt.columns.filter(c => involved.has(c.name))
  }

  // layout espelha o diagrama principal: agrupa em colunas pelo x de lá,
  // preserva a ordem vertical (y) e elimina os espaços vazios
  const mainPos = getPositions()
  const relNames = [...new Set([...outs.map(c => c.fk.table), ...ins.map(r => r.from)])].filter(n => n !== name)
  const items = [name, ...relNames].map(nm => {
    const p = mainPos[nm]
    return {
      nm,
      cols: colsFor(nm),
      px: p ? p.x : Number.MAX_SAFE_INTEGER,
      py: p ? p.y : 0,
      h: 0, x: 0, y: 0
    }
  })
  items.forEach(it => { it.h = MINI_HD + it.cols.length * MINI_ROW })
  const byName = new Map(items.map(it => [it.nm, it]))

  items.sort((a, b) => a.px - b.px)
  const COL_CLUSTER = 200 // tabelas a menos de ~1 largura de distância = mesma coluna
  const columns = []
  for (const it of items) {
    const last = columns[columns.length - 1]
    if (last && it.px - last.anchor < COL_CLUSTER) last.items.push(it)
    else columns.push({ anchor: it.px, items: [it] })
  }
  for (const col of columns) {
    col.items.sort((a, b) => a.py - b.py)
    let y = 0
    for (const it of col.items) { it.y = y; y += it.h + MINI_GAPY }
    col.h = y - MINI_GAPY
  }

  // distribui as colunas na largura disponível (docsContent oculto/estreito —
  // render fora da aba Docs — clientWidth vira 0 e o cálculo daria negativo)
  const contentEl = $('docsContent')
  const cw = contentEl ? contentEl.clientWidth : 0
  const availRaw = cw > 300 ? cw - 52 - 34 : 1100
  const availW = Math.max(columns.length * MINI_W + (columns.length - 1) * 60, availRaw)
  const gap = columns.length > 1
    ? Math.min(160, Math.max(60, (availW - columns.length * MINI_W) / (columns.length - 1)))
    : 0
  const totalW = columns.length * MINI_W + (columns.length - 1) * gap
  const startX = Math.max(0, Math.round((availW - totalW) / 2))
  columns.forEach((col, i) => {
    const x = startX + i * (MINI_W + gap)
    col.items.forEach(it => { it.x = x })
  })
  const totalH = Math.max(...columns.map(c => c.h)) + 20
  // colunas mais baixas centralizam na vertical
  for (const col of columns) {
    const off = Math.max(0, (totalH - 20 - col.h) / 2)
    col.items.forEach(it => { it.y += off })
  }

  // aresta same-column contorna pela direita (+28) — o canvas/SVG precisa
  // dessa folga, senão o desvio é clipado quando o par cai na última coluna
  const colIdx = new Map()
  columns.forEach((col, i) => col.items.forEach(it => colIdx.set(it.nm, i)))
  const hasSameColEdge =
    outs.some(c => colIdx.get(name) === colIdx.get(c.fk.table)) ||
    ins.some(r => colIdx.get(r.from) === colIdx.get(name))
  const canvasW = Math.max(availW, totalW) + (hasSameColEdge ? 34 : 2)

  const canvas = document.createElement('div')
  canvas.className = 'mini-canvas'
  canvas.style.height = totalH + 'px'
  canvas.style.width = canvasW + 'px'

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', canvasW)
  svg.setAttribute('height', totalH)
  canvas.appendChild(svg)

  const rowY = (it, colName) => {
    const i = it.cols.findIndex(c => c.name === colName)
    return it.y + MINI_HD + (i < 0 ? MINI_HD / 2 : i * MINI_ROW + MINI_ROW / 2)
  }
  const dot = (cx, cy) => {
    const d = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    d.setAttribute('cx', cx); d.setAttribute('cy', cy); d.setAttribute('r', 3)
    d.setAttribute('class', 'mini-dot')
    svg.appendChild(d)
  }

  const focalIt = byName.get(name)
  for (const it of items) canvas.appendChild(miniCard(it.nm, it.cols, it === focalIt, it.x, it.y))

  // arestas 90° com o MESMO roteador A* do diagrama principal: menor rota
  // ortogonal que nunca passa por trás de um card
  const specs = []
  const addSpec = (src, srcCol, tgt, tgtCol) => {
    const sy = rowY(src, srcCol), ty = rowY(tgt, tgtCol)
    let aSide, bSide
    if (tgt.x >= src.x + MINI_W) { aSide = 'r'; bSide = 'l' } else if (src.x >= tgt.x + MINI_W) { aSide = 'l'; bSide = 'r' } else { aSide = 'r'; bSide = 'r' }
    specs.push({
      a: { x: aSide === 'r' ? src.x + MINI_W : src.x, y: sy, side: aSide },
      b: { x: bSide === 'r' ? tgt.x + MINI_W : tgt.x, y: ty, side: bSide }
    })
  }
  for (const c of outs) {
    const target = byName.get(c.fk.table)
    if (target) addSpec(focalIt, c.name, target, c.fk.col)
  }
  for (const r of ins) {
    const src = byName.get(r.from)
    if (src) addSpec(src, r.fromCol, focalIt, r.toCol)
  }
  const routes = routeOrthoEdges(items.map(it => ({ x: it.x, y: it.y, w: MINI_W, h: it.h })), specs)
  for (const pts of routes) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', orthPath(pts))
    p.setAttribute('class', 'mini-edge')
    svg.appendChild(p)
    dot(pts[0].x, pts[0].y)
    dot(pts[pts.length - 1].x, pts[pts.length - 1].y)
  }

  const scroller = document.createElement('div')
  scroller.className = 'mini-scroll'
  scroller.appendChild(canvas)
  box.appendChild(scroller)

  if (selfRefs.length) {
    const p = document.createElement('p')
    p.className = 'doc-muted'; p.style.padding = '6px 16px 12px'
    p.textContent = 'Auto-relacionamento: ' + selfRefs.map(c => `${c.name} → ${name}.${c.fk.col}`).join(', ')
    box.appendChild(p)
  }
  return box
}

function buildDiffSummary () {
  const s = { added: [], removed: [], modified: [] }
  for (const [nm, t] of Object.entries(diff.tables)) if (t.status !== 'same') s[t.status].push(nm)
  s.added.sort(); s.removed.sort(); s.modified.sort()
  const panel = document.createElement('section')
  panel.className = 'doc-diff-summary'
  const block = (status, names) => {
    if (!names.length) return ''
    return `<div class="dds-block"><span class="diff-tag ${status}">${STATUS_LABEL[status]} ${names.length}</span> ` +
      names.map(nm => `<a href="#tbl-${encodeURIComponent(nm)}">${esc(nm)}</a>`).join(', ') + '</div>'
  }
  const total = s.added.length + s.removed.length + s.modified.length
  panel.innerHTML = `<h2>Resumo do diff — ${total} tabela${total === 1 ? '' : 's'} alterada${total === 1 ? '' : 's'}</h2>` +
    (total ? block('added', s.added) + block('modified', s.modified) + block('removed', s.removed)
      : '<p class="doc-muted">Sem diferenças estruturais.</p>')
  return panel
}
