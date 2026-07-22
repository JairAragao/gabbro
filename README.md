# Gabbro

**Git-native DBML studio — diagram, docs and diff for your database schema, versioned in git.**

## Why

Your database schema already lives in git as a [DBML](https://dbml.dbdiagram.io/docs) file —
Gabbro turns that repo into a studio: interactive diagram, browsable documentation and
branch-to-branch diff. Edits are commits: saving the DBML or dragging tables around pushes to
an edit branch (`develop` by default), so the schema history is just git history. No database,
no build step, one dependency (express).

- Reads any git repo containing a DBML file (`GIT_REPO` — https URL or local path)
- Bootstrap: if the repo lacks the base files/branches, Gabbro creates `master` + `develop`
  with a starter DBML and an empty `positions.json` (add-only, never overwrites)
- Table positions live in `positions.json`, separate from the schema — DBML diffs stay clean

## Quick start (local)

```bash
npm install
GIT_REPO=/path/to/your/dbml-repo DATA_DIR=./data npm start
# open http://localhost:8080
```

## Environment vars

| Var | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `GIT_REPO` | — (required) | https URL or local filesystem path of the data repo |
| `GIT_TOKEN` | — | write token for https repos (GitLab/GitHub); not needed for local paths |
| `DBML_FILE` | `database.dbml` | DBML file name inside the repo |
| `EDIT_BRANCH` | `develop` | branch that receives commits (other branches are read-only) |
| `GIT_FETCH_TTL_MS` | `60000` | max age of the local fetch before refetching |
| `DATA_DIR` | `/data` | where the clone lives (use `./data` for local dev) |
| `GIT_USER_NAME` | `gabbro` | committer name |
| `GIT_USER_EMAIL` | `gabbro@local` | committer email |

## API

| Endpoint | Description |
|---|---|
| `GET /api/health` | `{ok, repoCloned, lastFetch}` |
| `GET /api/config` | `{dbmlFile, editBranch, repoName}` |
| `GET /api/branches` | array of remote branch names |
| `GET /api/dbml/:branch` | DBML content (text/plain) |
| `GET /api/positions` | positions.json from the edit branch (empty default if missing) |
| `PUT /api/dbml` | `{content, message?}` → commit + push to the edit branch |
| `PUT /api/positions` | positions object → commit + push to the edit branch |
| `POST /api/refresh` | force a git fetch |

## Docker

```bash
docker build -t gabbro .
docker run -d --name gabbro -p 8080:8080 \
  -e GIT_REPO=https://gitlab.com/you/your-db-repo.git \
  -e GIT_TOKEN=xxxx \
  gabbro
```

The token goes in via env; it is written to the clone's remote URL inside the container
volume, and never logged.

## Deploy (Dokploy)

Mode **Application (Dockerfile)**:

1. Source: this repo on GitHub, build type Dockerfile.
2. Set the env vars above (`GIT_REPO`, `GIT_TOKEN`, optionally `PORT`).
3. In **Domains**, set **Container Port = `PORT`** (same value).

> **Bad Gateway (502)?** Port mismatch: Dokploy's Container Port differs from `PORT`.
> Align both — the port is internal to the container.

## Seeding positions from StarUML

```bash
node scripts/mdj-to-positions.js --mdj Doc.mdj --out positions.json [--scale-x 1]
```

Extracts entity coordinates from a StarUML `.mdj` ERD into the `positions.json` schema, so a
diagram that used to live in StarUML keeps its familiar layout.
