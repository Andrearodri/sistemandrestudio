# Motor de conteúdo

Núcleo puro da máquina editorial. Contém:

- tipos da notícia, evidência, relevância, verificação, versões e aprovação;
- comandos e transições;
- erros com códigos estáveis;
- auditoria e idempotência;
- repositório em memória;
- oito cenários fictícios.

Nenhuma função acessa rede, banco, ambiente ou modelo externo. A especificação
está em `docs/STATE-MACHINE.md`.
