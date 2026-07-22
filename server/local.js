'use strict'

// Local-mode git operations: the server works directly on the user's clone,
// with the user's own identity, credentials and checked-out branch. Patterns
// ported from basalt/server/git.js to plain execFile (no simple-git).

const { git } = require('./git')

function oneLine (s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
}

// Effective user.name/user.email (local > global). null per missing field —
// NEVER a hardcoded fallback (attribution must be real).
async function getIdentity () {
  let name = null
  let email = null
  try { name = (await git(['config', '--get', 'user.name'])).trim() || null } catch { name = null }
  try { email = (await git(['config', '--get', 'user.email'])).trim() || null } catch { email = null }
  return { name, email }
}

// Throws 422 when the repo has no usable identity — the route surfaces the fix.
async function ensureIdentity () {
  const id = await getIdentity()
  if (!id.name || !id.email) {
    const e = new Error('git identity not configured — run: git config --global user.name "Your Name" && git config --global user.email "you@example.com"')
    e.status = 422
    throw e
  }
  return id
}

// Checked-out branch name, or null when HEAD is detached. symbolic-ref (not
// rev-parse) so an unborn branch in a fresh repo still resolves to its name.
async function currentBranch () {
  try {
    return (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null
  } catch {
    return null
  }
}

async function isDetached () {
  return (await currentBranch()) === null
}

module.exports = {
  oneLine,
  getIdentity,
  ensureIdentity,
  currentBranch,
  isDetached
}
