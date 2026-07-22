# Changelog

## 0.3.0 — 2026-07-22

App desktop.

- **Electron** — instalável Windows (NSIS; Mac/Linux configurados no build). O main sobe o
  backend numa porta livre em 127.0.0.1 e abre a janela na mesma origem. Primeira execução
  sem repo salvo abre o seletor nativo de pasta.
- **Auto-update** — `electron-updater` lendo o GitHub Releases do repo (público, sem token):
  checa no boot e a cada 3h, baixa em background e mostra banner "Restart to update";
  instalação silenciosa no restart.
- **Picker nativo** — botão Browse… no repo switcher quando rodando no desktop.
- Limpeza de comentários no código (só o não-óbvio fica).

## 0.2.0 — 2026-07-22

Local-first release: Gabbro agora roda na máquina de cada pessoa, apontado pro clone dela.

- **Modo local** — `node bin/gabbro.js [path]` abre o app direto no clone do usuário (sem
  clone intermediário). Commits com a identidade git do usuário; push/pull com a credencial
  do sistema (credential helper/SSH) — o app nunca guarda token no modo local. Detecção
  automática de modo (URL https → hosted, path com `.git/` → local; override `GABBRO_MODE`).
- **Edição na branch checked-out** — commit só na branch ativa do clone; PUT exige `branch`
  e retorna 409 em divergência ou detached HEAD. Demais branches somente leitura.
- **Leitor puro sem identidade** — sem `user.name`/`user.email`, View/Docs/Diff/History
  funcionam por completo; edição bloqueada com banner (422 no server). Nunca identidade fake.
- **Aba History** — commits que tocaram `database.dbml`/`positions.json`, paginados, com
  diff estrutural por commit (vs pai) renderizado nas abas Diagram e Docs; prefill da
  mensagem de commit no Save a partir do resumo do diff.
- **Sync** — botão que faz `pull --rebase --autostash` (com guarda anti rebase pela metade)
  e push com auto-cura de non-fast-forward (máx 3); erros classificados
  (`no-remote`/`auth`/`diverged`/`timeout`) com fix sugerido; badge ahead/behind na toolbar;
  push pós-save em background coalescido com warning em caso de falha.
- **Banner de worktree sujo** — mudança externa não commitada nos arquivos rastreados é
  sinalizada; save nesse estado incorpora a mudança ao commit com aviso, nunca em silêncio.
- **Repo switcher** — repos recentes em `~/.gabbro/settings.json`; `gabbro <path>` com
  instância aberta troca o repo da instância (`PUT /api/repo`) em vez de subir outra.
- **Segurança do modo local** — bind exclusivo em `127.0.0.1`, rejeição de `Host`
  não-loopback (anti DNS-rebinding) e de `Origin` não-loopback em escritas (anti CSRF);
  `GIT_TERMINAL_PROMPT=0` global (falha rápida em vez de prompt pendurado); rotas de history
  validam hash/branch/file.
- **Hosted v1 sem regressão** — o caminho Docker/Dokploy (envs `GIT_REPO` URL + `GIT_TOKEN`)
  segue funcionando sem mudanças.

## 0.1.0 — 2026-07-22

Primeira versão: viewer/editor DBML git-backed.

- Aba **Diagram** (ER interativo: pan/zoom, drag, grupos coloridos, FKs ortogonais) e aba
  **Docs** (índice por grupo, busca, badges PK/FK/NN/UQ, referências clicáveis).
- Seletor de branch + **diff estrutural** entre branches (adicionado/modificado/removido no
  diagrama e na documentação).
- Modos View/Edit com escrita restrita à `EDIT_BRANCH` (commit + push como identidade de
  serviço); bootstrap add-only de `master`/`develop` em repo vazio.
- `positions.json` separado do DBML (layout fora do schema) + seed a partir de ERD StarUML
  (`scripts/mdj-to-positions.js`).
- Docker/Dokploy: Dockerfile com HEALTHCHECK em `/api/health`, clone persistível em
  `DATA_DIR`.
