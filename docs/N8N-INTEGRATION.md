# Integração com n8n

## Responsabilidades

n8n:

- agenda;
- cria trigger key idempotente;
- chama a API interna;
- consulta o estado;
- encerra a execução quando há espera humana;
- encaminha um callback mínimo;
- registra resumo operacional.

O `sistemandrestudio`:

- aplica política e limites;
- delega aos serviços de domínio;
- persiste no PostgreSQL;
- valida Telegram;
- registra a decisão;
- retoma;
- controla replay, locks e auditoria.

n8n não decide relevância, fatos, aprovação ou publicação e não mantém o estado
editorial definitivo.

## Workflows exportáveis

```text
deploy/n8n/workflows/editorial-orchestration-v1.json
deploy/n8n/workflows/telegram-editorial-decision-v1.json
```

Ambos são exportados inativos e sem valores de credenciais. A referência
`sistemandrestudio-internal-api` deve ser configurada no n8n como Header Auth:

```text
Authorization: Bearer <ORCHESTRATION_API_SECRET>
```

O endereço é lido de `SISTEMANDRESTUDIO_INTERNAL_URL` e deve permanecer privado,
por exemplo `http://127.0.0.1:4317` quando os processos compartilham host.

## Workflow editorial

O schedule cria uma chave diária no formato:

```text
editorial-run:<data>:morning
```

Ele inicia a run uma vez. Se o resultado for
`WAITING_HUMAN_DECISION`, encerra sem loop. A decisão produz outra execução do
workflow de callback. Polling futuro deve ser controlado e nunca manter uma
execução n8n aberta indefinidamente.

## Workflow Telegram

O webhook valida o header `x-telegram-bot-api-secret-token` contra a variável
do n8n, extrai somente callback, chat, usuário, instante e referência da
mensagem, e encaminha esses campos ao sistema. Assinatura do botão, chat,
usuário, prazo, request, replay e draft associado são validados novamente pelo
`sistemandrestudio`.

O n8n não interpreta `APPROVE`, `REJECT` ou `REQUEST_CHANGES`.

## Desenvolvimento e VPS futura

Localmente:

1. PostgreSQL em `127.0.0.1:55432`;
2. API interna em `127.0.0.1:4317`;
3. `HUMAN_DECISION_CHANNEL=CONSOLE`;
4. workflows importados, porém inativos, até revisão.

Em VPS futura, a API deverá continuar em rede privada. Exposição externa,
proxy, TLS, firewall, gerenciamento de segredos, ativação do workflow e webhook
do Telegram exigem autorização e revisão operacional separadas.

Não há deploy de n8n nesta etapa.
