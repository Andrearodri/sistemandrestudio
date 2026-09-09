# Homologação WebMCP

Plano de infraestrutura independente: [migração AWS → Docker local](docs/AWS-TO-LOCAL-MIGRATION.md).

- [x] Confirmar branch e item WebMCP `VERIFIED` / `CONFIRMED`.
- [x] Blindar contrato editorial com schema Zod/JSON Schema e `subtitle` como texto simples.
- [x] Separar geração estruturada, montagem determinística e validação factual/quantitativa.
- [x] Implementar reparo direcionado limitado a uma segunda chamada.
- [x] Executar testes, typecheck e build antes da homologação.
- [x] Executar no máximo duas chamadas ao Gemma, sem persistir saída inválida.
- [x] Preservar diagnósticos internos tipados entre wrapper e serviço, sem conteúdo sensível.
- [x] Validar diagnósticos, sanitização, contagem e propagação externa.
- [x] Executar a nova homologação controlada e bloquear saídas inválidas.
- [x] Separar orçamento de artigo WebMCP do resumo curto e auditar payload efetivo.
- [x] Construir fact packet determinístico e reparar somente `body`.
- [x] Testar orçamento, tokens, qualificadores proibidos e reparo sem invenção.
- [x] Executar a única nova homologação autorizada, limitada a duas chamadas.
- [x] Extrair o executor WebMCP para CLI rastreado e remover lógica operacional do `_scratch/`.
- [x] Cobrir ReferenceError, reparo limitado, zero persistência em falha e persistência única em sucesso.
- [x] Executar a homologação pelo executor rastreado, limitada a duas chamadas e sem persistir saída inválida.
- [ ] Persistir exatamente um rascunho válido e enviar uma mensagem ao Telegram.
- [ ] Parar aguardando decisão humana; manter publicação `SKIPPED`.
- [x] Adicionar provedor editorial OpenAI explícito para rascunhos longos, mantendo Radar em Ollama.
- [x] Integrar Responses API com Structured Outputs estritos derivados do schema Zod compartilhado.
- [x] Cobrir seleção de provedor, erros HTTP, limite de duas chamadas, uso/custo sanitizados e ausência de efeitos externos.
- [ ] Confirmar `OPENAI_API_KEY` e `OPENAI_HARD_SPEND_LIMIT_USD=1` antes de qualquer chamada real.

Resultado: o executor rastreado foi validado com 366/366 testes e a homologação consumiu duas chamadas. A geração inicial falhou por tamanho/qualificador; o reparo direcionado falhou no schema. Não houve persistência nem Telegram.

## Migração AWS → Docker local — 08/09/2026

- [x] Documentar sequência, preservação de dados e critérios de aceite.
- [x] Inventariar Docker, projetos e dados locais; comparar com a AWS.
- [x] Preservar dados locais em cópias compactadas fora do Git.
- [x] Manter EC2 interrompida durante a validação; após aceite específico, encerrá-la e registrar a conferência.
- [x] Preparar ambiente ARM64 isolado para API editorial; CRM visual adiado.
- [x] Validar serviços de base locais em volumes existentes e portas loopback.
- [x] Adiar restauração de dados AWS; EC2 foi encerrada após validação local e autorização específica.
- [x] Medir linha de base de RAM dos serviços iniciados.
- [x] Adiar medição de CRM/Supabase; n8n e modelo local continuam opcionais.
- [x] Adiar CRM operacional: nesta fase ele será somente imagem/demonstração comercial, sem banco.
- [x] Remover recursos AWS desta carga em `sa-east-1` após aceite e autorização específica; auditoria final confirmou ausência de recurso cobrável ativo e registrou cobranças residuais.

## Fechamento documental — 09/09/2026

- [x] Registrar encerramento da EC2 `i-042b6be73bf131c23`, EBS raiz, snapshot e IPv4/EIP da carga antiga.
- [x] Registrar `SAE1-PublicIPv4:InUseAddress` / `AssociateAddressVPC` de US$ 0,87 como histórico sem recurso ativo.
- [x] Registrar Business Support+ de US$ 29 no período corrente e Basic Support como plano atual.
- [x] Confirmar que nenhum recurso AWS cobrável ativo da infraestrutura antiga foi identificado.
- [x] Registrar Docker 29.6.2, API `127.0.0.1:4317`, PostgreSQL `127.0.0.1:55432`, banco editorial com aproximadamente 45 tabelas e volume `sistemandrestudio_postgres_data`.
- [x] Registrar automação antiga parada/preservada, volumes preservados, `.env` 600, secrets hard-coded removidos e rotações autorizadas concluídas.
- [x] Manter a senha do PostgreSQL antigo pendente para futura janela controlada de reativação.
- [x] Encerrar documentalmente a migração e aguardar consolidação residual do Billing.

Estado final: `Migração técnica AWS → local: CONCLUÍDA`; `Dependência operacional da AWS: NENHUMA IDENTIFICADA`; `Geração de novos custos da infraestrutura antiga: ENCERRADA`; `Billing residual: AGUARDANDO CONSOLIDAÇÃO DO PERÍODO`; `Dados Docker antigos: PRESERVADOS`; `Automação antiga: DESATIVADA / PRESERVADA`.
