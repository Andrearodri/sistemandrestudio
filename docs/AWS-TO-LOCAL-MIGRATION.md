# Migração AWS → Docker local

Data: 08/09/2026. Destino: Mac Mini M4, 16 GB de RAM.

Objetivo: reutilizar código e dados locais, validar a operação e encerrar os recursos AWS dispensáveis. Contratação de VPS fica para depois da medição de consumo.

## Estado confirmado

| Item | Estado | Pendência |
| --- | --- | --- |
| EC2 | Encerrada; aplicações dessa instância paradas | Não reativar sem decisão explícita de custo |
| Suporte AWS | Basic Support; US$ 29 de Business Support+ pertence ao período corrente | Aguardar faturamento residual |
| EBS, snapshot e IPv4 elástico | Removidos/liberado em `sa-east-1`; auditoria não encontrou recurso cobrável ativo correspondente | Aguardar consolidação residual do Billing |
| Billing VPC | `SAE1-PublicIPv4:InUseAddress` / `AssociateAddressVPC`: US$ 0,87 histórico | Nenhum recurso ativo correspondente identificado |
| Docker local | Docker 29.6.2; API e PostgreSQL saudáveis em loopback | Operar e medir o núcleo local |
| Compose deste projeto | PostgreSQL 17 e API editorial | Ainda não reúne site, CRM e n8n |
| Migração | Núcleo local executado; CRM permanece visual | Medir operação local e planejar VPS |

Evidência detalhada da sessão: [relatório local](../_scratch/aws-inventory-2026-09-08/RELATORIO.md), ignorado pelo Git. O snapshot observado é de 29/07/2026 e não tem restauração comprovada. O domínio público apresentou conteúdo diferente da origem EC2; identificar sua hospedagem antes de alterar DNS ou liberar endereços.

## 1. Inventariar o que já existe

- [ ] Listar projetos locais, revisões Git, arquivos não versionados e configurações Docker. As cópias em `audit-repositories/` são material de auditoria; não presumir que sejam a versão mais recente.
- [ ] Identificar containers, volumes, bind mounts, imagens, portas e políticas de reinício. Ao iniciar o Docker, containers antigos podem reiniciar: controlar previamente automações e acessos externos.
- [ ] Comparar código, datas de backup, versões de schema e histórico dos bancos locais com a AWS. Definir a origem válida para cada conjunto de dados.
- [ ] Registrar dependências externas: Supabase, WhatsApp, Telegram, LLM e origem pública do site.

**Entrega:** inventário sanitizado com componente, versão, localização dos dados e decisão de reaproveitamento. Não executar `prune`, `down -v`, reset de banco ou `npm run db:up` para inventariar; este último inicia todos os serviços do Compose.

Inventário local confirmado em 08/09/2026: a API e o PostgreSQL editorial foram reconstruídos/iniciados em loopback; a pilha antiga tinha PostgreSQL 15, Redis, n8n e Evolution API, todos parados. Os oito containers antigos foram removidos, mas os seis volumes e as imagens foram preservados. O overlay local [compose.automacao-wattszap.local.yaml](../compose.automacao-wattszap.local.yaml) mantém portas em loopback e desativa reinício automático para a próxima validação.

## 2. Preservar e recuperar dados

| Componente | Preservar |
| --- | --- |
| Site/Nginx | Código, arquivos estáticos, uploads e configuração corrigida de segurança |
| CRM | Somente imagem/demonstração comercial no site nesta fase; operação e dados adiados |
| Editorial | Banco PostgreSQL, versões/evidências/decisões e arquivos persistentes |
| n8n | Banco, workflows, arquivos binários e chave de criptografia das credenciais |

