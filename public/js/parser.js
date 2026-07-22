// DBML parser (subset) — pure ESM, no DOM references: runs in browser and node.
// Ported from the original dbml-viewer, extended with: column `increment` and
// `default`, and table `Indexes` blocks (composite uniques for the docs tab).

export function parseDBML (src) {
  const tables = {}, order = [], groups = []
  const lines = src.split(/\r?\n/); const n = lines.length; let i = 0

  const colorFrom = s => { const m = /(?:head)?color\s*:\s*(#[0-9a-fA-F]{3,8})/i.exec(s || ''); return m ? m[1] : null }
  const stripQ = s => {
    s = s.trim()
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')) ||
        (s.startsWith('`') && s.endsWith('`'))) s = s.slice(1, -1)
    return s.replace(/\\n/g, '\n')
  }

  function splitColumnLine (line) {
    const stack = [], gi = []; let inS = false, inB = false
    for (let k = 0; k < line.length; k++) {
      const c = line[k]
      if (inS) { if (c === "'") inS = false; continue } if (inB) { if (c === '`') inB = false; continue }
      if (c === "'") { inS = true; continue } if (c === '`') { inB = true; continue }
      if (c === '[') { if (stack.length === 0) gi.push({ s: k, e: -1 }); stack.push(k) } else if (c === ']') { if (stack.length) { stack.pop(); if (stack.length === 0) gi[gi.length - 1].e = k } }
    }
    for (let g = gi.length - 1; g >= 0; g--) {
      const gr = gi[g]
      if (gr.e > gr.s && gr.s > 0 && /\s/.test(line[gr.s - 1])) return { def: line.slice(0, gr.s).trim(), set: line.slice(gr.s + 1, gr.e) }
    }
    return { def: line.trim(), set: null }
  }
  function splitSettings (s) {
    const p = []; let cur = '', inS = false, inB = false, d = 0
    for (const c of s) {
      if (inS) { cur += c; if (c === "'") inS = false; continue } if (inB) { cur += c; if (c === '`') inB = false; continue }
      if (c === "'") { inS = true; cur += c; continue } if (c === '`') { inB = true; cur += c; continue }
      if (c === '[') { d++; cur += c; continue } if (c === ']') { d--; cur += c; continue }
      if (c === ',' && d === 0) { if (cur.trim()) p.push(cur.trim()); cur = ''; continue } cur += c
    }
    if (cur.trim()) p.push(cur.trim()); return p
  }
  function parseRef (v) {
    const m = /[<>-]\s*([\w"`.]+)/.exec(v); if (!m) return null
    const t = m[1].replace(/[`"]/g, ''); const d = t.lastIndexOf('.'); if (d < 0) return null
    return { table: t.slice(0, d), col: t.slice(d + 1) }
  }
  function parseIndexLine (l) {
    const { def, set } = splitColumnLine(l)
    let cols
    const cm = /^\(([^)]*)\)/.exec(def)
    if (cm) cols = cm[1].split(',').map(s => s.trim().replace(/[`"]/g, '')).filter(Boolean)
    else { const single = def.replace(/[`"]/g, '').trim(); cols = single ? [single] : [] }
    const idx = { cols, name: null, unique: false, pk: false }
    if (set != null) {
      for (const p of splitSettings(set)) {
        const low = p.toLowerCase()
        if (low === 'unique') idx.unique = true
        else if (low === 'pk') idx.pk = true
        else if (/^name\s*:/i.test(p)) idx.name = stripQ(p.replace(/^name\s*:/i, ''))
      }
    }
    return idx.cols.length ? idx : null
  }

  while (i < n) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('//')) { i++; continue }

    const gm = /^tablegroup\b(.*)$/i.exec(line)
    if (gm) {
      const head = gm[1]; const nm = /^\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([\w-]+))/.exec(head)
      const g = {
        name: nm ? (nm[1] || nm[2] || nm[3] || nm[4]) : 'group',
        color: colorFrom(head) || '#5b6577',
        // nobox: group exists for docs/color grouping but draws no frame in the diagram
        nobox: /[[,\s]nobox\s*[\],]/i.test(head),
        tables: [],
        lineStart: i
      }
      if (!/\{/.test(line)) { while (i < n && !/\{/.test(lines[i])) i++ } i++
      while (i < n) {
        const l = lines[i].trim(); if (l.startsWith('}')) { i++; break }
        if (l && !l.startsWith('//')) { const tn = l.replace(/[`"]/g, '').split(/\s+/)[0]; if (tn) g.tables.push(tn) } i++
      }
      groups.push(g); continue
    }

    const tm = /^table\b(.*)$/i.exec(line)
    if (tm) {
      const head = tm[1]; const nm = /^\s*([`"]?)([\w-]+)\1/.exec(head)
      const tname = nm ? nm[2] : ('table_' + order.length)
      const t = { name: tname, color: colorFrom(head), note: null, columns: [], indexes: [], lineStart: i, lineEnd: i }
      if (!/\{/.test(line)) { while (i < n && !/\{/.test(lines[i])) i++ } i++
      while (i < n) {
        const l = lines[i].trim()
        if (l.startsWith('}')) { t.lineEnd = i; i++; break }
        if (l === '' || l.startsWith('//')) { i++; continue }
        if (/^indexes\b/i.test(l)) {
          if (!/\{/.test(l)) { while (i < n && !/\{/.test(lines[i])) i++ }
          i++
          while (i < n) {
            const il = lines[i].trim()
            if (il.startsWith('}')) { i++; break }
            if (il && !il.startsWith('//')) { const idx = parseIndexLine(il); if (idx) t.indexes.push(idx) }
            i++
          }
          continue
        }
        if (/^note\s*:/i.test(l)) { t.note = stripQ(l.replace(/^note\s*:/i, '')); i++; continue }
        const { def, set } = splitColumnLine(l); const toks = def.split(/\s+/); const cname = (toks.shift() || '').replace(/[`"]/g, '')
        const col = { name: cname, type: toks.join(' ') || '', pk: false, fk: null, notnull: false, unique: false, increment: false, default: null, note: null }
        if (set != null) {
          for (const p of splitSettings(set)) {
            const low = p.toLowerCase()
            if (low === 'pk' || low === 'primary key') col.pk = true
            else if (low === 'not null') col.notnull = true
            else if (low === 'unique') col.unique = true
            else if (low === 'increment' || low === 'autoincrement') col.increment = true
            else if (/^default\s*:/i.test(p)) col.default = stripQ(p.replace(/^default\s*:/i, ''))
            else if (/^note\s*:/i.test(p)) col.note = stripQ(p.replace(/^note\s*:/i, ''))
            else if (/^ref\s*:/i.test(p)) col.fk = parseRef(p.replace(/^ref\s*:/i, ''))
          }
        }
        if (cname) t.columns.push(col)
        i++
      }
      if (!tables[tname]) order.push(tname); tables[tname] = t; continue
    }
    i++
  }
  return { tables, order, groups }
}
