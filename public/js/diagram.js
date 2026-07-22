// Diagram: layout, render, edges (orthogonal A* routing), pan/zoom, drag,
// hover focus, side editor with cached highlighting, color palette.
// Ported from the original dbml-viewer and modularized: positions are injected
// (API is the source of truth), diff decorations are driven by a diffResult.

const TABLE_W = 248, HEADER_H = 34, ROW_H = 24, GAP = 34, GRP_PAD = 26, ROUTE_M = 14
const SVGNS = 'http://www.w3.org/2000/svg'
const $ = id => document.getElementById(id)

let viewport, world, svg, tip
let model = null, positions = {}, tableEls = {}, edges = [], edgesByTable = {}, diff = null
let hoverTimer = null, focusName = null, hoverEnabled = false, dragging = false
let tx = 40, ty = 40, scale = 1
let orthoAvoid = true
let dirty = false
let posChangedCb = null, dbmlEditedCb = null

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
function h2rgb (hex) { hex = hex.replace('#', ''); if (hex.length === 3) hex = hex.split('').map(c => c + c).join(''); return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] }
function rgb2hsl (r, g, b) {
  r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b); let h, s; const l = (mx + mn) / 2
  if (mx === mn) { h = s = 0 } else {
    const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn)
    switch (mx) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4 } h /= 6
  }
  return [h * 360, s, l]
}
function soften (hex, satCap, lMin, lMax) {
  try { const [r, g, b] = h2rgb(hex); let [h, s, l] = rgb2hsl(r, g, b); s = Math.min(s, satCap); l = Math.max(lMin, Math.min(lMax, l)); return { h, s, l } } catch (e) { return { h: 210, s: 0.1, l: 0.5 } }
}
export function headerStyle (hex) {
  const c = soften(hex || '#556173', 0.40, 0.46, 0.60)
  return { bg: `hsl(${c.h | 0} ${(c.s * 100) | 0}% ${(c.l * 100) | 0}%)`, fg: c.l > 0.58 ? '#111722' : '#f4f7ff' }
}
export function groupStyle (hex) {
  const c = soften(hex || '#556173', 0.46, 0.45, 0.62); const p = `${c.h | 0} ${(c.s * 100) | 0}% ${(c.l * 100) | 0}%`
  return { fill: `hsla(${p} / .17)`, border: `hsla(${p} / .85)`, labelBg: `hsl(${p})`, labelFg: c.l > 0.58 ? '#111722' : '#f4f7ff' }
}
const ICON = {
  key: '<svg class="icn pk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="9" r="4"/><path d="M10 12l8 8"/><path d="M15 17l2-2"/><path d="M18 20l2-2"/></svg>',
  link: '<svg class="icn fk" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
  note: '<svg class="icn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M9 13h6M9 17h4"/></svg>',
  empty: '<span class="icn"></span>',
  kebab: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>',
  grip: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.5"/><circle cx="8" cy="12" r="1.5"/><circle cx="8" cy="18" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>'
}
const tableHeight = t => HEADER_H + t.columns.length * ROW_H
const colIndexPk = nm => { const i = model.tables[nm].columns.findIndex(c => c.pk); return i < 0 ? 0 : i }
function groupOf (nm) { for (const g of model.groups) if (g.tables.includes(nm)) return g; return null }

/* ---------- layout ---------- */
function computeLayout () {
  positions = {}
  let cursorX = 0, rowY = 0, rowMaxH = 0; const MAX_COL_H = 1500, WRAP = 5200
  const clusters = []
  for (const g of model.groups) { const mem = g.tables.filter(t => model.tables[t]); if (mem.length) clusters.push({ members: mem }) }
  const ung = model.order.filter(t => !groupOf(t)); if (ung.length) clusters.push({ members: ung })
  for (const cl of clusters) {
    let subX = 0, colY = 0, cw = 0, ch = 0; const local = []
    for (const nm of cl.members) {
      const h = tableHeight(model.tables[nm])
      if (colY > 0 && colY + h > MAX_COL_H) { subX += TABLE_W + GAP; colY = 0 }
      local.push({ nm, x: subX, y: colY }); colY += h + GAP; cw = Math.max(cw, subX + TABLE_W); ch = Math.max(ch, colY - GAP)
    }
    if (cursorX > 0 && cursorX + cw > WRAP) { cursorX = 0; rowY += rowMaxH + GRP_PAD * 3 + 40; rowMaxH = 0 }
    const ox = cursorX + GRP_PAD, oy = rowY + GRP_PAD
    for (const it of local) positions[it.nm] = { x: ox + it.x, y: oy + it.y }
    cursorX += cw + GRP_PAD * 2 + 60; rowMaxH = Math.max(rowMaxH, ch + GRP_PAD * 2)
  }
}
function placeMissing () {
  const missing = model.order.filter(t => !positions[t])
  if (!missing.length) return
  const b = bboxOf(model.order.filter(t => positions[t]))
  let x = Number.isFinite(b.x) ? b.x : 0; const y = Number.isFinite(b.y) ? b.y + b.h + 80 : 40
  for (const nm of missing) { positions[nm] = { x, y }; x += TABLE_W + GAP }
}
function bboxOf (names) {
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9
  for (const nm of names) {
    const p = positions[nm]; if (!p) continue; const t = model.tables[nm]
    a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x + TABLE_W); d = Math.max(d, p.y + tableHeight(t))
  }
  return { x: a, y: b, w: c - a, h: d - b }
}

