# Sistemandrestudio — regras de trabalho para agentes

## Objetivo

Construir um sistema editorial seguro e útil para AndréStudio.dev:

`fontes oficiais → deduplicação → verificação factual → rascunho → aprovação humana → publicação manual futura`

O sistema não deve publicar automaticamente enquanto `PUBLICATION_ENABLED=false`.

## Como trabalhar

- Execute comandos, testes, chamadas HTTP autorizadas e diagnósticos necessários sem pedir que o usuário abra o terminal.
- Peça ação manual somente para login, 2FA, CAPTCHA, confirmação em interface externa ou credenciais que não estejam configuradas.
- Diga qual variável está ausente; nunca solicite ou imprima o seu valor.
- Para perguntas, apresente opções simples e uma recomendação em uma linha. Para decisões relevantes, inclua prós e contras curtos.
- Mantenha respostas objetivas; não interrompa o trabalho por erros comuns e corrigíveis.

## Autonomia e gates obrigatórios

Trabalhe autonomamente até os critérios de aceite abaixo. Pare e solicite autorização antes de:

- adicionar custo recorrente, trocar provedor LLM ou baixar artefato/modelo acima de 5 GB;
- modificar política editorial, tipos de claim aceitos ou critérios que promovem um item a `VERIFIED`;
- usar novas credenciais, alterar permissões, expor nova porta ou acesso público;
- enviar mensagem a destinatário novo;
- publicar em site, LinkedIn, Instagram ou outra rede;
- migration, deploy, merge, push ou mudança destrutiva.

Nunca trate `VERIFIED` como autorização de publicação. Aprovação no Telegram é apenas editorial local enquanto a publicação estiver bloqueada.

## Integridade editorial

- Use fontes oficiais permitidas e evidência rastreável.
- Nunca invente datas, números, versões, preço, disponibilidade, preview/beta, resultados ou experiência prática.
- Qualificadores só podem ser usados se constarem literalmente na evidência vigente.
- Diferencie anúncio oficial, fato confirmado e interpretação.
- Preserve versões, decisões e evidências para auditoria; não sobrescreva rascunhos anteriores.
- Não reduza critérios para fazer uma homologação passar. Corrija extração, associação de evidência ou cobertura com testes.

## Escopo de arquivos e segredos

- Altere apenas arquivos do projeto atual.
- Use `_scratch/` (ignorado pelo Git) para temporários. Não versione temporários.
- Não apague arquivos que não foram criados na tarefa atual.
- Não versione `.env`, tokens, chaves ou dados pessoais. Logs e relatórios devem ser sanitizados.
- Preserve documentos não rastreados existentes.

## Qualidade e verificação

- Faça o menor diff que resolva o problema e respeite o estilo existente.
- Não refatore áreas adjacentes sem necessidade.
- Para cada correção, crie ou atualize teste de regressão.
- Antes de declarar algo concluído, execute os testes relevantes, typecheck e build; confirme o comportamento observável quando aplicável.
- Para fluxos externos, use dry-run e idempotência antes de qualquer ação real.

## Git

- Não faça `git init` em projeto que não usa Git.
- Não crie commit sem pedido do usuário, exceto se uma tarefa declarar explicitamente que o commit local é critério de aceite.
- Um commit por mudança lógica, com mensagem clara.
- Nunca faça push forçado em `main`/`master`.
- Nunca faça push, PR, merge ou deploy sem gate explícito do usuário.

## Estado e tarefas longas

- Para tarefa multi-etapa, mantenha `PLAN.md` ou checklist equivalente atualizado.
- Registre decisões, validações, limitações e próximo passo em `STATUS.md` quando isso evitar perda de contexto.
- Se o contexto ficar longo, prepare handoff curto: estado atual, commits, validações, bloqueios e próximo comando seguro.

## Critérios mínimos do MVP local

Considere o MVP local pronto para canário somente quando todos forem verdadeiros:

1. Coleta oficial, deduplicação e verificação factual funcionam com evidência rastreável.
2. Claims ambíguas, genéricas ou sem entidade são bloqueadas corretamente.
3. Gemma local gera rascunho dentro dos limites editoriais e passa validação determinística.
4. Telegram registra Aprovar, Rejeitar e Pedir revisão de forma idempotente.
5. PostgreSQL preserva versões, evidências e decisões.
6. Testes, typecheck e build passam.
7. Publicação externa permanece bloqueada durante toda a homologação.

## Instruções específicas

Fluxos detalhados devem ficar em `.agents/skills/` e referências extensas em `references/` ou `.codex/guides/`. Carregue somente o material necessário para a tarefa; não copie instruções longas para este arquivo.