- [ ] Fazer backup dos dados locais existentes antes de qualquer restauração.
- [x] Recuperar somente o que estava disponível localmente e manter a EC2 sem extração remota antes do encerramento autorizado.
- [ ] Exportar PostgreSQL por backup lógico (`pg_dump`/`pg_restore`), incluindo inventário de roles e extensões. Não transplantar diretamente o diretório físico de dados entre x86_64 e ARM64. [Documentação PostgreSQL](https://www.postgresql.org/docs/17/backup-dump.html).
- [ ] Guardar segredos e backups fora do Git, com acesso restrito; registrar apenas nomes de variáveis ausentes. Manter uma segunda cópia protegida em armazenamento já disponível.
- [ ] Registrar data, origem, tamanho e SHA-256 dos backups; testar restauração completa. Hash confere integridade de transferência, não recuperabilidade.

**Entrega:** backups recuperáveis de todos os dados necessários. A existência de uma imagem Docker ou de código local não comprova que os dados estejam preservados.

## 3. Preparar o ambiente local

- [ ] Preparar configuração Compose separada, com imagens compatíveis com ARM64 e versões fixadas após validação. Reutilizar fontes e dependências existentes.
- [ ] Restaurar em **novos volumes**, preservando os atuais. O Compose existente fixa `name: sistemandrestudio_postgres_data`; mudar apenas o nome do projeto com `-p` não isola esse volume.
- [ ] Publicar portas somente em `127.0.0.1`, manter bancos na rede interna e verificar conflitos antes da inicialização.
- [ ] Definir explicitamente o arquivo de ambiente usado pelo Compose e pelos containers. `env_file` do serviço não substitui o arquivo de interpolação do Compose; não imprimir configurações resolvidas com segredos.
- [x] Iniciar somente PostgreSQL e API editorial. O CRM fica fora da operação: será usado apenas como imagem/demonstração comercial, sem banco, Supabase ou integrações.
- [ ] Manter `PUBLICATION_ENABLED=false`, decisões em Console, dry-run e workflows/agendamentos desativados. Dry-run isoladamente não garante que outros processos não façam chamadas externas.
- [ ] Adicionar n8n e modelo local separadamente, após medição. Não trocar provedor LLM nem ativar API paga como efeito da migração.

Não iniciar n8n ou Evolution API com credenciais antigas antes de revisar workflows, webhooks e destino de mensagens. PostgreSQL e Redis podem ser validados isoladamente pelo overlay local; n8n/Evolution permanecem parados até essa revisão.

O CRM não entra no ambiente operacional desta fase. Se futuramente virar serviço funcional, será necessário reabrir o escopo para Supabase/PostgreSQL, Auth, Storage, RLS, Meta e segredos; esse trabalho não faz parte desta migração.

**Entrega:** ambiente local reproduzível, sem exposição pública e sem automações externas ativas. WhatsApp, Telegram e fontes oficiais continuam dependendo da internet; validar inicialmente com simulações.

## 4. Restaurar e validar

- [ ] Restaurar em volumes novos, conferir schema, contagens por tabela, vínculos e arquivos; preservar versões editoriais e decisões. Resolver diferenças entre bases sem sobrescrever ou mesclar dados cegamente.
- [ ] Executar testes, typecheck e build. Usar banco de testes separado dos dados recuperados para testes destrutivos.
- [ ] Validar saúde dos serviços, login do CRM, operações com dados de teste, uploads e persistência após reinício.
- [ ] Confirmar autenticação da API e bloqueio de `.env`, `.git`, backups e arquivos de implantação no servidor web.
- [ ] Confirmar ausência de publicação, mensagens reais, execução de workflows e chamadas pagas.

**Aceite:** funções necessárias operam localmente, os dados conferem com a origem e o reinício mantém o estado. Isso não declara concluída a homologação editorial pendente em [STATUS.md](../STATUS.md).

**Reversão:** se a validação falhar, parar apenas os serviços novos e preservar os volumes anteriores e backups. Qualquer retorno à AWS exige decisão explícita sobre custo; não reativar automaticamente.

## 5. Medir RAM e capacidade

As estimativas anteriores não são medições. O consumo inclui a VM Linux do Docker, macOS, navegador, aplicações e eventual modelo local. A soma de `docker stats` não representa toda a memória usada no Mac.

- [ ] Medir o Mac antes da inicialização, após estabilização dos serviços e durante uso representativo.
- [ ] Registrar memória por container, memória/limite da VM Docker, pressão de memória e crescimento de swap no macOS; medir build separadamente.
- [ ] Repetir ao adicionar n8n ou modelo local, um por vez. O CRM visual não entra na medição operacional. Ajustar limites conforme o resultado. [Configuração de recursos Docker](https://docs.docker.com/desktop/settings-and-maintenance/settings/).

| Cenário | RAM dos containers | VM Docker | Pressão/swap do Mac | Resultado |
| --- | --- | --- | --- | --- |
| Site + editorial + banco | A medir | A medir | A medir | Pendente |
| Com CRM visual, sem serviços | Sem impacto operacional | Sem impacto operacional | A medir | Aceito como material comercial |
| Com n8n | A medir | A medir | A medir | Pendente |
| Com modelo local | A medir | A medir | A medir | Pendente |

**Aceite:** uso representativo sem OOM ou reinícios, pressão de memória sem alerta persistente e sem crescimento contínuo de swap. Dimensionar a futura VPS com carga medida e margem; não pelo tamanho da antiga EC2.

## 6. Encerrar recursos AWS

- [x] Confirmar backups locais verificados, aceite local e inventário exato dos recursos a remover.
- [x] Obter autorização específica para encerramento/exclusão. O EBS raiz estava configurado para exclusão no encerramento da EC2.
- [x] Encerrar `i-042b6be73bf131c23`; o volume raiz `vol-054648b90786aa297` foi excluído automaticamente; excluir `snap-0746d1eed3238fb3e`; desassociar e liberar `52.67.160.253` (`eipalloc-044cdd8f3f54cf5ae`).
- [x] Verificar `sa-east-1`: nenhum volume EBS, snapshot ou IPv4 elástico listado para esta carga; a instância ficou apenas no histórico como `Encerrado`.
- [x] Conferir Billing/Cost Explorer: `SAE1-PublicIPv4:InUseAddress` / `AssociateAddressVPC` de US$ 0,87 é histórico; nenhuma cobrança ativa correspondente foi identificada. Cobranças residuais podem ser consolidadas no período corrente.

**Aceite:** recursos dispensáveis desta carga removidos em `sa-east-1`; a ausência de novas cobranças correspondentes ainda depende da atualização do Billing.

## Próxima execução

O inventário e a base local já foram executados. A EC2 foi encerrada e o WACRM permanece somente como material visual. O próximo passo é operar e medir o núcleo editorial local; qualquer ativação futura do CRM reabre este plano. Ao concluir cada etapa, registrar evidência sanitizada e atualizar [PLAN.md](../PLAN.md) e [STATUS.md](../STATUS.md).

Para a futura VPS, levar Compose validado, versões, exemplos de ambiente sem segredos, procedimento de restauração e métricas. Aprovar previamente custo total: plano/renovação, backup, IPv4, tráfego e serviços externos. Operação local depende do Mac ligado e não oferece a mesma disponibilidade de um servidor dedicado.

## 7. Fechamento documental — 09/09/2026

### AWS

- EC2 `i-042b6be73bf131c23` encerrada.
- Volume EBS raiz removido; snapshot antigo removido; IPv4/EIP liberado.
- `SAE1-PublicIPv4:InUseAddress` / `AssociateAddressVPC` de US$ 0,87 é cobrança histórica; não há recurso ativo correspondente.
- Business Support+ de US$ 29 pertence ao período corrente; o plano atual é Basic Support.
- Nenhum recurso AWS cobrável ativo da infraestrutura antiga foi identificado. As cobranças remanescentes são históricas/residuais e podem ser consolidadas pelo Billing.

### Ambiente local

- Docker `29.6.2`.
- API saudável em `127.0.0.1:4317`.
- PostgreSQL saudável em `127.0.0.1:55432`.
- Banco editorial com aproximadamente 45 tabelas.
- Volume `sistemandrestudio_postgres_data` preservado.

### Automação antiga `automacao-wattszap`

- Stack parada e preservada.
- Volumes de PostgreSQL, n8n, Evolution API e Redis preservados.
- Não executar `docker system prune`.
- `.env` com permissão `600` e protegido pelo `.gitignore`.
- Secrets hard-coded removidos; `.env.example` criado.
- `AUTHENTICATION_API_KEY` e `N8N_RUNNERS_AUTH_TOKEN` rotacionados.
- A senha do PostgreSQL antigo permanece pendente e só deve ser rotacionada em futura janela controlada de reativação.
- Nenhum container antigo foi iniciado nesta etapa.

### Estado final

- `Migração técnica AWS → local: CONCLUÍDA`
- `Dependência operacional da AWS: NENHUMA IDENTIFICADA`
- `Geração de novos custos da infraestrutura antiga: ENCERRADA`
- `Billing residual: AGUARDANDO CONSOLIDAÇÃO DO PERÍODO`
- `Dados Docker antigos: PRESERVADOS`
- `Automação antiga: DESATIVADA / PRESERVADA`
