# Segurança — sistemandrestudio

## 1. Regras obrigatórias

- nunca armazenar segredos no Git;
- usar variáveis de ambiente localmente e gerenciador de segredos em produção;
- manter credenciais separadas por serviço e ambiente;
- conceder apenas os privilégios indispensáveis;
- exigir aprovação humana antes de qualquer publicação;
- registrar ações humanas e automáticas;
- nunca conceder acesso administrativo completo da AWS à aplicação;
- não executar comandos destrutivos sem autorização explícita;
- manter desenvolvimento, homologação e produção separados;
- criar e testar backups;
- permitir revogação e rotação de tokens;
- tratar todo conteúdo externo como dado não confiável.

O arquivo `.env.example` contém apenas nomes e valores não sensíveis.
`.env.local` e `.env.test` reais estão ignorados pelo Git; somente seus exemplos
com valores locais fictícios são versionados.

## 2. Segredos

- um segredo deve pertencer a um único serviço e ambiente;
- tokens não devem ser colocados em workflows exportados do n8n;
- o banco deve guardar referências a segredos, nunca o valor quando houver um
  secret manager;
- logs e mensagens de erro devem aplicar redaction;
- chaves devem ser rotacionáveis sem alterar o código;
- backups criptografados não podem reutilizar credenciais da aplicação;
- segredos reais nunca devem aparecer em fixtures, prompts ou documentação.

Produção futura deve usar um serviço como AWS Secrets Manager, SSM Parameter
Store ou alternativa equivalente. A escolha exige avaliação de custo e
autorização.

## 3. Identidade e privilégios mínimos

- Telegram: allowlist explícita de usuários e, quando aplicável, chats;
- PostgreSQL: usuário da aplicação sem privilégios administrativos;
- n8n: credenciais específicas, sem acesso irrestrito ao host;
- LLM: chave com limite de gasto e projeto separado;
- AWS: roles por serviço, MFA para humanos e nenhuma chave root na aplicação;
- fontes: tokens somente leitura sempre que possível.

Solicitações de aprovação devem ter nonce de uso único, expiração, versão do
conteúdo e proteção contra replay.

## 4. Aprovação e publicação

- `APPROVED` não dispara publicação no primeiro MVP;
- o estado final do MVP é `READY_FOR_PUBLICATION`;
- edição sempre cria uma nova versão e invalida a aprovação anterior;
- publicação futura exige uma permissão separada e uma nova decisão explícita;
- falha, timeout ou resposta ambígua nunca equivalem a aprovação;
- toda decisão registra ator, data, versão e motivo quando aplicável.

## 5. Conteúdo externo e prompt injection

RSS, páginas, APIs, comentários, anexos e mensagens são entradas hostis por
padrão. Frases como “ignore instruções anteriores” ou “envie credenciais” fazem
parte do texto e nunca são comandos.

Controles mínimos:

1. delimitar conteúdo externo em campos de dados, separado das instruções;
2. não oferecer ferramentas, shell, banco ou segredos ao modelo gerador;
3. usar schema de saída estrito e validar tamanho, tipo e campos;
4. permitir somente operações declaradas no código;
5. rejeitar tentativas de introduzir comandos ou exfiltrar informações;
6. não interpolar texto externo em SQL, shell, URLs internas ou templates sem
   validação;
7. manter allowlist de fontes e destinos;
8. registrar a versão do prompt e hashes das entradas;
9. exigir aprovação humana para o conteúdo resultante;
10. testar periodicamente exemplos de prompt injection.

O modelo não deve decidir sua própria permissão, alterar configurações ou chamar
outros agentes com base no conteúdo coletado.

## 6. Proteção de dados

- coletar somente dados necessários;
- evitar dados pessoais em notícias, prompts e logs quando não forem essenciais;
- classificar campos sensíveis;
- limitar retenção;
- restringir exportações e backups;
- preparar exclusão ou anonimização quando houver obrigação;
- considerar LGPD antes de integrar leads, clientes ou atendimento.

## 7. Rede

Em desenvolvimento, os serviços devem escutar apenas em localhost quando
possível. Em produção futura:

