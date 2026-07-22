# Gabbro

**Estúdio DBML git-native — diagrama, documentação, diff e histórico do schema do seu banco, direto do git.**

🌎 *Read this in [English](README.en.md).*

## Por quê

O schema do seu banco já vive no git como um arquivo [DBML](https://dbml.dbdiagram.io/docs) —
o Gabbro transforma esse repo num estúdio: diagrama interativo, documentação navegável, diff
estrutural entre branches e histórico commit a commit. É **local-first**: cada pessoa roda o
Gabbro na própria máquina, apontando pro próprio clone. Edições viram commits **com o autor
git do usuário**, e push/pull usam a credencial que o git do sistema já tem — atribuição e
controle de acesso são os do git/provedor, sem stack de autenticação própria. Sem banco
próprio, sem build step, uma dependência só (express).

- **Schema como código** — o arquivo DBML no git é a fonte da verdade; toda mudança é um commit
- **Branches são ambientes** — mantenha a `master` espelhando produção e a `develop` espelhando
  o banco de desenvolvimento, e compare as duas visualmente
- **Layout fora do schema** — as posições das tabelas vivem no `positions.json`, separado do
  DBML, então o diff do schema fica limpo e mudança de layout nunca polui o histórico
- **Multi-usuário sem servidor** — cada dev roda local no seu clone; o histórico compartilhado
  (com autor por pessoa) é simplesmente o remoto git

## Início rápido

```bash
# dentro de um clone deste repo
npm install
node bin/gabbro.js /caminho/do/seu/clone-dbml
```

O app sobe em `http://127.0.0.1:8080` e abre o browser. Sem argumento, reabre o último repo
usado. `npx gabbro` (pacote publicado no npm) está no roadmap — por enquanto é
`node bin/gabbro.js`.

No Windows:

```powershell
node bin\gabbro.js C:\caminho\do\seu\clone-dbml
```

O caminho precisa ser um **clone git existente** (com `.git/`) — o Gabbro nunca clona nada no
modo local, ele opera direto no seu working tree.

## Como funciona (modo local)

**Identidade e credencial são as suas — o app nunca guarda token.** Commits usam o
`git config user.name`/`user.email` efetivo do clone; push e pull usam o credential helper ou
chave SSH do sistema, exatamente como o git no terminal. No modo local não existe campo de
senha, token nem conta: se o seu git consegue pushar, o Gabbro consegue.

**Sem identidade configurada, vira leitor puro.** Numa máquina sem `user.name`/`user.email`,
Diagram, Docs, Diff e History funcionam 100%; só a edição fica bloqueada, com um banner
explicando o `git config` que resolve (o servidor também recusa a escrita com 422).

**Edição sempre na branch checked-out.** O commit cai na branch atualmente ativa do clone —
o app nunca troca de branch nem faz checkout. As demais branches são somente leitura
(`git show`). Se a branch do clone mudar por fora enquanto o editor está aberto, o save
retorna **409** e pede reload; detached HEAD também bloqueia edição.

**Sync.** Salvar commita na hora e pusha em background (best-effort, com aviso se falhar).
O botão **Sync** faz `pull --rebase --autostash` (com guarda contra rebase pela metade) e
push com auto-cura de non-fast-forward (até 3 tentativas). Falhas voltam classificadas
(`no-remote` / `auth` / `diverged` / `timeout`) com o fix sugerido. Um badge na toolbar mostra
commits ahead/behind do upstream.

**Worktree sujo.** Se `database.dbml` ou `positions.json` tiverem mudança não commitada feita
fora do app (ex.: um gerador de DBML rodou no clone), um banner avisa; um save nesse estado
incorpora a mudança ao commit — com aviso, nunca em silêncio.

**Troca de repo.** A toolbar lembra os repos recentes (`~/.gabbro/settings.json`);
`gabbro <outro-caminho>` com uma instância já aberta troca o repo da instância em vez de subir
outra.

**Segurança do modo local.** O servidor escuta só em `127.0.0.1` e rejeita requests com
header `Host` não-loopback (anti DNS-rebinding) e escritas com `Origin` não-loopback
(anti CSRF). Ainda assim é um app sem autenticação: não exponha a porta pra rede.

## Funcionalidades

- **Aba Diagram** — diagrama ER interativo: pan/zoom, arrastar tabelas, grupos coloridos,
  arestas de FK com roteamento ortogonal, destaque de relações no hover
- **Aba Docs** — documentação navegável: índice por grupo de tabelas, busca, seção por tabela
  com tipos de coluna e badges PK/FK/NN/UQ, "References" / "Referenced by" clicáveis
- **Aba History** — histórico de commits que tocaram o schema (autor, data, mensagem), com
  paginação; clicar num commit renderiza o **diff estrutural vs o commit pai** nas abas
  Diagram e Docs. O histórico é sempre da branch checked-out (modo local) / branch de edição
  (modo hosted). O Save também sugere a mensagem de commit a partir do resumo do diff.
- **Seletor de branch** — veja o schema de qualquer branch do repo de dados
- **Diff estrutural entre branches** — escolha base → target e veja tabelas/colunas/FKs
  adicionadas (verde), modificadas (amarelo) e removidas (fantasma vermelho), no diagrama e
  na documentação
- **Modos View / Edit** — View é somente leitura pro dia a dia; Edit abre o editor de DBML e
  habilita salvar posições

## Modo hosted (opcional)

O mesmo codebase também roda como serviço central: com `GIT_REPO` apontando pra uma **URL
https**, o Gabbro clona o repo em `DATA_DIR`, commita como identidade de serviço
(`GIT_USER_NAME`/`GIT_USER_EMAIL`) e escreve **somente** na `EDIT_BRANCH` — os endpoints PUT
não recebem branch nesse modo. Apontado pra um repo vazio, faz bootstrap de `master` +
`develop` com um DBML inicial (add-only, nunca sobrescreve).

| Var | Default | Descrição |
|---|---|---|
| `PORT` | `8080` | porta HTTP (vale pros dois modos) |
| `GIT_REPO` | — | URL https do repo de dados (caminho local com `.git/` ativa o modo local) |
| `GIT_TOKEN` | — | token de escrita pra repos https (GitLab/GitHub) |
| `DBML_FILE` | `database.dbml` | nome do arquivo DBML dentro do repo |
| `EDIT_BRANCH` | `develop` | branch que recebe commits (as demais são somente leitura) |
| `GIT_FETCH_TTL_MS` | `60000` | idade máxima do fetch local antes de refazer |
| `DATA_DIR` | `/data` | onde o clone gerenciado vive |
| `GIT_USER_NAME` | `gabbro` | nome do committer (hosted) |
| `GIT_USER_EMAIL` | `gabbro@local` | email do committer (hosted) |
| `GABBRO_MODE` | auto | força `hosted` ou `local`, sobrepondo a detecção |

> **Segurança: o modo hosted não tem autenticação.** Qualquer pessoa com acesso de rede ao
> app pode ler o schema e commitar na branch de edição — todos os commits saem com a
> identidade de serviço. Rode em rede interna, ou atrás de um reverse proxy que faça a
> autenticação (basic auth, OAuth proxy, VPN). Não exponha na internet pública com token de
> escrita configurado. O `GIT_TOKEN` é gravado na URL do remote dentro do volume do
> container e nunca é logado.

```bash
docker build -t gabbro .
docker run -d --name gabbro -p 8080:8080 \
  -e GIT_REPO=https://gitlab.com/voce/seu-repo-db.git \
  -e GIT_TOKEN=xxxx \
  gabbro
```

No Dokploy: Application (Dockerfile), envs acima, **Container Port = `PORT`**. O container
tem HEALTHCHECK em `/api/health`; um volume opcional em `DATA_DIR` preserva o clone entre
restarts.

> **Nota:** numa máquina que já usou o modo local, o repo salvo em `~/.gabbro/settings.json`
> tem prioridade sobre `GIT_REPO`. Pra depurar o modo hosted nessa máquina, exporte
> `GABBRO_MODE=hosted` (irrelevante em container, onde o settings não existe).

## API

| Endpoint | Modo | Descrição |
|---|---|---|
| `GET /api/health` | ambos | `{ok, repoCloned, lastFetch}` — 503 se a inicialização do repo falhou |
| `GET /api/config` | ambos | `{mode, dbmlFile, editBranch, repoName, repoPath, identity, currentBranch, readOnly}` |
| `GET /api/branches` | ambos | array com os nomes das branches |
| `GET /api/dbml/:branch` | ambos | conteúdo do DBML (text/plain); 404 pra branch ou arquivo inexistente |
| `GET /api/positions` | ambos | positions.json — worktree da branch atual (local) / branch de edição (hosted) |
| `PUT /api/dbml` | ambos | `{content, message?, branch*}` → commit; `branch` obrigatória no local (409 se ≠ atual) |
| `PUT /api/positions` | ambos | objeto de posições (+ `branch*` no local) → commit |
| `POST /api/refresh` | ambos | força um git fetch |
| `GET /api/history` | ambos | `?skip&limit&file&branch` → página de commits que tocaram os arquivos rastreados |
| `GET /api/commit/:hash` | ambos | `?file` → `{content, parentContent, meta}` pro diff estrutural do commit |
| `GET /api/commit/:hash/diff` | ambos | `?file` → diff unificado em texto |
| `POST /api/sync` | local | pull --rebase + push com auto-cura; resultado classificado com fix |
| `GET /api/sync-state` | local | `{branch, detached, ahead, behind, hasUpstream, pushWarning, dirty}` |
| `GET /api/repo` | ambos | repo atual (+ recentes no local; hosted nunca expõe paths) |
| `PUT /api/repo` | local | `{path}` → troca a instância pra outro clone existente |

## Utilitários

### Seed de posições a partir do StarUML

```bash
node scripts/mdj-to-positions.js --mdj Doc.mdj --out positions.json [--scale-x 1]
```

Extrai as coordenadas das entidades de um ERD StarUML (`.mdj`) pro schema do `positions.json`,
pra um diagrama que vivia no StarUML manter o layout que a equipe já conhece.

## Licença

[MIT](LICENSE)