/* ---------- diff helpers ---------- */
function tableDiff (name) { return diff ? diff.tables[name] : null }
function colDiff (name, col) {
  if (!diff) return null
  if (col._removed) return { status: 'removed', changes: [] }
  const dt = diff.tables[name]; if (!dt) return null
  return dt.columns[col.name] || null
}
function edgeStatus (tableName, col) {
  if (!diff) return null
  const dt = diff.tables[tableName]; if (!dt || dt.status === 'same') return null
  if (dt.status === 'added') return 'added'
  if (dt.status === 'removed') return 'removed'
  const dc = colDiff(tableName, col); if (!dc) return null
  if (dc.status === 'added') return 'added'
  if (dc.status === 'removed') return 'removed'
  if (dc.status === 'modified' && dc.changes.some(c => c.field === 'fk' && c.to)) return 'added'
  return null
}

/* ---------- render ---------- */
function render () {
  ;[...world.querySelectorAll('.tbl,.grp')].forEach(e => e.remove())
  while (svg.firstChild) svg.removeChild(svg.firstChild)
  tableEls = {}; edges = []
  clearTimeout(hoverTimer); focusName = null

  for (const g of model.groups) {
    if (g.nobox) continue
    const mem = g.tables.filter(t => model.tables[t] && positions[t]); if (!mem.length) continue
    const div = document.createElement('div'); div.className = 'grp'
    const gs = groupStyle(g.color)
    div.style.borderColor = gs.border; div.style.background = gs.fill
    const lbl = document.createElement('div'); lbl.className = 'grp-label'
    lbl.style.background = gs.labelBg; lbl.style.color = gs.labelFg
    lbl.innerHTML = `<span class="grip">${ICON.grip}</span><span class="glbl-name">${esc(g.name)}</span>`
    if (!diff) {
      const gk = document.createElement('span'); gk.className = 'kebab'; gk.innerHTML = ICON.kebab; gk.title = 'Group color'
      gk.addEventListener('mousedown', e => e.stopPropagation())
      gk.addEventListener('click', e => { e.stopPropagation(); openPalette(gk, 'group', g.lineStart, g.color) })
      lbl.appendChild(gk)
    }
    lbl.addEventListener('mousedown', e => startGroupDrag(e, g))
    div.appendChild(lbl); world.appendChild(div); g._el = div
  }

  for (const name of model.order) {
    const t = model.tables[name], p = positions[name]
    const dt = tableDiff(name)
    const el = document.createElement('div'); el.className = 'tbl'
    if (dt && dt.status !== 'same') el.classList.add('diff-' + dt.status)
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px'
    const hs = headerStyle(t.color)
    const hd = document.createElement('div'); hd.className = 'tbl-hd'; hd.style.background = hs.bg; hd.style.color = hs.fg
    hd.innerHTML = `<span class="hd-name">${esc(name)}</span>`
    const acts = document.createElement('span'); acts.className = 'hd-actions'
    if (dt && dt.status === 'modified') {
      const b = document.createElement('span'); b.className = 'diff-flag mod'; b.textContent = 'M'; b.title = 'Table changed'
      acts.appendChild(b)
    }
    if (t.note) {
      const ni = document.createElement('span'); ni.className = 'noteico'; ni.innerHTML = ICON.note
      bindTip(ni, name, '', 'Note', t.note); acts.appendChild(ni)
    }
    if (!diff) {
      const tk = document.createElement('span'); tk.className = 'kebab'; tk.innerHTML = ICON.kebab; tk.title = 'Table color'
      tk.addEventListener('mousedown', e => e.stopPropagation())
      tk.addEventListener('click', e => { e.stopPropagation(); openPalette(tk, 'table', t.lineStart, t.color) })
      acts.appendChild(tk)
    }
    hd.appendChild(acts)
    el.appendChild(hd)
    const body = document.createElement('div')
    t.columns.forEach(c => {
      const row = document.createElement('div'); row.className = 'col'
      const dc = colDiff(name, c)
      if (dc && dc.status !== 'same' && (!dt || dt.status === 'modified')) row.classList.add('diff-' + dc.status)
      const icon = c.pk ? ICON.key : (c.fk ? ICON.link : ICON.empty)
      const left = document.createElement('div'); left.className = 'cleft'
      left.innerHTML = `${icon}<span class="cname ${c.pk ? 'pk' : ''}">${esc(c.name)}</span>`
      if (c.note) {
        const ni = document.createElement('span'); ni.className = 'noteico'; ni.innerHTML = ICON.note
        bindTip(ni, c.name, c.type, 'Note', c.note); left.appendChild(ni)
      }
      const right = document.createElement('div'); right.className = 'cright'
      right.innerHTML = `<span class="ctype">${esc(c.type)}</span>` +
        (c.notnull ? '<span class="badge nn">NN</span>' : '') +
        (c.unique ? '<span class="badge uq">UQ</span>' : '')
      row.appendChild(left); row.appendChild(right)
      if (dc && dc.status === 'modified' && dc.changes.length) {
        const txt = dc.changes.map(ch => `${ch.field}: ${ch.from == null ? '—' : ch.from} → ${ch.to == null ? '—' : ch.to}`).join('\n')
        bindTip(row, c.name, c.type, 'Changed', txt)
      }
      body.appendChild(row)
    })
    el.appendChild(body); world.appendChild(el); tableEls[name] = el
    hd.addEventListener('mousedown', e => startTableDrag(e, name))
    if (!diff) el.addEventListener('dblclick', e => { e.preventDefault(); selectTableInEditor(name) })
    // hover-intent: focus only after 120ms still — sweeping the mouse doesn't mass-repaint
    el.addEventListener('mouseenter', () => {
      if (!hoverEnabled || dragging) return
      clearTimeout(hoverTimer); hoverTimer = setTimeout(() => applyFocus(name), 150)
    })
    el.addEventListener('mouseleave', () => {
      clearTimeout(hoverTimer)
      if (focusName === name) applyFocus(null)
    })
  }

  const addEdge = (from, to, fromCol, status) => {
    const path = document.createElementNS(SVGNS, 'path')
    path.setAttribute('class', 'edge' + (status ? ' diff-' + status : ''))
    const dA = document.createElementNS(SVGNS, 'circle'); dA.setAttribute('class', 'dot'); dA.setAttribute('r', '3')
    const dB = document.createElementNS(SVGNS, 'circle'); dB.setAttribute('class', 'dot'); dB.setAttribute('r', '3')
    svg.appendChild(path); svg.appendChild(dA); svg.appendChild(dB)
    edges.push({ from, to, fromCol, path, dA, dB, pts: null })
  }
  for (const name of model.order) {
    model.tables[name].columns.forEach((c, idx) => {
      if (c.fk && model.tables[c.fk.table]) addEdge(name, c.fk.table, idx, edgeStatus(name, c))
      // ghost edge for a changed FK: the old target still shows as a removed link
      if (diff && !c._removed) {
        const dc = colDiff(name, c)
        const ch = dc && dc.status === 'modified' && dc.changes.find(x => x.field === 'fk' && x.from)
        if (ch) {
          const oldTable = ch.from.slice(0, ch.from.lastIndexOf('.'))
          if (model.tables[oldTable]) addEdge(name, oldTable, idx, 'removed')
        }
      }
    })
  }
  edgesByTable = {}
  for (const e of edges) {
    (edgesByTable[e.from] || (edgesByTable[e.from] = [])).push(e)
    if (e.to !== e.from) (edgesByTable[e.to] || (edgesByTable[e.to] = [])).push(e)
  }
  sizeSvg(); recomputeRoutes(); positionGroups(); applyTransform()
}
function positionGroups () {
  for (const g of model.groups) {
    if (!g._el) continue
    const mem = g.tables.filter(t => model.tables[t] && positions[t])
    if (!mem.length) { g._el.style.display = 'none'; continue }
    g._el.style.display = ''; const box = bboxOf(mem)
    g._el.style.left = (box.x - GRP_PAD) + 'px'; g._el.style.top = (box.y - GRP_PAD) + 'px'
    g._el.style.width = (box.w + GRP_PAD * 2) + 'px'; g._el.style.height = (box.h + GRP_PAD * 2) + 'px'
  }
}
function sizeSvg () { const b = bboxOf(model.order); svg.setAttribute('width', b.x + b.w + 600); svg.setAttribute('height', b.y + b.h + 600) }

