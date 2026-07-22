async function request (path, opts, attempt = 0) {
  let res
  try {
    res = await fetch(path, opts)
  } catch (e) {
    throw new Error('server unreachable')
  }
  // 503 while the server is still cloning the repo on boot — wait and retry.
  if (res.status === 503 && attempt < 5) {
    await new Promise(r => setTimeout(r, 1500))
    return request(path, opts, attempt + 1)
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`
    try { const j = await res.json(); if (j && j.error) msg = j.error } catch (e) { /* non-json error body */ }
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return res
}

const json = async (path, opts) => (await request(path, opts)).json()
const text = async (path, opts) => (await request(path, opts)).text()
const send = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})
const put = body => send('PUT', body)

export const getConfig = () => json('/api/config')
export const getBranches = () => json('/api/branches')
export const getDbml = branch => text(`/api/dbml/${encodeURIComponent(branch)}`)
export const getPositions = () => json('/api/positions')
// Local mode requires `branch` in the body (the branch being edited) — the
// server answers 409 when it no longer matches the checked-out branch.
export const putDbml = (content, message, branch) =>
  json('/api/dbml', put(branch ? { content, message, branch } : { content, message }))
export const putPositions = (obj, branch) =>
  json('/api/positions', put(branch ? { ...obj, branch } : obj))
export const refresh = () => json('/api/refresh', { method: 'POST' })

export const sync = () => json('/api/sync', { method: 'POST' })
export const getSyncState = () => json('/api/sync-state')
export const getRepo = () => json('/api/repo')
export const putRepo = path => json('/api/repo', put({ path }))

export const getHistory = (skip, limit) =>
  json(`/api/history?skip=${skip | 0}&limit=${limit | 0}`)
export const getCommit = hash => json(`/api/commit/${encodeURIComponent(hash)}`)
export const getCommitDiff = hash => text(`/api/commit/${encodeURIComponent(hash)}/diff`)
