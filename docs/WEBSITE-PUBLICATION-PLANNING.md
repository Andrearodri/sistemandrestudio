# Planejamento supervisionado de publicação no website

A Etapa 12.4 planeja, mas não executa, a futura publicação de um pacote
`WEBSITE_EXPORT`. O único modo aceito é `DRY_RUN`; `LIVE` falha com
`WEBSITE_PUBLICATION_LIVE_MODE_DISABLED`.

## Perfil e política

A política é `andre-studio-website-publication-v1`. O perfil
`andrestudio-website`, na versão `andre-studio-website-target-v2`, registra a
marca `AndréStudio.dev` e o domínio canônico de planejamento
`https://andrestudio.dev.br`. O endereço
`https://andrestudiodev.duckdns.org` é somente referência técnica legada e não
é usado como URL canônica em novos planos.

Plataforma, estratégia de conteúdo, diretório, assets, padrão de rota, build e
restart permanecem explicitamente `UNKNOWN` até uma inspeção autorizada do
projeto real. Nenhum fallback é tratado como confirmação.

O plano contém a identidade do pacote, hash aprovado, fingerprint funcional,
operações ordenadas, pré-requisitos, warnings e URL pública provisória. Ele não
armazena corpo editorial, credenciais ou connection strings.

## Validação e efeitos

Antes de persistir, o leitor local confere os três arquivos do pacote, paths,
tamanhos, hashes, manifesto, JSON, identidade, estado, front matter, citações e
ausência de HTML/script perigoso. Divergência produz
`WEBSITE_PUBLICATION_PACKAGE_INVALID`.

Copiar conteúdo, criar rota, atualizar índice e executar/validar build ficam
`REQUIRES_TARGET_INSPECTION`, não obrigatórios. Upload, restart, cache e
verificação pública ficam `BLOCKED_IN_DRY_RUN`. Nenhum comando
de shell, rede, deploy, SSH, SFTP, FTP, API, Git ou serviço remoto é chamado.
O pacote original permanece `READY_FOR_PUBLICATION`.

## Persistência e replay

A migration 013 adiciona planos, operações e pré-requisitos. A criação grava
três eventos técnicos em uma transação. Replay após reconexão retorna o plano
existente sem nova linha ou evento; chave reutilizada com outra intenção gera
conflito. Falhas fazem rollback integral.

A identidade inclui pacote, target, domínio público, versão do perfil, política
e hash do conteúdo. Assim, o perfil v2 cria outro plano sem sobrescrever o
histórico v1 baseado em DuckDNS.

O catálogo de auditoria reserva também `WEBSITE_PUBLICATION_PLAN_REPLAYED` e
`WEBSITE_PUBLICATION_PLAN_BLOCKED`. Nesta etapa eles não geram linhas em replay
ou falha: replay deve produzir zero evento adicional e uma transação bloqueada
deve fazer rollback integral.

## Comandos

```bash
npm run website:list-ready
npm run website:plan -- --publication <id> --mode DRY_RUN
npm run website:plan:show -- --plan <id>
npm run website:plan:list
npm run website:inspect-local -- --path <diretorio-local-explicito>
npm run demo:website-plan
npm run demo:website-plan:postgres
```

`inspect-local` é opcional, somente leitura, limitado e ignora `.git`,
dependências, builds e arquivos `.env`. Ele não executa scripts e recusa
symlinks ou raízes amplas.

## Autorizações futuras

Caminho do repositório, estrutura, build, deploy, restart, rollback e rota
precisam ser confirmados pelo proprietário. Mesmo após isso, publicação `LIVE`
exigirá implementação e autorização separadas.

Na Etapa 12.4, DNS do Registro.br, propagação e HTTPS ainda não tinham sido
verificados. A Etapa 12.7 passou a observá-los separadamente em modo somente
leitura, sem alterar o caráter `DRY_RUN` deste plano. A rota
`https://andrestudio.dev.br/noticias/<slug>` é somente sugestão e recebe
`PROVISIONAL_PUBLIC_URL` e `ROUTE_PATTERN_UNCONFIRMED`. Um possível
redirecionamento do domínio técnico legado deverá ser planejado futuramente;
nenhuma alteração de DNS, certificado, Nginx ou servidor foi executada.
