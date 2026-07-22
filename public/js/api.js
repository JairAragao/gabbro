// Thin fetch wrappers over the Gabbro server API.

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
const put = body => ({
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

export const getConfig = () => json('/api/config')
export const getBranches = () => json('/api/branches')
export const getDbml = branch => text(`/api/dbml/${encodeURIComponent(branch)}`)
export const getPositions = () => json('/api/positions')
export const putDbml = (content, message) => json('/api/dbml', put({ content, message }))
export const putPositions = obj => json('/api/positions', put(obj))
export const refresh = () => json('/api/refresh', { method: 'POST' })
