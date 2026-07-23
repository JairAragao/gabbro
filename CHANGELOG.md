# Changelog

## 0.6.3 — 2026-07-23

Revisão de usabilidade (correções).

- **Diff durante a edição** — abrir uma comparação agora sai do modo edição, em vez de deixar
  o editor de DBML e o painel de diff sobrepostos.
- **Docs travava** — o modo Docs quebrava (tela em branco) ao trocar para uma branch onde a
  tabela filtrada não existe; e o hash de tabela não abre mais Docs no meio da edição/diff/histórico.
- **Auto-sync no arraste** — a sincronização automática não dispara mais durante um arraste de
  tabela (evitava a tabela sumir/saltar no meio do gesto).
- **Sync** — rejeição de push por branch protegida/hook deixa de ser tratada como divergência
  (fim do loop de tentativas e da mensagem errada); e um rebase já em andamento no repositório
  é respeitado, não abortado.
- Ajuste: o histórico "todos os arquivos" fica restrito ao modo local; botão "Realce".

## 0.6.2 — 2026-07-23

Janela nativa, topo redesenhado e histórico em tela cheia.

- **Barra de título própria (frameless)** — a janela perde a moldura do sistema e ganha uma
  barra custom: logo + nome, repositório e branch à esquerda; Visualizar/Editar e a busca
  centralizados; minimizar/maximizar/fechar à direita. A barra arrasta a janela.
- **Busca estilo command palette** — recolhida numa lupa que expande (Ctrl+F) com campo e o
  filtro de escopo; aparece só no modo diagrama.
- **Abas de comparação estilo Chrome** — as comparações de diff ficam no centro da 2ª barra,
  com orelhas curvas, em vez de uma terceira linha.
- **Modo histórico em tela cheia** — abrir um commit abre uma janela de três colunas: lista de
  commits (os que não mudam o schema ficam travados/cinza, o aberto destacado), o código do
  commit vs o anterior lado a lado, e o diagrama com o diff estrutural + painel de mudanças.
- **Dropdowns no tema** — os seletores nativos viram menus custom (sem o azul do sistema) que
  fecham ao clicar fora, inclusive sobre o diagrama.
- **Diff refinado** — o botão Diff abre um dialog que não deixa comparar uma branch com ela
  mesma; a comparação abre já com o texto lado a lado; realce âmbar na base da barra.
- **Um botão Salvar** — schema e/ou posições no mesmo botão, com rótulo adaptável, só no modo
  edição. O modo edição deixa o verde mais vivo.
- Histórico do schema lista só commits que mudam o DBML; grade de fundo acompanha o zoom;
  seleção em área no diagrama; splash com a tipografia do nome.

## 0.6.1 — 2026-07-23

Acabamento de UI.

- **Dropdowns no tema** — os `<select>` nativos (que abriam o menu do sistema, com
  destaque azul) foram trocados por um dropdown custom no tema do app (menu verde). O
  `<select>` real continua por baixo, funcional. Aplicado a todos os seletores.
- **Abas de comparação de verdade** — as comparações de diff viraram uma barra de abas
  própria abaixo do topo (estilo navegador): a aba da branch atual + uma aba `base → alvo`
  por comparação, cada uma fechável. A barra só aparece quando há uma comparação aberta.
- **Um botão Salvar** — "Salvar DBML" e "Salvar posições" viraram um só; o rótulo se adapta
  (Salvar / Salvar posições / Salvar tudo) e commita o que estiver pendente.
- **Diff mais legível** — a tabela removida deixa de ficar apagada e ganha borda e brilho
  vermelhos (destaque simétrico ao verde da adicionada). Seleção de texto do editor passou
  de azul para o verde do tema.
- Fixes: flash branco na abertura e grade de fundo acompanhando o zoom (em vez de fixa em px
  de tela).

## 0.6.0 — 2026-07-23

Modo diff, organização do diagrama e chrome por modo.

- **Modo diff em abas** — o botão Diff abre um dialog de seleção (base → alvo); confirmar
  cria uma aba de comparação no topo, ao lado de Diagrama/Docs. Várias comparações abertas
  ao mesmo tempo, cada uma fechável; o tema ganha tom âmbar enquanto uma comparação está
  ativa. Painel **Mudanças** lista as tabelas novas/alteradas/removidas (clique centraliza
  no diagrama), botão **Destacar** escurece o que não mudou e botão **Texto** mostra o diff
  unificado do DBML entre as branches (`GET /api/diff-text`).
- **Auto-organização por grupos** — menu Organizar com três layouts que respeitam os
  agrupamentos (tabela nunca sai do grupo): Esquerda → direita (camadas de grupos pela
  direção dos FKs), Floco de neve (grupo mais conectado no centro, demais em espiral) e
  Compacto (grade por grupos).
- **Seleção em área** — no modo edição, arrastar no fundo desenha um retângulo que
  seleciona as tabelas tocadas (Shift acumula); arrastar o cabeçalho de uma selecionada
  move a seleção inteira. Esc limpa.