/* ---------- edge endpoints + orthogonal A* router (Hanan grid) ---------- */
function endpointsOf (e) {
  const pf = positions[e.from], pt = positions[e.to]
  const cf = pf.x + TABLE_W / 2, ct = pt.x + TABLE_W / 2
  let sS, tS; if (e.from === e.to) { sS = 'r'; tS = 'r' } else if (ct >= cf) { sS = 'r'; tS = 'l' } else { sS = 'l'; tS = 'r' }
  const a = { x: sS === 'r' ? pf.x + TABLE_W : pf.x, y: pf.y + HEADER_H + (e.fromCol + 0.5) * ROW_H, side: sS }
  const b = { x: tS === 'r' ? pt.x + TABLE_W : pt.x, y: pt.y + HEADER_H + (colIndexPk(e.to) + 0.5) * ROW_H, side: tS }
  return { a, b, aExit: { x: a.x + (sS === 'r' ? ROUTE_M : -ROUTE_M), y: a.y }, bExit: { x: b.x + (tS === 'r' ? ROUTE_M : -ROUTE_M), y: b.y } }
}

class MinHeap {
  constructor () { this.a = [] }
  size () { return this.a.length }
  push (k, p) {
    this.a.push({ k, p }); let i = this.a.length - 1
    while (i > 0) { const j = (i - 1) >> 1; if (this.a[j].p <= this.a[i].p) break; [this.a[i], this.a[j]] = [this.a[j], this.a[i]]; i = j }
  }
  pop () {
    const top = this.a[0], last = this.a.pop()
    if (this.a.length) {
      this.a[0] = last; let i = 0; const nn = this.a.length
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2; let m = i
        if (l < nn && this.a[l].p < this.a[m].p) m = l
        if (r < nn && this.a[r].p < this.a[m].p) m = r
        if (m === i) break; [this.a[i], this.a[m]] = [this.a[m], this.a[i]]; i = m
      }
    }
    return top.k
  }
}

