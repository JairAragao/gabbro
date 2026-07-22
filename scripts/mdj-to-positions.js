#!/usr/bin/env node
'use strict'

// StarUML .mdj → positions.json seed for Gabbro.
// Usage: node mdj-to-positions.js --mdj <Doc.mdj> --out <positions.json> [--scale-x 1]

const fs = require('fs')

function parseArgs (argv) {
  const args = { 'scale-x': '1' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i]
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.mdj || !args.out) {
  console.error('Usage: node mdj-to-positions.js --mdj <path> --out <positions.json> [--scale-x 1]')
  process.exit(1)
}
const scaleX = parseFloat(args['scale-x'])
if (!Number.isFinite(scaleX) || scaleX <= 0) {
  console.error('--scale-x must be a positive number')
  process.exit(1)
}

const mdj = JSON.parse(fs.readFileSync(args.mdj, 'utf8'))

function walk (node, fn) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach(n => walk(n, fn))
  fn(node)
  for (const k of Object.keys(node)) walk(node[k], fn)
}

const entities = {} // _id -> table name
walk(mdj, n => {
  if (n._type === 'ERDEntity' && n._id && n.name) entities[n._id] = n.name
})

const views = [] // {name, left, top}
let orphans = 0
walk(mdj, n => {
  if (n._type !== 'ERDEntityView') return
  const ref = n.model && n.model.$ref
  const name = ref && entities[ref]
  if (!name) { orphans++; return }
  if (typeof n.left !== 'number' || typeof n.top !== 'number') { orphans++; return }
  views.push({ name, left: n.left, top: n.top })
})

if (views.length === 0) {
  console.error('No ERDEntityView with resolvable model found in the .mdj')
  process.exit(1)
}

const minLeft = Math.min(...views.map(v => v.left))
const minTop = Math.min(...views.map(v => v.top))
const MARGIN = 40

const tables = {}
let dupes = 0
for (const v of views) {
  if (tables[v.name]) { dupes++; continue } // keep the first view per entity
  tables[v.name] = {
    x: Math.round((v.left - minLeft) * scaleX) + MARGIN,
    y: Math.round(v.top - minTop) + MARGIN
  }
}

const out = { version: 1, updated_at: new Date().toISOString(), tables }
fs.writeFileSync(args.out, JSON.stringify(out, null, 2) + '\n')

console.log(`entities: ${Object.keys(entities).length}, views: ${views.length}, ` +
  `orphan views discarded: ${orphans}, duplicate views skipped: ${dupes}`)
console.log(`wrote ${Object.keys(tables).length} table positions to ${args.out}`)
