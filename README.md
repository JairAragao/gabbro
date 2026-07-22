# Gabbro

**Estúdio DBML git-native — diagrama, documentação e diff do schema do seu banco, versionado no git.**

🌎 *Read this in [English](README.en.md).*

## Por quê

O schema do seu banco já vive no git como um arquivo [DBML](https://dbml.dbdiagram.io/docs) —
o Gabbro transforma esse repo num estúdio: diagrama interativo, documentação navegável e diff
entre branches. Edições viram commits: salvar o DBML ou arrastar tabelas commita numa branch de
edição (`develop` por padrão), então o histórico do schema é simplesmente o histórico do git.
Sem banco próprio, sem build step, uma dependência só (express).

- **Schema como código** — o arquivo DBML no git é a fonte da verdade; toda mudança é um commit
- **Branches são ambientes** — mantenha a `master` espelhando produção e a `develop` espelhando
  o banco de desenvolvimento, e compare as duas visualmente
- **Layout fora do schema** — as posições das tabelas vivem no `positions.json`, separado do
  DBML, então o diff do schema fica limpo e mudança de layout nunca polui o histórico

## Funcionalidades

- **Aba Diagram** — diagrama ER interativo: pan/zoom, arrastar tabelas, grupos coloridos,
  arestas de FK com roteamento ortogonal, destaque de relações no hover
- **Aba Docs** — documentação navegável: índice por grupo de tabelas, busca, seção por tabela
  com tipos de coluna e badges PK/FK/NN/UQ, "References" / "Referenced by" clicáveis
- **Seletor de branch** — veja o schema de qualquer branch do repo de dados
- **Diff estrutural** — escolha base → target e veja tabelas/colunas/FKs adicionadas (verde),
  modificadas (amarelo) e removidas (fantasma vermelho), no diagrama e na documentação
- **Modos View / Edit** — View é somente leitura pro dia a dia; Edit abre o editor de DBML e
  habilita salvar posições, ambos commitando na branch de edição
- **Bootstrap** — apontado pra um repo sem os arquivos/branches base, o Gabbro cria `master` +
  `develop` com um DBML inicial e um `positions.json` vazio (add-only, nunca sobrescreve)

## Início rápido (local)

```bash
npm install
GIT_REPO=/caminho/do/seu/repo-dbml DATA_DIR=./data npm start
# abra http://localhost:8080
```

No Windows PowerShell:

```powershell
$env:GIT_REPO = "C:\caminho\do\seu\repo-dbml"; $env:DATA_DIR = "./data"; npm start
```

## Variáveis de ambiente

| Var | Default | Descrição |
|---|---|---|
| `PORT` | `8080` | porta HTTP |
| `GIT_REPO` | — (obrigatória) | URL https ou caminho local do repo de dados |
| `GIT_TOKEN` | — | token de escrita pra repos https (GitLab/GitHub); dispensável pra caminho local |
| `DBML_FILE` | `database.dbml` | nome do arquivo DBML dentro do repo |
| `EDIT_BRANCH` | `develop` | branch que recebe commits (as demais são somente leitura) |
| `GIT_FETCH_TTL_MS` | `60000` | idade máxima do fetch local antes de refazer |
| `DATA_DIR` | `/data` | onde o clone vive (use `./data` em dev local) |
| `GIT_USER_NAME` | `gabbro` | nome do committer |
| `GIT_USER_EMAIL` | `gabbro@local` | email do committer |

## API

| Endpoint | Descrição |
|---|---|
| `GET /api/health` | `{ok, repoCloned, lastFetch}` — 503 se a inicialização do repo falhou |
| `GET /api/config` | `{dbmlFile, editBranch, repoName}` |
| `GET /api/branches` | array com os nomes das branches remotas |
| `GET /api/dbml/:branch` | conteúdo do DBML (text/plain); 404 pra branch ou arquivo inexistente |
| `GET /api/positions` | positions.json da branch de edição (default vazio se não existir) |
| `PUT /api/dbml` | `{content, message?}` → commit + push na branch de edição |
| `PUT /api/positions` | objeto de posições → commit + push na branch de edição |
| `POST /api/refresh` | força um git fetch |

## Modo de edição e política de branches

Escritas vão **somente** pra `EDIT_BRANCH` (`develop` por padrão) — os endpoints PUT não
recebem parâmetro de branch, então commitar em qualquer outra branch é impossível pelo app.
Todas as demais branches são somente leitura. As posições também são lidas da branch de edição
independente da branch visualizada: layout é apresentação, não schema, então todas as branches
renderizam com as mesmas coordenadas.

> **Segurança: o Gabbro não tem autenticação própria.** Qualquer pessoa com acesso de rede ao
> app pode ler o schema e commitar na branch de edição. Rode em rede interna, ou coloque atrás
> de um reverse proxy que faça a autenticação (basic auth, OAuth proxy, VPN). Não exponha
> direto na internet pública com token de escrita configurado.

O `GIT_TOKEN` é passado via env; ele é gravado na URL do remote dentro do volume do container
e nunca é logado. Use um token com escopo restrito ao repo de dados, com o papel mínimo que
permita push.

## Docker

```bash
docker build -t gabbro .
docker run -d --name gabbro -p 8080:8080 \
  -e GIT_REPO=https://gitlab.com/voce/seu-repo-db.git \
  -e GIT_TOKEN=xxxx \
  gabbro
```

## Deploy (Dokploy)

Modo **Application (Dockerfile)**:

1. Source: este repo no GitHub, build type Dockerfile.
2. Configure as envs acima (`GIT_REPO`, `GIT_TOKEN`, opcionalmente `PORT`).
3. Em **Domains**, defina **Container Port = `PORT`** (mesmo valor).

O container tem HEALTHCHECK em `/api/health` (falha se a inicialização do repo falhou). Um
volume opcional em `DATA_DIR` (`/data`) preserva o clone entre restarts; sem ele, o container
re-clona no boot.

> **Bad Gateway (502)?** Porta desalinhada: o Container Port do Dokploy difere do `PORT`.
> Alinhe os dois — a porta é interna ao container.

## Utilitários

### Seed de posições a partir do StarUML

```bash
node scripts/mdj-to-positions.js --mdj Doc.mdj --out positions.json [--scale-x 1]
```

Extrai as coordenadas das entidades de um ERD StarUML (`.mdj`) pro schema do `positions.json`,
pra um diagrama que vivia no StarUML manter o layout que a equipe já conhece.

## Licença

[MIT](LICENSE)
