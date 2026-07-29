# sistemandrestudio-api

Este workspace contém as demonstrações CLI da máquina editorial e a API interna
de orquestração:

```bash
npm run demo
npm run demo:editorial-orchestration
npm run orchestration:serve
```

A API usa apenas bibliotecas nativas do Node.js, escuta por padrão em
`127.0.0.1:4317`, exige bearer secret e não oferece operação de publicação.
Ela só é iniciada por comando explícito. Console é o canal humano padrão;
Telegram requer configuração e ativação explícitas.
