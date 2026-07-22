# Gabbro

**Git-native DBML studio — diagram, docs and diff for your database schema, versioned in git.**

## Why

Your database schema already lives in git as a [DBML](https://dbml.dbdiagram.io/docs) file —
Gabbro turns that repo into a studio: interactive diagram, browsable documentation and
branch-to-branch diff. Edits are commits: saving the DBML or dragging tables around pushes to
an edit branch (`develop` by default), so the schema history is just git history. No database,
no build step, one dependency (express).

- **Schema as code** — the DBML file in git is the source of truth; every change is a commit
- **Branches are environments** — keep `master` mirroring production and `develop` mirroring
  the dev database, then diff them visually
- **Layout out of the schema** — table positions live in `positions.json`, separate from the
  DBML, so schema diffs stay clean and layout changes never pollute them

## Features

- **Diagram tab** — interactive ER diagram: pan/zoom, drag tables, colored table groups,
  FK edges with orthogonal routing, hover highlight
- **Docs tab** — browsable documentation: index by table group, search, per-table sections
  with column types and PK/FK/NN/UQ badges, clickable "References" / "Referenced by"
- **Branch selector** — view the schema of any branch of the data repo
- **Structural diff** — pick base → target branches and see added (green), modified (yellow)
  and removed (red ghost) tables/columns/FKs, in both the diagram and the docs
- **View / Edit modes** — View is read-only for daily browsing; Edit opens a DBML editor and
  enables saving positions, both committing to the edit branch
- **Bootstrap** — pointed at a repo without the base files/branches, Gabbro creates `master` +
  `develop` with a starter DBML and an empty `positions.json` (add-only, never overwrites)

## Quick start (local)

```bash
npm install
GIT_REPO=/path/to/your/dbml-repo DATA_DIR=./data npm start
# open http://localhost:8080
```

On Windows PowerShell:

```powershell
$env:GIT_REPO = "C:\path\to\your\dbml-repo"; $env:DATA_DIR = "./data"; npm start
```

## Environment variables

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
| `GET /api/health` | `{ok, repoCloned, lastFetch}` — 503 if the repo init failed |
| `GET /api/config` | `{dbmlFile, editBranch, repoName}` |
| `GET /api/branches` | array of remote branch names |
| `GET /api/dbml/:branch` | DBML content (text/plain); 404 for unknown branch or file |
| `GET /api/positions` | positions.json from the edit branch (empty default if missing) |
| `PUT /api/dbml` | `{content, message?}` → commit + push to the edit branch |
| `PUT /api/positions` | positions object → commit + push to the edit branch |
| `POST /api/refresh` | force a git fetch |

## Edit mode & branch policy

Writes go **only** to the `EDIT_BRANCH` (`develop` by default) — the PUT endpoints take no
branch parameter, so committing to any other branch is not possible through the app. Every
other branch is read-only. Positions are also read from the edit branch regardless of the
branch being viewed: layout is presentation, not schema, so all branches render with the
same coordinates.

> **Security: Gabbro has no authentication of its own.** Anyone with network access to the
> app can read the schema and commit to the edit branch. Run it on an internal network, or
> put it behind a reverse proxy that handles authentication (basic auth, OAuth proxy, VPN).
> Do not expose it directly to the public internet with a write token configured.

The `GIT_TOKEN` is passed via env; it is written to the clone's remote URL inside the
container volume, and never logged. Use a token scoped to the data repo only, with the
minimum role that allows pushing.

## Docker

```bash
docker build -t gabbro .
docker run -d --name gabbro -p 8080:8080 \
  -e GIT_REPO=https://gitlab.com/you/your-db-repo.git \
  -e GIT_TOKEN=xxxx \
  gabbro
```

## Deploy (Dokploy)

Mode **Application (Dockerfile)**:

1. Source: this repo on GitHub, build type Dockerfile.
2. Set the env vars above (`GIT_REPO`, `GIT_TOKEN`, optionally `PORT`).
3. In **Domains**, set **Container Port = `PORT`** (same value).

The container has a HEALTHCHECK on `/api/health` (fails if the repo init failed). An
optional volume on `DATA_DIR` (`/data`) keeps the clone across restarts; without it, the
container re-clones on boot.

> **Bad Gateway (502)?** Port mismatch: Dokploy's Container Port differs from `PORT`.
> Align both — the port is internal to the container.

## Utilities

### Seeding positions from StarUML

```bash
node scripts/mdj-to-positions.js --mdj Doc.mdj --out positions.json [--scale-x 1]
```

Extracts entity coordinates from a StarUML `.mdj` ERD into the `positions.json` schema, so a
diagram that used to live in StarUML keeps its familiar layout.

## License

[MIT](LICENSE)