function buildRouter () {
  const obs = model.order.map(nm => {
    const p = positions[nm], t = model.tables[nm]
    return { name: nm, x1: p.x - ROUTE_M, y1: p.y - ROUTE_M, x2: p.x + TABLE_W + ROUTE_M, y2: p.y + tableHeight(t) + ROUTE_M }
  })
  const xset = new Set(), yset = new Set()
  for (const o of obs) { xset.add(o.x1); xset.add(o.x2); yset.add(o.y1); yset.add(o.y2) }
  for (const e of edges) {
    e._ep = endpointsOf(e)
    xset.add(e._ep.aExit.x); yset.add(e._ep.a.y); xset.add(e._ep.bExit.x); yset.add(e._ep.b.y)
  }
  const xs = [...xset].sort((a, b) => a - b), ys = [...yset].sort((a, b) => a - b)
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]))
  const hBlk = (xa, xb, y, ig) => {
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb)
    for (const o of obs) { if (ig && ig.has(o.name)) continue; if (y > o.y1 && y < o.y2 && Math.min(hi, o.x2) - Math.max(lo, o.x1) > 0.5) return true } return false
  }
  const vBlk = (x, ya, yb, ig) => {
    const lo = Math.min(ya, yb), hi = Math.max(ya, yb)
    for (const o of obs) { if (ig && ig.has(o.name)) continue; if (x > o.x1 && x < o.x2 && Math.min(hi, o.y2) - Math.max(lo, o.y1) > 0.5) return true } return false
  }
  return { xs, ys, xi, yi, hBlk, vBlk, big: (xs.length > 170 || ys.length > 170) }
}
function routeAstar (e, R) {
  const { xs, ys, xi, yi, hBlk, vBlk } = R
  const sx = xi.get(e._ep.aExit.x), sy = yi.get(e._ep.a.y), gx = xi.get(e._ep.bExit.x), gy = yi.get(e._ep.b.y)
  if (sx == null || sy == null || gx == null || gy == null) return null
  const W = xs.length, H = ys.length, ig = new Set([e.from, e.to])
  const key = (x, y, d) => x * 100000 + y * 10 + d
  const g = {}, came = {}, open = new MinHeap()
  const hh = (x, y) => Math.abs(xs[x] - xs[gx]) + Math.abs(ys[y] - ys[gy])
  const sk = key(sx, sy, 1); g[sk] = 0; open.push(sk, hh(sx, sy))
  let found = null, iter = 0
  while (open.size() && iter++ < 60000) {
    const cur = open.pop(); const d = cur % 10, y = Math.floor(cur / 10) % 10000, x = Math.floor(cur / 100000)
    if (x === gx && y === gy) { found = cur; break }
    const gc = g[cur]
    const nb = [[x - 1, y, 1], [x + 1, y, 1], [x, y - 1, 0], [x, y + 1, 0]]
    for (const [nx, ny, nd] of nb) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
      if (nd === 1) { if (hBlk(xs[x], xs[nx], ys[y], ig)) continue } else { if (vBlk(xs[x], ys[y], ys[ny], ig)) continue }
      const dist = nd === 1 ? Math.abs(xs[nx] - xs[x]) : Math.abs(ys[ny] - ys[y])
      const ng = gc + dist + (nd !== d ? 20 : 0)
      const nk = key(nx, ny, nd)
      if (g[nk] == null || ng < g[nk]) { g[nk] = ng; came[nk] = cur; open.push(nk, ng + hh(nx, ny)) }
    }
  }
  if (found == null) return null
  const pts = []; let c = found
  while (c != null) { const y = Math.floor(c / 10) % 10000, x = Math.floor(c / 100000); pts.push({ x: xs[x], y: ys[y] }); c = came[c] }
  pts.reverse()
  return simplify([{ x: e._ep.a.x, y: e._ep.a.y }, ...pts, { x: e._ep.b.x, y: e._ep.b.y }])
}
function routeCheap (e) {
  const ep = endpointsOf(e); e._ep = ep
  if (e.from === e.to) return selfLoop(e)
  const a = ep.a, b = ep.b, ax = ep.aExit.x, bx = ep.bExit.x
  const mid = (ax + bx) / 2
  return simplify([{ x: a.x, y: a.y }, { x: ax, y: a.y }, { x: mid, y: a.y }, { x: mid, y: b.y }, { x: bx, y: b.y }, { x: b.x, y: b.y }])
}
function selfLoop (e) {
  const p = positions[e.from]; const y1 = p.y + HEADER_H + (e.fromCol + 0.5) * ROW_H
  const y2 = p.y + HEADER_H + (colIndexPk(e.from) + 0.5) * ROW_H; const rx = p.x + TABLE_W, o = rx + 30
  return [{ x: rx, y: y1 }, { x: o, y: y1 }, { x: o, y: y2 }, { x: rx, y: y2 }]
}
function simplify (pts) {
  const out = [pts[0]]
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1]
    const col = (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5)
    if (!col) out.push(b)
  }
  out.push(pts[pts.length - 1]); return out
}
function recomputeRoutes () {
  let R = null
  if (orthoAvoid) { try { R = buildRouter() } catch (e) { R = null } }
  for (const e of edges) {
    let pts = null
    if (orthoAvoid && R && !R.big && e.from !== e.to) pts = routeAstar(e, R)
    if (!pts) pts = routeCheap(e)
    e.pts = pts; drawPath(e)
  }
}
function orthPath (pts, r) {
  r = r || 6; if (pts.length < 2) return ''
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], pv = pts[i - 1], nx = pts[i + 1]
    const l1 = Math.hypot(p.x - pv.x, p.y - pv.y), l2 = Math.hypot(nx.x - p.x, nx.y - p.y)
    const r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2)
    const u1 = { x: (pv.x - p.x) / (l1 || 1), y: (pv.y - p.y) / (l1 || 1) }, u2 = { x: (nx.x - p.x) / (l2 || 1), y: (nx.y - p.y) / (l2 || 1) }
    d += ` L ${p.x + u1.x * r1} ${p.y + u1.y * r1} Q ${p.x} ${p.y} ${p.x + u2.x * r2} ${p.y + u2.y * r2}`
  }
  const L = pts[pts.length - 1]; d += ` L ${L.x} ${L.y}`; return d
}
function drawPath (e) {
  if (!e.pts || !positions[e.from] || !positions[e.to]) { e.path.style.display = 'none'; return }
  e.path.style.display = ''; e.path.setAttribute('d', orthPath(e.pts))
  const a = e.pts[0], b = e.pts[e.pts.length - 1]
  e.dA.setAttribute('cx', a.x); e.dA.setAttribute('cy', a.y); e.dB.setAttribute('cx', b.x); e.dB.setAttribute('cy', b.y)
}
function drawEdgesCheap (list) { for (const e of (list || edges)) { e.pts = routeCheap(e); drawPath(e) } }

