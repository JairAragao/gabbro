# Gabbro

**Git-native DBML studio — diagram, docs, diff and history for your database schema, straight from git.**

🇧🇷 *Leia em [português](README.md).*

## Why

Your database schema already lives in git as a [DBML](https://dbml.dbdiagram.io/docs) file —
Gabbro turns that repo into a studio: interactive diagram, browsable documentation,
structural branch-to-branch diff and commit-by-commit history. It is **local-first**: each
person runs Gabbro on their own machine, pointed at their own clone. Edits become commits
**authored by the user's git identity**, and push/pull use whatever credential the system git
already has — attribution and access control are git's / your provider's, no auth stack of
its own. No database, no build step, one dependency (express).

- **Schema as code** — the DBML file in git is the source of truth; every change is a commit
- **Branches are environments** — keep `master` mirroring production and `develop` mirroring
  the dev database, then diff them visually
- **Layout out of the schema** — table positions live in `positions.json`, separate from the
  DBML, so schema diffs stay clean and layout changes never pollute them
- **Multi-user without a server** — each dev runs locally on their clone; the shared history
  (with per-person authors) is simply the git remote

## Quick start

```bash
git clone https://github.com/JairAragao/gabbro.git && cd gabbro && npm install
node bin/gabbro.js /path/to/your/dbml-clone
```

The app listens on `http://127.0.0.1:8080` and opens the browser. Without an argument it
reopens the last used repo. `npx gabbro` (npm-published package) is on the roadmap — for now
it is `node bin/gabbro.js`.

On Windows:

```powershell
node bin\gabbro.js C:\path\to\your\dbml-clone
```

The path must be an **existing git clone** (with a `.git/` dir) — Gabbro never clones
anything in local mode, it operates directly on your working tree.

## How it works (local mode)

**Identity and credentials are yours — the app never stores a token.** Commits use the
clone's effective `git config user.name`/`user.email`; push and pull use the system's
credential helper or SSH key, exactly like git on the terminal. In local mode there is no
password field, no token, no account: if your git can push, Gabbro can push.

**No identity configured → pure reader.** On a machine without `user.name`/`user.email`,
Diagram, Docs, Diff and History all work; only editing is blocked, with a banner showing the
`git config` command that fixes it (the server also rejects writes with 422).

**Editing always targets the checked-out branch.** Commits land on the clone's currently
active branch — the app never switches branches or checks anything out. Every other branch is
read-only (`git show`). If the clone's branch changes externally while the editor is open,
saving returns **409** and asks for a reload; detached HEAD also blocks editing.

**Sync.** Saving commits immediately and pushes in the background (best-effort, with a
warning if it fails). The **Sync** button runs `pull --rebase --autostash` (guarded against
half-finished rebases) then pushes with non-fast-forward self-healing (up to 3 attempts).
Failures come back classified (`no-remote` / `auth` / `diverged` / `timeout`) with a
suggested fix. A toolbar badge shows commits ahead/behind the upstream.

**Dirty worktree.** If `database.dbml` or `positions.json` have uncommitted changes made
outside the app (e.g. a DBML generator ran on the clone), a banner warns you; saving in that
state folds the change into the commit — with a warning, never silently.

**Repo switching.** The toolbar remembers recent repos (`~/.gabbro/settings.json`);
running `gabbro <another-path>` while an instance is open switches that instance's repo
instead of starting a second one.

**Local-mode security.** The server binds to `127.0.0.1` only and rejects requests with a
non-loopback `Host` header (anti DNS-rebinding) and writes with a non-loopback `Origin`
(anti CSRF). It is still an unauthenticated app: do not expose the port to the network.

## Features

- **Diagram tab** — interactive ER diagram: pan/zoom, drag tables, colored table groups,
  FK edges with orthogonal routing, hover highlight
- **Docs tab** — browsable documentation: index by table group, search, per-table sections
  with column types and PK/FK/NN/UQ badges, clickable "References" / "Referenced by"
- **History tab** — paginated list of the commits that touched the schema (author, date,
  message); clicking a commit renders the **structural diff vs its parent** in the Diagram
  and Docs tabs. History always follows the checked-out branch (local mode) / edit branch
  (hosted mode). Save also prefills the commit message from the diff summary.
- **Branch selector** — view the schema of any branch of the data repo
- **Structural branch diff** — pick base → target and see added (green), modified (yellow)
  and removed (red ghost) tables/columns/FKs, in both the diagram and the docs
- **View / Edit modes** — View is read-only for daily browsing; Edit opens the DBML editor
  and enables saving positions

## Hosted mode (optional)

The same codebase also runs as a central service: with `GIT_REPO` set to an **https URL**,
Gabbro clones the repo into `DATA_DIR`, commits as a service identity
(`GIT_USER_NAME`/`GIT_USER_EMAIL`) and writes **only** to `EDIT_BRANCH` — the PUT endpoints
take no branch in this mode. Pointed at an empty repo, it bootstraps `master` + `develop`
with a starter DBML (add-only, never overwrites).

| Var | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port (both modes) |
| `GIT_REPO` | — | https URL of the data repo (a local path with `.git/` enables local mode) |
| `GIT_TOKEN` | — | write token for https repos (GitLab/GitHub) |
| `DBML_FILE` | `database.dbml` | DBML file name inside the repo |
| `EDIT_BRANCH` | `develop` | branch that receives commits (other branches are read-only) |
| `GIT_FETCH_TTL_MS` | `60000` | max age of the local fetch before refetching |
| `DATA_DIR` | `/data` | where the managed clone lives |
| `GIT_USER_NAME` | `gabbro` | committer name (hosted) |
| `GIT_USER_EMAIL` | `gabbro@local` | committer email (hosted) |
| `GABBRO_MODE` | auto | force `hosted` or `local`, overriding detection |

> **Security: hosted mode has no authentication.** Anyone with network access to the app can
> read the schema and commit to the edit branch — all commits carry the service identity.
> Run it on an internal network, or behind a reverse proxy that handles authentication
> (basic auth, OAuth proxy, VPN). Do not expose it to the public internet with a write token
> configured. The `GIT_TOKEN` is written to the clone's remote URL inside the container
> volume and never logged.

```bash
docker build -t gabbro .
docker run -d --name gabbro -p 8080:8080 \
  -e GIT_REPO=https://gitlab.com/you/your-db-repo.git \
  -e GIT_TOKEN=xxxx \
  gabbro
```

On Dokploy: Application (Dockerfile), the env vars above, **Container Port = `PORT`**. The
container has a HEALTHCHECK on `/api/health`; an optional volume on `DATA_DIR` keeps the
clone across restarts.

> **Note:** on a machine that has used local mode, the repo saved in `~/.gabbro/settings.json`
> takes priority over `GIT_REPO`. To debug hosted mode there, export `GABBRO_MODE=hosted`
> (irrelevant in a container, where the settings file does not exist).

## API

| Endpoint | Mode | Description |
|---|---|---|
| `GET /api/health` | both | `{ok, repoCloned, lastFetch}` — 503 if repo init failed |
| `GET /api/config` | both | `{mode, dbmlFile, editBranch, repoName, repoPath, identity, currentBranch, readOnly}` |
| `GET /api/branches` | both | array of branch names |
| `GET /api/dbml/:branch` | both | DBML content (text/plain); 404 for unknown branch or file |
| `GET /api/positions` | both | positions.json — current-branch worktree (local) / edit branch (hosted) |
| `PUT /api/dbml` | both | `{content, message?, branch*}` → commit; `branch` required in local mode (409 if ≠ current) |
| `PUT /api/positions` | both | positions object (+ `branch*` in local mode) → commit |
| `POST /api/refresh` | both | force a git fetch |
| `GET /api/history` | both | `?skip&limit&file&branch` → page of commits touching the tracked files |
| `GET /api/commit/:hash` | both | `?file` → `{content, parentContent, meta}` for the commit's structural diff |
| `GET /api/commit/:hash/diff` | both | `?file` → unified text diff |
| `POST /api/sync` | local | pull --rebase + push with self-healing; classified result with fix |
| `GET /api/sync-state` | local | `{branch, detached, ahead, behind, hasUpstream, pushWarning, dirty}` |
| `GET /api/repo` | both | current repo (+ recents in local mode; hosted never exposes paths) |
| `PUT /api/repo` | local | `{path}` → switch the instance to another existing clone |

## Utilities

### Seeding positions from StarUML

```bash
node scripts/mdj-to-positions.js --mdj Doc.mdj --out positions.json [--scale-x 1]
```

Extracts entity coordinates from a StarUML `.mdj` ERD into the `positions.json` schema, so a
diagram that used to live in StarUML keeps its familiar layout.

## License

[MIT](LICENSE)
