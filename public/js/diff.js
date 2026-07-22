// Structural diff between two parsed DBML models — pure ESM, no DOM: runs in
// browser and node. Compares structure only (type, pk, notnull, unique,
// increment, default, fk); ignores colors, positions, notes and groups.

const FIELDS = ['type', 'pk', 'notnull', 'unique', 'increment', 'default', 'fk']

const fkStr = c => (c.fk ? `${c.fk.table}.${c.fk.col}` : null)

function fieldValue (col, field) {
  if (field === 'fk') return fkStr(col)
  if (field === 'pk' || field === 'notnull' || field === 'unique' || field === 'increment') return !!col[field]
  const v = col[field]
  return v == null ? null : String(v)
}

export function diffModels (baseModel, targetModel) {
  const res = { tables: {} }
  const names = new Set([...baseModel.order, ...targetModel.order])
  for (const nm of names) {
    const bt = baseModel.tables[nm], tt = targetModel.tables[nm]
    if (!bt) {
      const columns = {}
      for (const c of tt.columns) columns[c.name] = { status: 'added', changes: [] }
      res.tables[nm] = { status: 'added', columns }
      continue
    }
    if (!tt) {
      const columns = {}
      for (const c of bt.columns) columns[c.name] = { status: 'removed', changes: [] }
      res.tables[nm] = { status: 'removed', columns }
      continue
    }
    const columns = {}; let modified = false
    const bmap = new Map(bt.columns.map(c => [c.name, c]))
    const tmap = new Map(tt.columns.map(c => [c.name, c]))
    const cnames = new Set([...bt.columns.map(c => c.name), ...tt.columns.map(c => c.name)])
    for (const cn of cnames) {
      const bc = bmap.get(cn), tc = tmap.get(cn)
      if (!bc) { columns[cn] = { status: 'added', changes: [] }; modified = true; continue }
      if (!tc) { columns[cn] = { status: 'removed', changes: [] }; modified = true; continue }
      const changes = []
      for (const f of FIELDS) {
        const from = fieldValue(bc, f), to = fieldValue(tc, f)
        if (from !== to) changes.push({ field: f, from, to })
      }
      columns[cn] = { status: changes.length ? 'modified' : 'same', changes }
      if (changes.length) modified = true
    }
    res.tables[nm] = { status: modified ? 'modified' : 'same', columns }
  }
  return res
}

export function diffSummary (diff) {
  const s = { added: [], removed: [], modified: [] }
  for (const [nm, t] of Object.entries(diff.tables)) {
    if (t.status !== 'same') s[t.status].push(nm)
  }
  s.added.sort(); s.removed.sort(); s.modified.sort()
  return s
}

// Render model for diff mode: target tables (with removed base columns spliced
// back in as ghosts) plus ghost tables removed from base. Ghosts carry _removed.
export function buildUnionModel (baseModel, targetModel, diff) {
  const tables = {}, order = [...targetModel.order]
  for (const nm of targetModel.order) {
    const tt = targetModel.tables[nm]
    const d = diff.tables[nm]
    let columns = tt.columns.slice()
    if (d && d.status === 'modified') {
      const bt = baseModel.tables[nm]
      bt.columns.forEach((bc, bi) => {
        const dc = d.columns[bc.name]
        if (dc && dc.status === 'removed') columns.splice(Math.min(bi, columns.length), 0, { ...bc, _removed: true })
      })
    }
    tables[nm] = { ...tt, columns }
  }
  for (const nm of baseModel.order) {
    const d = diff.tables[nm]
    if (d && d.status === 'removed') {
      order.push(nm)
      const bt = baseModel.tables[nm]
      tables[nm] = { ...bt, _removed: true, columns: bt.columns.map(c => ({ ...c, _removed: true })) }
    }
  }
  const groups = targetModel.groups.map(g => ({ ...g, tables: g.tables.slice() }))
  for (const g of baseModel.groups) {
    const ghosts = g.tables.filter(tn => tables[tn] && tables[tn]._removed)
    if (!ghosts.length) continue
    const tg = groups.find(x => x.name === g.name)
    if (tg) { for (const tn of ghosts) if (!tg.tables.includes(tn)) tg.tables.push(tn) } else groups.push({ ...g, tables: ghosts })
  }
  return { tables, order, groups }
}