/* ---------- highlight + tooltip ---------- */
// Single idempotent focus state: applyFocus(name) highlights, applyFocus(null)
// clears. Avoids the flicker of paired on/off toggles racing during mouse sweeps.
function applyFocus (name) {
  if (name === focusName) return
  focusName = name
  const on = name != null
  const rel = new Set(on ? [name] : [])
  if (on) edges.forEach(e => { if (e.from === name || e.to === name) { rel.add(e.from); rel.add(e.to) } })
  for (const nm in tableEls) { tableEls[nm].classList.toggle('dim', on && !rel.has(nm)); tableEls[nm].classList.toggle('hl', on && nm === name) }
  edges.forEach(e => {
    const inv = on && (e.from === name || e.to === name)
    e.path.classList.toggle('hi', inv); e.path.classList.toggle('dim', on && !inv)
    e.dA.classList.toggle('hi', inv); e.dB.classList.toggle('hi', inv)
    e.dA.classList.toggle('dim', on && !inv); e.dB.classList.toggle('dim', on && !inv)
  })
}
export function setHoverHighlight (on) {
  hoverEnabled = on
  clearTimeout(hoverTimer)
  if (!on) applyFocus(null)
}
function bindTip (el, name, type, label, body) {
  el.addEventListener('mouseenter', e => {
    tip.innerHTML = `<div class="th">${esc(name)}${type ? ` <span class="tt">${esc(type)}</span>` : ''}</div>` +
      `<div class="tl">${esc(label)}</div><div class="tb">${esc(body)}</div>`
    tip.style.display = 'block'; moveTip(e)
  })
  el.addEventListener('mousemove', moveTip)
  el.addEventListener('mouseleave', () => { tip.style.display = 'none' })
}
function moveTip (e) {
  const pad = 14; let x = e.clientX + pad, y = e.clientY + pad
  const r = tip.getBoundingClientRect()
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad
  tip.style.left = x + 'px'; tip.style.top = y + 'px'
}