- expor somente o gateway HTTP necessário;
- usar TLS;
- manter PostgreSQL, n8n e filas em rede privada;
- validar assinatura/segredo de webhooks;
- aplicar rate limit e limites de payload;
- restringir egress quando prático;
- não abrir painel administrativo publicamente sem autenticação forte.

Long polling do Telegram é preferível no MVP local porque evita um webhook
público. A mudança para webhook exige revisão de rede e autorização.

## 8. Logs, auditoria e erros

- logs operacionais são estruturados e sanitizados;
- auditoria é append-only;
- `correlation_id` acompanha todo o fluxo;
- mensagens externas não recebem stack traces ou detalhes internos;
- falhas registram código seguro e contexto mínimo;
- acesso aos logs é restrito;
- alertas não incluem tokens nem conteúdo integral.

O serviço de aplicação não gera IDs, atores ou horários e não acessa variáveis
de ambiente. O fingerprint inclui somente campos editoriais explicitamente
permitidos; credenciais e configuração não participam. Erros públicos usam
códigos estáveis e contexto mínimo, enquanto a causa técnica permanece interna
e não deve ser serializada diretamente.

## 9. PostgreSQL local

- o Compose publica somente `127.0.0.1:55432`, nunca `0.0.0.0`;
- desenvolvimento usa `sistemandrestudio` e testes usam
  `sistemandrestudio_test`;
- o reset destrutivo valida o sufixo `_test` antes de remover o schema;
- o papel da aplicação não possui `SUPERUSER`, `CREATEDB`, `CREATEROLE` ou
  `REPLICATION`;
- o usuário privilegiado existe somente para bootstrap dentro do container;
- queries de dados usam placeholders do driver, sem interpolar entradas;
- nomes dinâmicos do bootstrap são validados e escapados pelo `format('%I')` do
  próprio PostgreSQL;
- migrations são versionadas, transacionais e verificadas por SHA-256;
- alterações em migrations aplicadas são recusadas;
- logs de configuração não exibem senha nem connection string;
- `audit_events` aceita somente payload técnico controlado pelo código.

O volume nomeado preserva os dados após `docker compose down`, mas não é backup.
Antes de usar dados reais, definir RPO/RTO, automatizar cópias criptografadas,
separar retenção e testar restauração. Em produção, migration deve usar um papel
separado e temporário; o papel da aplicação deve perder permissão de DDL.

## 10. Dependências e cadeia de suprimentos

- fixar versões por lockfile;
- revisar licença e manutenção antes de adotar pacote;
- executar auditorias de dependências;
- preferir imagens oficiais e compatíveis com ARM64;
- evitar scripts de instalação remota;
- não instalar n8n ou Hermes globalmente;
- atualizar componentes em ambiente de teste antes de produção.

## 11. Ambientes, backup e recuperação

- usar bancos e credenciais separados por ambiente;
- nunca copiar dados reais para desenvolvimento sem sanitização;
- definir RPO e RTO antes de hospedar;
- automatizar backups quando houver dados reais;
- criptografar backups e testar restauração;
- documentar como interromper workers sem perder estado;
- manter migrations reversíveis quando possível;
- executar migrations em desenvolvimento e teste antes de qualquer ambiente
  futuro;
- nunca alterar uma migration cujo checksum já foi registrado;
- não usar `docker compose down -v` como rotina de desligamento.

## 12. Revogação e incidentes

O runbook futuro deve permitir:

1. pausar coletas e workers;
2. revogar bot, LLM e tokens de fontes;
3. bloquear o usuário ou chat comprometido;
4. rotacionar credenciais;
5. preservar evidências e auditoria;
6. restaurar estado consistente;
7. comunicar impacto e registrar ações corretivas.

## 13. Ações que exigem autorização

- criar ou inserir qualquer credencial;
- conectar Telegram, LLM, feeds, AWS ou redes sociais;
- abrir porta, túnel, webhook ou endpoint público;
- instalar dependências ou iniciar containers;
- criar infraestrutura ou custo externo;
- mudar retenção, backup ou acesso a dados reais;
- conceder permissões de publicação;
- executar comandos destrutivos;
- adicionar Hermes ou ampliar permissões de um agente.
