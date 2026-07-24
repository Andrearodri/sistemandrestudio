# Operação do radar oficial

O radar é deliberadamente um coletor de leitura: `READ_ONLY_EXTERNAL` só executa `GET` HTTPS para URLs do catálogo oficial. Não usa login, cookies de autenticação, tokens, webhooks, publicação nem envio de dados.

Configuração segura e explícita: no máximo 5 fontes, 10 itens por fonte, timeout de 8 segundos, resposta de até 1 MB, até 2 redirecionamentos e uma única repetição para falha transitória. Cada fonte tem host permitido, intervalo mínimo de 60 minutos e retenção indicada no catálogo.

Use `npm run radar:fixtures` para exercitar XML local. `npm run radar:official` só deve ser usado quando a coleta pública estiver autorizada; erros por fonte são registrados localmente e não interrompem as demais. O relatório contém somente IDs, contagens, status e códigos estáveis — nunca corpo de resposta, credenciais ou URLs de conexão.

Deduplicação exata por URL canônica, identificador externo ou hash gera registro `DUPLICATE` e não pontua novamente. Similaridade de título apenas reduz a relevância; não descarta automaticamente. A retenção futura deve remover primeiro os registros de duplicidade e execuções, preservando a trilha editorial conforme a política de dados.

## Validação limpa e idempotência

`npm run radar:validate` exige a configuração do banco terminado em `_test`.
O comando reseta somente esse banco, coleta no máximo três itens de cada fonte
habilitada e mantém em memória o snapshot recebido. Em seguida executa duas
rodadas idênticas contra o PostgreSQL de teste:

- rodada 1: parsing, normalização, relevância e persistência;
- rodada 2: deduplicação exata antes da relevância;
- cada rodada gera um registro próprio em `source_fetch_runs`;
- nenhum conteúdo é gerado ou publicado.

Na validação de 24 de julho de 2026, a primeira rodada recebeu e classificou
três itens de cada uma das cinco fontes: 15 agregados, 45 eventos editoriais e
15 itens coletados. A segunda recebeu os mesmos 15 itens e os classificou como
duplicatas exatas: permaneceram 15 agregados, 45 eventos e 15 itens, enquanto
as execuções passaram de 5 para 10.

Idempotência significa que repetir a mesma entrada pode registrar uma nova
tentativa operacional, mas não cria outro agregado, evento editorial, versão
ou pontuação. Similaridade não é idempotência: ela é uma medida entre conteúdos
distintos e apenas influencia a relevância.

## Solução de problemas

- `FEED_PARSE_FAILED`: confirme formato e use fixture sanitizada; não registre
  o corpo completo.
- `URL_NOT_ALLOWED`: confira o catálogo e a allow-list; não contorne a proteção
  com URL dinâmica.
- `FETCH_TIMEOUT_OR_NETWORK`: mantenha a fonte como falha temporária e tente
  depois; não aumente limites indiscriminadamente.
- conflito no banco de desenvolvimento após uma execução antiga incompleta:
  use `radar:validate` como prova isolada; não limpe dados de desenvolvimento
  sem autorização.
- falha de DNS no `npm audit`: registre a indisponibilidade e execute
  `npm ls --all`; não declare zero vulnerabilidades.
