// Frontend smoke checks, runnable in plain node (no browser):
//   node scripts/smoke-front.mjs [path-to-large.dbml]
// Validates parser.js (incl. increment/default/Indexes extensions) and
// diff.js (all six structural change kinds) — both must stay DOM-free.

import { readFileSync } from 'node:fs'
import { parseDBML } from '../public/js/parser.js'
import { diffModels, diffSummary, buildUnionModel } from '../public/js/diff.js'

let failures = 0
function check (name, cond, detail) {
  if (cond) console.log(`  ok    ${name}`)
  else { failures++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

/* ---------- 1. large real-world DBML ---------- */
const bigPath = process.argv[2]
if (bigPath) {
  console.log(`\n[1] parse large DBML: ${bigPath}`)
  const src = readFileSync(bigPath, 'utf8')
  const t0 = Date.now()
  const m = parseDBML(src)
  const ms = Date.now() - t0
  const refs = m.order.reduce((s, t) => s + m.tables[t].columns.filter(c => c.fk).length, 0)
  const withIdx = m.order.filter(t => m.tables[t].indexes.length > 0)
  const compositeIdx = m.order.filter(t => m.tables[t].indexes.some(ix => ix.cols.length > 1))
  const withInc = m.order.filter(t => m.tables[t].columns.some(c => c.increment))
  const withDef = m.order.filter(t => m.tables[t].columns.some(c => c.default != null))
  console.log(`  parsed in ${ms}ms: ${m.order.length} tables, ${m.groups.length} groups, ${refs} refs`)
  check('>= 250 tables', m.order.length >= 250, `got ${m.order.length}`)
  check('has table groups', m.groups.length > 0)
  check('has FK refs', refs > 0)
  check('Indexes blocks captured', withIdx.length > 0, 'no table has indexes')
  check('composite indexes captured', compositeIdx.length > 0)
  check('increment captured', withInc.length > 0)
  console.log(`  (indexes on ${withIdx.length} tables, composite on ${compositeIdx.length}, increment on ${withInc.length}, default on ${withDef.length})`)
} else {
  console.log('\n[1] large DBML check skipped (no path argument)')
}

/* ---------- 2. structural diff — the six change kinds ---------- */
console.log('\n[2] diffModels: six synthetic change kinds')
const BASE = `
Table users {
  user_id int4 [pk, not null, increment]
  login varchar(30) [unique, not null]
  age int4
  group_id int4 [not null, ref: > groups.group_id]
}
Table groups {
  group_id int4 [pk, not null, increment]
  name varchar(60) [not null]
}
Table legacy_stuff {
  legacy_id int4 [pk, not null]
  payload text
}
Table teams {
  team_id int4 [pk, not null, increment]
  name varchar(60) [not null, default: 'unnamed']
}
`
const TARGET = `
Table users {
  user_id int4 [pk, not null, increment]
  login varchar(30) [unique, not null]
  age varchar(10)
  group_id int4 [not null, ref: > teams.team_id]
  email varchar(120) [not null]
}
Table groups {
  group_id int4 [pk, not null, increment]
}
Table teams {
  team_id int4 [pk, not null, increment]
  name varchar(60) [not null, default: 'unnamed']
}
Table audit_log {
  audit_log_id int4 [pk, not null, increment]
  entry jsonb [not null]
}
`
const base = parseDBML(BASE)
const target = parseDBML(TARGET)
const d = diffModels(base, target)
const s = diffSummary(d)

check('table added (audit_log)', d.tables.audit_log && d.tables.audit_log.status === 'added')
check('table removed (legacy_stuff)', d.tables.legacy_stuff && d.tables.legacy_stuff.status === 'removed')
check('column added (users.email)', d.tables.users.columns.email && d.tables.users.columns.email.status === 'added')
check('column removed (groups.name)', d.tables.groups.columns.name && d.tables.groups.columns.name.status === 'removed')

const age = d.tables.users.columns.age
const ageType = age && age.changes.find(c => c.field === 'type')
check('type changed (users.age int4→varchar(10))',
  age && age.status === 'modified' && ageType && ageType.from === 'int4' && ageType.to === 'varchar(10)',
  JSON.stringify(age))

const gid = d.tables.users.columns.group_id
const fkCh = gid && gid.changes.find(c => c.field === 'fk')
check('FK changed (users.group_id groups→teams)',
  gid && gid.status === 'modified' && fkCh && fkCh.from === 'groups.group_id' && fkCh.to === 'teams.team_id',
  JSON.stringify(gid))

check('unchanged table is same (teams)', d.tables.teams.status === 'same')
check('modified tables flagged', d.tables.users.status === 'modified' && d.tables.groups.status === 'modified')
check('summary counts', s.added.length === 1 && s.removed.length === 1 && s.modified.length === 2, JSON.stringify(s))

/* union model used by the diff rendering */
const u = buildUnionModel(base, target, d)
check('union keeps removed table as ghost', u.tables.legacy_stuff && u.tables.legacy_stuff._removed === true)
check('union splices removed column back', u.tables.groups.columns.some(c => c.name === 'name' && c._removed))
check('union preserves target order + ghosts', u.order.length === target.order.length + 1)

/* parser extension details on the synthetic source */
console.log('\n[3] parser extensions on synthetic source')
check('increment parsed', base.tables.users.columns[0].increment === true)
check('default parsed', base.tables.teams.columns[1].default === 'unnamed')
const IDX = `
Table t1 {
  a int4 [pk]
  b int4
  c int4
  Indexes {
    (b, c) [type: btree, name: "t1_b_c_key"]
    b [unique]
  }
}
`
const mi = parseDBML(IDX)
check('composite index cols', JSON.stringify(mi.tables.t1.indexes[0].cols) === '["b","c"]', JSON.stringify(mi.tables.t1.indexes))
check('index name', mi.tables.t1.indexes[0].name === 't1_b_c_key')
check('single index + unique flag', mi.tables.t1.indexes[1].cols[0] === 'b' && mi.tables.t1.indexes[1].unique === true)
check('columns after Indexes block intact', mi.tables.t1.columns.length === 3)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
