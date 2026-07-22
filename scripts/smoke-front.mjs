// Frontend smoke checks, runnable in plain node (no browser):
//   node scripts/smoke-front.mjs [path-to-large.dbml] [path-to-git-clone]
// Validates parser.js (incl. increment/default/Indexes extensions), diff.js
// (all six structural change kinds + summary line), history.js pure helpers,
// and — when a git clone is given — the history flow (commit vs parent via
// parseDBML+diffModels over real commits). All modules must stay DOM-free.

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseDBML } from '../public/js/parser.js'
import { diffModels, diffSummary, diffSummaryLine, buildUnionModel } from '../public/js/diff.js'
import { normalizeHistory, relativeTime, firstLine } from '../public/js/history.js'

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

/* ---------- 4. history helpers: payload parse + summary line ---------- */
console.log('\n[4] history payload parse + diff summary line')
const payload = {
  commits: [
    {
      hash: 'a'.repeat(40),
      shortHash: 'aaaaaaa',
      date: '2026-07-22T10:00:00-03:00',
      authorName: 'Jair',
      authorEmail: 'jair@example.com',
      message: 'docs(dbml): add mrp tables\n\nbody line',
      files: ['database.dbml', 'positions.json']
    },
    { hash: 'b'.repeat(40), message: 'chore(positions): update via gabbro' }
  ],
  hasMore: true
}
const nh = normalizeHistory(payload)
check('payload: commits kept', nh.commits.length === 2)
check('payload: hasMore kept', nh.hasMore === true)
check('payload: fields preserved', nh.commits[0].authorName === 'Jair' &&
  nh.commits[0].shortHash === 'aaaaaaa' && nh.commits[0].files.length === 2)
check('payload: shortHash derived when missing', nh.commits[1].shortHash === 'bbbbbbb')
check('payload: missing fields defaulted', nh.commits[1].files.length === 0 && nh.commits[1].authorName === '')
const bad = normalizeHistory({ commits: [null, {}, { hash: 42 }], hasMore: 'yes' })
check('payload: malformed entries dropped', bad.commits.length === 0 && bad.hasMore === true)
check('payload: garbage input safe', normalizeHistory(null).commits.length === 0)
check('firstLine takes first line', firstLine(payload.commits[0].message) === 'docs(dbml): add mrp tables')
const now = new Date('2026-07-22T14:00:00-03:00').getTime()
check('relativeTime hours', relativeTime('2026-07-22T10:00:00-03:00', now) === '4h ago')
check('relativeTime bad date falls back', relativeTime('not-a-date', now) === 'not-a-date')

check('summary line +/~/-', diffSummaryLine(d) === '+1 table, ~2 changed, -1 removed', diffSummaryLine(d))
check('summary line empty diff', diffSummaryLine(diffModels(base, base)) === '')

/* ---------- 5. history flow over real commits (needs a clone path) ---------- */
const repoPath = process.argv[3]
if (repoPath) {
  console.log(`\n[5] history diff over real commits: ${repoPath}`)
  const git = args => execFileSync('git', args, { cwd: repoPath, maxBuffer: 64 * 1024 * 1024 }).toString()
  const FILE = 'database.dbml'
  const hashes = git(['log', '--format=%H', '--', FILE]).split('\n').filter(Boolean)
  check('>= 2 commits touching the dbml', hashes.length >= 2, `got ${hashes.length}`)

  // (a) file-creation commit: parent has no dbml → parseDBML('') → every table added
  const firstHash = hashes[hashes.length - 1]
  const firstContent = git(['show', `${firstHash}:${FILE}`])
  const firstModel = parseDBML(firstContent)
  const creation = diffModels(parseDBML(''), firstModel)
  const allAdded = Object.values(creation.tables).every(t => t.status === 'added')
  check('creation commit: parent empty → all tables added',
    firstModel.order.length > 0 && allAdded &&
    Object.keys(creation.tables).length === firstModel.order.length)
  check('creation commit: summary line says +N tables',
    diffSummaryLine(creation) === `+${firstModel.order.length} tables`, diffSummaryLine(creation))

  // (b) newest commit vs its parent — statuses cross-checked against set
  // membership computed independently from the two parsed models
  const newest = hashes[0]
  let parentContent = ''
  try { parentContent = git(['show', `${newest}^:${FILE}`]) } catch { parentContent = '' }
  const pm = parseDBML(parentContent)
  const cm = parseDBML(git(['show', `${newest}:${FILE}`]))
  const dd = diffModels(pm, cm)
  const pSet = new Set(pm.order), cSet = new Set(cm.order)
  let statusesOk = true
  for (const [nm, t] of Object.entries(dd.tables)) {
    const expected = !pSet.has(nm) ? 'added' : !cSet.has(nm) ? 'removed' : null
    if (expected && t.status !== expected) { statusesOk = false; break }
    if (!['added', 'removed', 'modified', 'same'].includes(t.status)) { statusesOk = false; break }
  }
  check('newest commit vs parent: statuses consistent with parsed models', statusesOk)
  check('identity diff is all same',
    Object.values(diffModels(cm, cm).tables).every(t => t.status === 'same'))

  // (c) two distinct real commits: every membership difference is flagged
  const older = hashes[Math.min(hashes.length - 1, 1)]
  const om = parseDBML(git(['show', `${older}:${FILE}`]))
  const od = diffModels(om, cm)
  const oSet = new Set(om.order)
  const addedExpected = cm.order.filter(t => !oSet.has(t))
  const removedExpected = om.order.filter(t => !cSet.has(t))
  const s2 = diffSummary(od)
  check('cross-commit: added tables detected exactly',
    JSON.stringify(s2.added) === JSON.stringify([...addedExpected].sort()),
    `expected ${addedExpected.length}, got ${s2.added.length}`)
  check('cross-commit: removed tables detected exactly',
    JSON.stringify(s2.removed) === JSON.stringify([...removedExpected].sort()),
    `expected ${removedExpected.length}, got ${s2.removed.length}`)
} else {
  console.log('\n[5] real-commit history check skipped (no clone path argument)')
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
