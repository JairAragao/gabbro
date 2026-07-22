'use strict'

const path = require('path')

const env = process.env

const gitRepo = env.GIT_REPO || ''
if (!gitRepo) {
  console.error('GIT_REPO env var is required (https URL or local filesystem path)')
  process.exit(1)
}

// Local filesystem repos (dev) need no token; remote https repos usually do.
const isLocalRepo = !/^https?:\/\//i.test(gitRepo)

module.exports = {
  port: parseInt(env.PORT, 10) || 8080,
  gitRepo,
  isLocalRepo,
  gitToken: env.GIT_TOKEN || '',
  dbmlFile: env.DBML_FILE || 'database.dbml',
  positionsFile: 'positions.json',
  editBranch: env.EDIT_BRANCH || 'develop',
  fetchTtlMs: parseInt(env.GIT_FETCH_TTL_MS, 10) || 60000,
  dataDir: path.resolve(env.DATA_DIR || '/data'),
  gitUserName: env.GIT_USER_NAME || 'gabbro',
  gitUserEmail: env.GIT_USER_EMAIL || 'gabbro@local',
  repoName: (gitRepo.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo').replace(/\.git$/, '')
}