/* ---------- interaction ---------- */
// rAF-coalesced: wheel/mousemove fire far more often than frames render, and
// re-writing the transform of a huge layer per event causes tile flicker.
let tfPending = false
function applyTransform () {
  if (tfPending) return
  tfPending = true
  requestAnimationFrame(() => {
    tfPending = false
    world.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`
    // far mode: below 45% zoom column text/shadows are unreadable anyway — skip painting them
    world.classList.toggle('far', scale < 0.45)
    $('zlvl').textContent = Math.round(scale * 100) + '%'
  })
}
function markDirty () {
  dirty = true
  if (posChangedCb) posChangedCb(getDirtyPositions())
}
function startTableDrag (e, name) {
  e.stopPropagation(); e.preventDefault()
  dragging = true; clearTimeout(hoverTimer); applyFocus(null)
  const sx = e.clientX, sy = e.clientY, ox = positions[name].x, oy = positions[name].y
  const mv = ev => {
    positions[name].x = ox + (ev.clientX - sx) / scale; positions[name].y = oy + (ev.clientY - sy) / scale
    tableEls[name].style.left = positions[name].x + 'px'; tableEls[name].style.top = positions[name].y + 'px'
    drawEdgesCheap(edgesByTable[name]); positionGroups()
  }
  const up = ev => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up)
    dragging = false
    sizeSvg(); recomputeRoutes()
    if (ev.clientX !== sx || ev.clientY !== sy) markDirty()
  }
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
}
function startGroupDrag (e, g) {
  e.stopPropagation(); e.preventDefault()
  dragging = true; clearTimeout(hoverTimer); applyFocus(null)
  const mem = g.tables.filter(t => model.tables[t] && positions[t])
  const sx = e.clientX, sy = e.clientY; const orig = {}; mem.forEach(nm => { orig[nm] = { x: positions[nm].x, y: positions[nm].y } })
  const memSet = new Set(mem), gEdges = edges.filter(ed => memSet.has(ed.from) || memSet.has(ed.to))
  const mv = ev => {
    const dx = (ev.clientX - sx) / scale, dy = (ev.clientY - sy) / scale
    mem.forEach(nm => {
      positions[nm].x = orig[nm].x + dx; positions[nm].y = orig[nm].y + dy
      tableEls[nm].style.left = positions[nm].x + 'px'; tableEls[nm].style.top = positions[nm].y + 'px'
    })
    drawEdgesCheap(gEdges); positionGroups()
  }
  const up = ev => {
    window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up)
    dragging = false
    sizeSvg(); recomputeRoutes()
    if (ev.clientX !== sx || ev.clientY !== sy) markDirty()
  }
  window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
}
export function fit () {
  if (!model) return
  const b = bboxOf(model.order); const vw = viewport.clientWidth, vh = viewport.clientHeight
  scale = Math.max(0.08, Math.min(1.4, Math.min(vw / (b.w + 180), vh / (b.h + 180))))
  tx = (vw - b.w * scale) / 2 - b.x * scale; ty = (vh - b.h * scale) / 2 - b.y * scale; applyTransform()
}

/* ---------- editor (side pane, edit mode) ---------- */
let code, gutter, preHl, hlCode
const HL_KW = new Set(['table', 'tablegroup', 'ref', 'enum', 'enums', 'indexes', 'project', 'note'])
const HL_TY = new Set(['int', 'integer', 'tinyint', 'smallint', 'bigint', 'serial', 'bigserial', 'boolean', 'bool', 'text', 'varchar', 'char', 'character', 'timestamp', 'timestamptz', 'datetime', 'date', 'time', 'decimal', 'numeric', 'float', 'real', 'double', 'json', 'jsonb', 'uuid', 'vector', 'interval', 'bytea', 'money', 'blob', 'int4', 'int8', 'int2', 'float4', 'float8'])
const HL_AT = new Set(['pk', 'primary', 'key', 'not', 'null', 'unique', 'increment', 'default', 'note', 'ref', 'headercolor', 'color', 'name', 'as', 'autoincrement', 'type', 'btree'])
const esc2 = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
const HL_RE = /(\/\/[^\n]*)|('(?:[^'\\]|\\.)*')|(`(?:[^`\\]|\\.)*`)|(#[0-9a-fA-F]{3,8}\b)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)|(\s+)|([^\sA-Za-z0-9_])/g
// per-line cache: repeated lines (}, blanks, identical columns) don't re-tokenize
const hlCache = new Map()
function hlLine (line) {
  const cached = hlCache.get(line); if (cached != null) return cached
  let out = '', m; HL_RE.lastIndex = 0
  while ((m = HL_RE.exec(line))) {
    if (m[1]) out += `<span class="t-com">${esc2(m[1])}</span>`
    else if (m[2]) out += `<span class="t-str">${esc2(m[2])}</span>`
    else if (m[3]) out += `<span class="t-expr">${esc2(m[3])}</span>`
    else if (m[4]) out += `<span class="t-hex">${esc2(m[4])}</span>`
    else if (m[5]) out += `<span class="t-num">${esc2(m[5])}</span>`
    else if (m[6]) { const l = m[6].toLowerCase(); const cls = HL_KW.has(l) ? 't-kw' : HL_TY.has(l) ? 't-type' : HL_AT.has(l) ? 't-attr' : 't-id'; out += `<span class="${cls}">${esc2(m[6])}</span>` } else if (m[7]) out += esc2(m[7])
    else if (m[8]) out += `<span class="t-punc">${esc2(m[8])}</span>`
  }
  if (hlCache.size > 40000) hlCache.clear()
  hlCache.set(line, out); return out
}
function highlight () { hlCode.innerHTML = code.value.split('\n').map(hlLine).join('\n') }
function syncGutter () { const n = code.value.split('\n').length; let s = ''; for (let i = 1; i <= n; i++) s += i + '\n'; gutter.textContent = s }
function syncScroll () { preHl.scrollTop = code.scrollTop; preHl.scrollLeft = code.scrollLeft; gutter.scrollTop = code.scrollTop }

let editTimer = null, hlTimer = null, sourceText = ''
let parseFn = null // injected: (text) => model — keeps this module free of a parser import cycle

function onCodeInput () {
  const large = code.value.length > 120000
  if (large) { clearTimeout(hlTimer); hlTimer = setTimeout(() => { highlight(); syncGutter(); syncScroll() }, 350) } else { highlight(); syncGutter() }
  syncScroll(); $('edDot').classList.remove('err'); $('edStatus').textContent = 'editing…'
  clearTimeout(editTimer); editTimer = setTimeout(reparseFromEditor, large ? 1200 : 450)
}
function reparseFromEditor () {
  const txt = code.value
  if (txt === sourceText) { $('edDot').classList.remove('err'); $('edStatus').textContent = 'ok'; return }
  try {
    const m = parseFn(txt)
    if (!m.order.length) { $('edDot').classList.add('err'); $('edStatus').textContent = 'no tables'; return }
    sourceText = txt
    $('edDot').classList.remove('err'); $('edStatus').textContent = 'ok'
    if (dbmlEditedCb) dbmlEditedCb(m, txt)
  } catch (err) { $('edDot').classList.add('err'); $('edStatus').textContent = 'syntax error' }
}
function selectTableInEditor (name) {
  const t = model.tables[name]; if (!t) return
  if ($('editorPane').classList.contains('hidden')) return
  const lines = code.value.split('\n')
  let start = 0; for (let i = 0; i < t.lineStart; i++) start += lines[i].length + 1
  let end = start; for (let i = t.lineStart; i <= t.lineEnd && i < lines.length; i++) end += lines[i].length + 1
  end = Math.min(end, code.value.length)
  code.focus(); code.setSelectionRange(start, end)
  const lineH = parseFloat(getComputedStyle(code).lineHeight) || 18
  code.scrollTop = Math.max(0, (t.lineStart - 2) * lineH); syncGutter()
}

/* ---------- color palette (kebab on tables and groups) ---------- */
const SWATCHES = ['#011B4E', '#0891B2', '#24BAB1', '#2ecc71', '#33FF57', '#16A34A', '#6724BB', '#8B5CF6', '#DE65C3', '#D96227', '#E4A62E', '#E5674F', '#3B82F6', '#0EA5E9', '#14B8A6', '#64748B', '#475569', '#222222']
let palCtx = null
function buildPalette () {
  const grid = $('palGrid'); grid.innerHTML = ''
  SWATCHES.forEach(hex => {
    const s = document.createElement('div'); s.className = 'swatch'; s.style.background = hex; s.title = hex
    s.addEventListener('click', () => { applyColor(palCtx, hex); closePalette() }); grid.appendChild(s)
  })
}
function openPalette (anchor, kind, lineIdx, current) {
  if (document.body.classList.contains('mode-view')) return
  palCtx = { kind, lineIdx }; const pal = $('palette'); pal.style.display = 'block'
  $('palCustom').value = /^#[0-9a-fA-F]{6}$/.test(current || '') ? current : '#0891B2'
  const r = anchor.getBoundingClientRect(), pw = pal.offsetWidth, ph = pal.offsetHeight
  const x = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8))
  let y = r.bottom + 6; if (y + ph > window.innerHeight - 8) y = r.top - ph - 6; if (y < 8) y = 8
  pal.style.left = x + 'px'; pal.style.top = y + 'px'
}
function closePalette () { $('palette').style.display = 'none'; palCtx = null }
function setColorInLine (line, key, hex) {
  const re = new RegExp(key + '\\s*:\\s*#[0-9a-fA-F]{3,8}', 'i')
  if (re.test(line)) return line.replace(re, key + ': ' + hex)
  if (/\[[^\]]*\]/.test(line)) return line.replace(/\[([^\]]*)\]/, (m, inner) => `[${inner.trim()}${inner.trim() ? ', ' : ''}${key}: ${hex}]`)
  if (line.includes('{')) return line.replace('{', `[${key}: ${hex}] {`)
  return line.replace(/\s*$/, '') + ` [${key}: ${hex}]`
}
function applyColor (ctx, hex) {
  if (!ctx) return; const lines = code.value.split('\n'); if (lines[ctx.lineIdx] == null) return
  const key = ctx.kind === 'table' ? 'headercolor' : 'color'
  lines[ctx.lineIdx] = setColorInLine(lines[ctx.lineIdx], key, hex)
  code.value = lines.join('\n'); highlight(); syncGutter(); reparseFromEditor()
}

/* ================================================================== *
 * PUBLIC API
 * ================================================================== */
export function initDiagram (opts) {
  parseFn = opts.parse
  viewport = $('viewport'); world = $('world'); svg = $('svg'); tip = $('tip')
  code = $('code'); gutter = $('gutter'); preHl = $('hl'); hlCode = preHl.firstElementChild

  let panning = false, px = 0, py = 0
  viewport.addEventListener('mousedown', e => {
    if (e.target.closest('.tbl') || e.target.closest('.grp-label')) return
    panning = true; px = e.clientX; py = e.clientY; viewport.classList.add('grabbing')
  })
  window.addEventListener('mousemove', e => { if (panning) { tx += e.clientX - px; ty += e.clientY - py; px = e.clientX; py = e.clientY; applyTransform() } })
  window.addEventListener('mouseup', () => { panning = false; viewport.classList.remove('grabbing') })
  viewport.addEventListener('wheel', e => {
    e.preventDefault(); const rc = viewport.getBoundingClientRect()
    const mx = e.clientX - rc.left, my = e.clientY - rc.top, wx = (mx - tx) / scale, wy = (my - ty) / scale
    const f = e.deltaY < 0 ? 1.12 : 1 / 1.12; scale = Math.max(0.08, Math.min(3, scale * f)); tx = mx - wx * scale; ty = my - wy * scale; applyTransform()
  }, { passive: false })

  $('zin').innerHTML = ICON.plus; $('zout').innerHTML = ICON.minus
  $('zin').addEventListener('click', () => { scale = Math.min(3, scale * 1.15); applyTransform() })
  $('zout').addEventListener('click', () => { scale = Math.max(0.08, scale / 1.15); applyTransform() })
  $('btnFit').addEventListener('click', () => fit())
  $('btnOrtho').addEventListener('click', () => { orthoAvoid = !orthoAvoid; $('btnOrtho').classList.toggle('on', orthoAvoid); if (model) recomputeRoutes() })
  $('btnOrtho').classList.add('on')
  // hover highlight: opt-in — with hundreds of tables the dim/undim repaints are heavy
  const hlSaved = localStorage.getItem('gabbro:hover-highlight') === '1'
  setHoverHighlight(hlSaved)
  $('btnHl').classList.toggle('on', hlSaved)
  $('btnHl').addEventListener('click', () => {
    const on = !$('btnHl').classList.contains('on')
    $('btnHl').classList.toggle('on', on)
    setHoverHighlight(on)
    localStorage.setItem('gabbro:hover-highlight', on ? '1' : '0')
  })

  code.addEventListener('scroll', syncScroll)
  code.addEventListener('input', onCodeInput)

  ;(function splitter () {
    let dragging = false; const sp = $('splitter')
    sp.addEventListener('mousedown', e => { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize' })
    window.addEventListener('mousemove', e => {
      if (!dragging) return
      const w = Math.max(240, Math.min(window.innerWidth - 360, e.clientX))
      document.documentElement.style.setProperty('--edw', w + 'px')
    })
    window.addEventListener('mouseup', () => { dragging = false; document.body.style.cursor = '' })
  })()

  buildPalette()
  $('palCustom').addEventListener('input', e => { if (palCtx) applyColor(palCtx, e.target.value) })
  document.addEventListener('mousedown', e => { if (!e.target.closest('#palette') && !e.target.closest('.kebab')) closePalette() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePalette() })
}

// positionsObj: API shape {version, tables:{name:{x,y}}}. diffResult: from
// diffModels() over the same base/target used to build a union model, or null.
export function loadModel (m, positionsObj, diffResult, opts) {
  opts = opts || {}
  model = m
  diff = diffResult || null
  const src = (positionsObj && positionsObj.tables) || {}
  positions = {}
  for (const [nm, p] of Object.entries(src)) {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) positions[nm] = { x: p.x, y: p.y }
  }
  if (!model.order.some(t => positions[t])) computeLayout()
  placeMissing()
  render()
  if (opts.fitView !== false) fit()
  dirty = !!opts.dirty
}

export function getDirtyPositions () {
  const out = { version: 1, tables: {} }
  for (const [nm, p] of Object.entries(positions)) {
    const t = model && model.tables[nm]
    if (t && t._removed) continue
    out.tables[nm] = { x: Math.round(p.x), y: Math.round(p.y) }
  }
  return out
}
export function isDirty () { return dirty }
export function clearDirty () { dirty = false }
export function onPositionsChanged (cb) { posChangedCb = cb }
export function onDbmlEdited (cb) { dbmlEditedCb = cb }

export function setEditorVisible (on) {
  $('editorPane').classList.toggle('hidden', !on)
  requestAnimationFrame(() => { if (model) applyTransform() })
}
export function setEditorText (text) {
  sourceText = text
  code.value = text
  highlight(); syncGutter(); syncScroll()
  $('edDot').classList.remove('err'); $('edStatus').textContent = 'ready'
}
export function getEditorText () { return code.value }

export function searchTable (q) {
  if (!model || !q) return false
  q = q.trim().toLowerCase(); if (!q) return false
  // rank: exact > prefix > shortest substring match — "stock" must hit stock, not doc_item_stock
  const lower = model.order.map(t => [t, t.toLowerCase()])
  const name =
    (lower.find(([, l]) => l === q) ||
     lower.filter(([, l]) => l.startsWith(q)).sort((a, b) => a[1].length - b[1].length)[0] ||
     lower.filter(([, l]) => l.includes(q)).sort((a, b) => a[1].length - b[1].length)[0] ||
     [])[0]
  if (!name || !tableEls[name]) return false
  const p = positions[name], t = model.tables[name]; scale = 1
  tx = viewport.clientWidth / 2 - (p.x + TABLE_W / 2); ty = viewport.clientHeight / 2 - (p.y + tableHeight(t) / 2); applyTransform()
  tableEls[name].classList.add('hl'); setTimeout(() => tableEls[name] && tableEls[name].classList.remove('hl'), 1200)
  return true
}

export function getStats () {
  if (!model) return null
  const nE = model.order.reduce((s, t) => s + model.tables[t].columns.filter(c => c.fk).length, 0)
  return { tables: model.order.length, groups: model.groups.length, refs: nE }
}
