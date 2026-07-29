# Revisão humana editorial pelo Telegram

## Canal desacoplado

`HumanDecisionChannel` separa domínio e transporte. Existem:

- `ConsoleHumanDecisionChannel`, padrão de desenvolvimento;
- `InMemoryHumanDecisionChannel`, testes e demos;
- `TelegramHumanDecisionChannel`, habilitado somente por configuração
  explícita.

O domínio não importa a API do Telegram e não confia em texto livre de botão.

## Configuração

Variáveis necessárias para Telegram:

```text
HUMAN_DECISION_CHANNEL=TELEGRAM
TELEGRAM_BOT_TOKEN=
TELEGRAM_APPROVER_CHAT_ID=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ALLOWED_USER_IDS=
```

Os valores pertencem somente ao ambiente local ou ao cofre operacional. Não
devem entrar no Git, logs, workflows exportados ou banco.

Sem configuração, use:

```text
HUMAN_DECISION_CHANNEL=CONSOLE
```

## Conteúdo da mensagem

A mensagem é limitada e contém fonte, título, status factual, confiança, resumo
curto, até cinco claims, até cinco limitações e identificador/versão do draft.
Não inclui HTML integral, logs, credenciais, caminhos locais ou payloads
internos.

## Botões assinados

Callbacks seguem:

```text
approve:<requestId>:<assinatura>
reject:<requestId>:<assinatura>
changes:<requestId>:<assinatura>
details:<requestId>:<assinatura>
```

A assinatura HMAC é verificada com comparação constante. O sistema também
valida:

- chat aprovado;
- usuário permitido quando configurado;
- request existente e pendente;
- expiração;
- replay;
- decisão final anterior;
- draft e versão associados.

`details` é somente leitura. Rejeição requer razão. Solicitação de alterações
requer instruções controladas. Nenhuma ação escolhe outro draft.

## Limite de rede

O cliente usa:

- somente `https://api.telegram.org`;
- método `POST`;
- timeout;
- payload máximo local;
- redirects desabilitados;
- fetch nativo;
- resposta limitada ao identificador necessário;
- mensagem de erro sem token.

Nenhuma URL fornecida pelo usuário é buscada e não há proxy aberto.

## Timeout e indisponibilidade

O prazo padrão é 24 horas. Expiração resulta em `EXPIRED`, nunca em decisão
automática. Falha temporária, timeout e HTTP 429/5xx são classificáveis para
retry limitado. Assinatura inválida, chat não autorizado, request expirado,
rejeição ou conflito nunca entram em retry automático.
