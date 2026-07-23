#!/usr/bin/env node
'use strict'

// If the port already answers as a running gabbro, just open the browser on
// that instance — two processes on the same clone would race over the git index.

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const settings = require('../server/settings')

const arg = process.argv[2]
if (arg === '--help' || arg === '-h') {
  console.log('uso: gabbro [caminho-do-repo]\n\nAbre o estúdio DBML Gabbro num clone git local.\nSem caminho, reusa o último repo aberto (ou a env GIT_REPO).')
  process.exit(0)
}
if (arg) {
  const abs = path.resolve(arg)
  if (!fs.existsSync(path.join(abs, '.git'))) {
    console.error(`não é um repositório git (sem .git): ${abs}`)
    process.exit(1)
  }
  // config.js gives the CLI arg top priority via this env var.
  process.env.GABBRO_REPO = abs
}

const cfg = require('../server/config') // exits with a clear message if nothing resolves
const url = `http://127.0.0.1:${cfg.port}/`

function openBrowser (u) {
  if (process.env.GABBRO_NO_OPEN) return
  const p = process.platform
  const child = p === 'win32'
    ? spawn('cmd', ['/c', 'start', '', u], { stdio: 'ignore', detached: true })
    : spawn(p === 'darwin' ? 'open' : 'xdg-open', [u], { stdio: 'ignore', detached: true })
  child.unref()
}

// True when the port answers like a gabbro API (200 ready or 503 initializing).
async function gabbroAlive () {
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(1500) })
    const j = await r.json().catch(() => null)
    return !!j && typeof j.ok === 'boolean'
  } catch {
    return false
  }
}

async function main () {
  if (await gabbroAlive()) {
    // If the user asked for a specific repo, switch the running instance to it
    // instead of silently opening whatever it currently shows.
    if (process.env.GABBRO_REPO) {
      try {
        const r = await fetch(`http://127.0.0.1:${cfg.port}/api/repo`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: process.env.GABBRO_REPO }),
          signal: AbortSignal.timeout(5000)
        })
        if (!r.ok) {
          const j = await r.json().catch(() => null)
          console.error(`não consegui trocar a instância aberta para ${process.env.GABBRO_REPO}: ${(j && j.error) || r.status}`)
        }
      } catch (e) {
        console.error(`não consegui trocar a instância aberta: ${e.message}`)
      }
    }
    console.log(`gabbro já rodando na :${cfg.port} — abrindo o navegador`)
    openBrowser(url)
    return
  }
  if (cfg.mode === 'local') settings.rememberRepo(cfg.repoDir())
  require('../server/index')
  for (let i = 0; i < 40; i++) {
    if (await gabbroAlive()) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  openBrowser(url)
}

main()
