# Integração restrita com Hermes

Esta integração é fixada ao contrato público do `hermes-agent==0.19.0` e não
inicia agente, gateway, modelo, Telegram, cron ou serviço persistente.

O plugin registra uma única ferramenta, `sistemandrestudio_read`. O wrapper
usa os parâmetros públicos `enabled_toolsets` do `AIAgent` e
`get_tool_definitions` de `model_tools`, sempre com o toolset explícito
`sistemandrestudio_readonly`. Ele também recusa uma distribuição instalada
cuja versão não seja `0.19.0`. Depois da resolução, uma verificação fail-closed
interrompe a inicialização se a lista final não for exatamente:

```text
["sistemandrestudio_read"]
```

A ferramenta aceita apenas oito operações nomeadas e monta internamente
requisições `GET` para `http://127.0.0.1:4317`. Não existe argumento para URL,
método, headers, corpo ou host. A credencial exclusiva de leitura é obtida
somente de `EDITORIAL_READ_API_SECRET`.

O teste manual com modelo usa uma projeção ainda menor, definida em
`manual_runner.py`. O schema apresentado ao modelo contém somente `operation`
e `limit`, com enum fechado para `health`, `system_status`,
`list_pending_decisions` e `list_editorial_items`. Cada tool call pode conter
uma única operação; até quatro chamadas locais são validadas como lote antes
de qualquer dispatch e executadas sequencialmente. `limit` é exclusivo da
listagem editorial, assume 25 e não pode exceder 100. As duas chamadas futuras
ao modelo permanecem com `parallel_tool_calls=false`, sem retry ou fallback.

O runner aceita somente as representações de argumentos confirmadas no Hermes
0.19.0: um objeto JSON completo em texto ou um dicionário já desserializado
em `function.arguments`. Texto livre, blocos Markdown, JSON duplamente
serializado e valores que não sejam objetos são rejeitados. Em uma execução
supervisionada futura, a observabilidade registra apenas nome da ferramenta,
tipo estrutural, nomes das propriedades, tamanho, SHA-256 e código estável de
validação — nunca valores, prompt, resposta, token ou Bearer.

Antes de qualquer uso futuro, o diretório `integrations/hermes` completo deve
ser instalado como
`$HERMES_HOME/plugins/sistemandrestudio-readonly`. O manifesto `plugin.yaml`
e o entrypoint `__init__.py` ficam diretamente nessa raiz, conforme a
descoberta oficial do Hermes 0.19.0. A configuração privada deve habilitar
explicitamente o plugin:

```yaml
plugins:
  enabled:
    - sistemandrestudio-readonly
```

A ativação deve chamar `create_restricted_agent`; usar o entrypoint padrão do
Hermes sem esse wrapper não pertence a este contrato de segurança.
