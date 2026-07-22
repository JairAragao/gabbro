// Docs tab: sidebar index by TableGroup + searchable, one section per table
// with columns, indexes, FK cross-references, and diff decorations.

import { headerStyle, groupStyle } from './diagram.js'

const $ = id => document.getElementById(id)
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

let model = null, diff = null

export function initDocs () {
  $('docsSearch').addEventListener('input', e => filterIndex(e.target.value))
  $('docsSearch').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return
    const first = $('docsIndex').querySelector('.doc-idx-item:not(.hidden)')
    if (first) scrollToTable(first.dataset.table)
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
    // searching overrides the collapsed state so matches are always visible
    sec.classList.toggle('search-open', !!q && any)
  }
}

export function scrollToTable (name) {
  const el = document.getElementById('tbl-' + name)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
const STATUS_LABEL = { added: 'ADDED', removed: 'REMOVED', modified: 'CHANGED' }

export function renderDocs (m, diffResult) {
  model = m; diff = diffResult || null
  renderIndex()
  renderContent()
  filterIndex($('docsSearch').value || '')
}

function renderIndex () {
  const nav = $('docsIndex'); nav.innerHTML = ''
  const grouped = new Set()
  const addGroup = (title, color, names) => {
    if (!names.length) return
    const sec = document.createElement('div'); sec.className = 'doc-idx-group collapsed'
    const gs = groupStyle(color)
    sec.innerHTML = `<div class="doc-idx-head"><span class="doc-idx-chev">▸</span><span class="doc-idx-dot" style="background:${gs.labelBg}"></span>${esc(title)}<span class="doc-idx-count">${names.length}</span></div>`
    sec.firstChild.addEventListener('click', () => sec.classList.toggle('collapsed'))
    for (const nm of names) {
      const a = document.createElement('a')
      a.className = 'doc-idx-item'; a.dataset.table = nm; a.href = '#tbl-' + encodeURIComponent(nm)
      const st = tableStatus(nm)
      a.innerHTML = esc(nm) + (st ? ` <span class="diff-tag ${st}">${STATUS_LABEL[st]}</span>` : '')
      sec.appendChild(a)
    }
    nav.appendChild(sec)
  }
  for (const g of model.groups) {
    const names = g.tables.filter(t => model.tables[t])
    names.forEach(n => grouped.add(n))
    addGroup(g.name, g.color, names)
  }
  addGroup('Ungrouped', '#5b6577', model.order.filter(t => !grouped.has(t)))
}

function badge (cls, label, title) { return `<span class="badge ${cls}" title="${esc(title)}">${label}</span>` }

function renderContent () {
  const wrap = $('docsContent'); wrap.innerHTML = ''

  if (diff) wrap.appendChild(buildDiffSummary())

  // reverse FK index, computed once
  const refBy = {}
  for (const nm of model.order) {
    for (const c of model.tables[nm].columns) {
      if (c.fk) (refBy[c.fk.table] || (refBy[c.fk.table] = [])).push({ from: nm, fromCol: c.name, toCol: c.fk.col, removed: !!c._removed })
    }
  }

  const grouped = new Map()
  for (const g of model.groups) for (const t of g.tables) if (model.tables[t] && !grouped.has(t)) grouped.set(t, g)

  for (const nm of model.order) {
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

    html += '<table class="doc-cols"><thead><tr><th>Column</th><th>Type</th><th>Attributes</th><th>Default</th></tr></thead><tbody>'
    for (const c of t.columns) {
      const cs = colStatus(nm, c)
      const cls = cs && (!st || st === 'modified') ? ' class="diff-' + cs.status + '"' : ''
      let attrs = ''
      if (c.pk) attrs += badge('pk', 'PK', 'Primary key')
      if (c.fk) attrs += `<a class="badge fk" href="#tbl-${encodeURIComponent(c.fk.table)}" title="References ${esc(c.fk.table)}.${esc(c.fk.col)}">FK</a>`
      if (c.notnull) attrs += badge('nn', 'NN', 'Not null')
      if (c.unique) attrs += badge('uq', 'UQ', 'Unique')
      if (c.increment) attrs += badge('ai', 'AUTO', 'Auto increment (serial/sequence)')
      let typeCell = esc(c.type)
      let nameCell = esc(c.name)
      if (cs && cs.status === 'modified') {
        const chDesc = cs.changes.map(ch => `${ch.field}: ${ch.from == null ? '—' : ch.from} → ${ch.to == null ? '—' : ch.to}`).join('; ')
        nameCell += ` <span class="diff-changes" title="${esc(chDesc)}">${esc(chDesc)}</span>`
      }
      if (c.fk) typeCell += ` <span class="doc-fkref">→ <a href="#tbl-${encodeURIComponent(c.fk.table)}">${esc(c.fk.table)}.${esc(c.fk.col)}</a></span>`
      if (c.note) nameCell += `<div class="c-note">${esc(c.note)}</div>`
      html += `<tr${cls}><td class="c-name">${nameCell}</td><td class="c-type">${typeCell}</td><td class="c-attrs">${attrs}</td><td class="c-def">${c.default != null ? esc(c.default) : ''}</td></tr>`
    }
    html += '</tbody></table>'

    const composite = (t.indexes || []).filter(ix => ix.cols.length > 1)
    if (composite.length) {
      html += '<div class="doc-sub">Indexes</div><ul class="doc-list">'
      for (const ix of composite) {
        html += `<li><code>(${ix.cols.map(esc).join(', ')})</code>${ix.unique ? ' <span class="badge uq">UQ</span>' : ''}${ix.name ? ` <span class="doc-muted">${esc(ix.name)}</span>` : ''}</li>`
      }
      html += '</ul>'
    }

    const refsOut = t.columns.filter(c => c.fk)
    if (refsOut.length) {
      html += '<div class="doc-sub">References →</div><ul class="doc-list">'
      for (const c of refsOut) {
        html += `<li${c._removed ? ' class="diff-removed"' : ''}><code>${esc(c.name)}</code> → <a href="#tbl-${encodeURIComponent(c.fk.table)}">${esc(c.fk.table)}</a>.<code>${esc(c.fk.col)}</code></li>`
      }
      html += '</ul>'
    }
    const refsIn = refBy[nm] || []
    if (refsIn.length) {
      html += '<div class="doc-sub">Referenced by ←</div><ul class="doc-list">'
      for (const r of refsIn) {
        html += `<li${r.removed ? ' class="diff-removed"' : ''}><a href="#tbl-${encodeURIComponent(r.from)}">${esc(r.from)}</a>.<code>${esc(r.fromCol)}</code> → <code>${esc(r.toCol)}</code></li>`
      }
      html += '</ul>'
    }

    sec.innerHTML = html
    wrap.appendChild(sec)
  }
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
  panel.innerHTML = `<h2>Diff summary — ${total} table${total === 1 ? '' : 's'} changed</h2>` +
    (total ? block('added', s.added) + block('modified', s.modified) + block('removed', s.removed)
      : '<p class="doc-muted">No structural differences.</p>')
  return panel
}