- **Chrome por modo** — Histórico saiu do topo e virou aba das Configurações (com switch
  "todos os arquivos"; clicar num commit abre a visualização dele no diagrama). Docs some
  no modo edição. Modo local mostra só Sincronizar (o refresh separado ficou no hosted).
- **Editor com atalhos estilo VS Code** — Ctrl+D (próxima ocorrência), Ctrl+/ (comentar),
  Alt+setas (mover linha), Shift+Alt+setas (duplicar), Ctrl+Shift+K (excluir), Ctrl+L
  (selecionar linha), Tab/Shift+Tab (indentar), auto-indentação no Enter.
- **UI** — toolbar enxuta (busca recolhida numa lupa, contador de tabelas virou chip no
  canto do diagrama), grade de fundo em pontos (estilo dbdiagram) desligável, roteamento
  das linhas parametrizável e persistido, aba Atalhos nas Configurações.
- **Docs** — filtros por grupo/tabela, comentário da coluna em coluna própria, atributos
  antes do nome, índices e referências em painéis visuais, mini-diagrama de relacionamentos
  que espelha o layout principal com setas ortogonais e toggle tabelas inteiras/só vínculos.
- Correções: preservação de edição de DBML não salva no sync/refresh/troca de branch,
  `clearDrafts` não apaga mais as preferências, roteamento imune a git localizado
  (`LC_ALL=C`), intervalo de auto-update persistido e respeitado no boot, e a UI toda
  traduzida para pt-BR — além de duas rodadas de varredura multi-agente com 28 achados
  corrigidos.

## 0.5.0 — 2026-07-23

Interface em português, configurações completas e modo doc turbinado.

- **UI 100% pt-BR** — app, CLI, splash, erros do servidor e prefill de commit. Mensagens
  do git fixadas em inglês internamente (`LC_ALL=C`) pra classificação de erro estável.
- **Modal de Configurações** com 4 abas: Geral (salvamento automático de posições com
  intervalo configurável), Sincronização (auto-sync com estratégia de conflito
  rebase/só-fast-forward/perguntar + painel de saúde do git), Histórico (todos os commits
  do repo) e Atualizações (status, verificação manual, intervalo configurável — inclusive
  "Desligado" valendo no boot — e changelog embutido).
- **Modo doc**: filtro por grupo e por tabela, coluna própria pra comentários, atributos
  antes do nome, painéis visuais de índices/referências e **mini-diagrama de
  relacionamentos** que espelha as posições do diagrama principal, com tabelas inteiras
  ou só vínculos e arestas 90° roteadas pelo mesmo A* do diagrama.
- **Diagrama**: marcadores PK/FK/U antes do nome (estilo StarUML), auto-organização
  (esquerda→direita, floco de neve, compacto), grade de fundo desligável, toolbar com a
  identidade mineral, ctrl+scroll = zoom / scroll = rolagem / botão do meio = pan.
- **Editor DBML**: atalhos estilo VS Code (Ctrl+D próxima ocorrência, Ctrl+/, Alt+setas,
  Shift+Alt+setas, Ctrl+Shift+K, Ctrl+L, Tab/Shift+Tab, Enter com auto-indentação).
- **Robustez**: edição de DBML não salva sobrevive a Sincronizar/atualizar/trocar de
  branch; 28 correções de duas rodadas de revisão (âncoras de seta, preferências que
  sumiam ao salvar posições, avisos de push obsoletos, clipping no mini-diagrama e mais).

## 0.4.0 — 2026-07-23

Identidade visual e boot sem fricção.

- **Logo D0 ("G no cristal")** — marca aplicada no sistema inteiro: favicon, toolbar,
  splash, ícone da janela/taskbar e `build/icon.ico` do instalador NSIS. Asset canônico
  em `public/logo.svg`.
- **Splash screen** — janela frameless instantânea (estilo Basalt) com logo, glow e barra
  de progresso enquanto o backend sobe; a janela principal só aparece quando o renderer
  sinaliza pronto (IPC `app:ready`, com fallbacks de 5s/12s).
- **Welcome screen** — primeira execução sem repo salvo NÃO abre mais o seletor nativo
  bloqueante: o app abre normal e mostra uma tela de boas-vindas com repos recentes,
  Browse… e campo de path. A escolha persiste em `~/.gabbro/settings.json` e as próximas
  aberturas vão direto pro diagrama. No server, boot "unconfigured" responde 409
  (`code: unconfigured`) nas rotas de dado e aceita `PUT /api/repo` pra configurar.
- **Auto-detecção do arquivo DBML** — se `database.dbml` não existe na raiz do worktree,
  o Gabbro usa o primeiro `*.dbml` encontrado (repos usam `db.dbml`, `schema.dbml`...).
  Reavaliado a cada troca de repo.
- Fix: banner de worktree sujo listava `[object Object]` em vez do nome do arquivo.

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
