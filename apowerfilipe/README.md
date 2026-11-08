# ⚡ ApowerFilipe

Agente local em **Node.js** para controlo remoto de periféricos: serve a interface
web e aplica os comandos recebidos por **WebSocket**.

```
apowerfilipe/
├── server.js          # HTTP + WebSocket + estado dos dispositivos
├── package.json
├── state.json         # criado automaticamente (estado persistido)
└── public/
    └── index.html     # interface (liga a ws://…/ws)
```

## Arrancar

```bash
cd apowerfilipe
npm install
npm start
```

Abrir **http://127.0.0.1:3000**

- `PORT=4000 npm start` — muda a porta
- `HOST=0.0.0.0 npm start` — expõe na rede local (cuidado: sem autenticação)

## Como funciona

1. O browser liga-se a `ws://127.0.0.1:3000/ws` e recebe o estado completo.
2. Cada ação da UI envia uma mensagem:

```json
{ "type": "command", "deviceId": "mouse1", "action": "set", "key": "dpi", "value": 1600 }
{ "type": "command", "deviceId": "mouse1", "action": "connect" }
{ "type": "command", "deviceId": "prn1",  "action": "invoke", "key": "test" }
{ "type": "sync" }
```

3. O servidor valida (tipo, limites, opções), aplica, registra no log e
   transmite o novo estado a todos os clientes.
4. O estado é gravado em `state.json`.

## Ligações reais ao hardware

Nesta versão os dispositivos são **simulados**. Para controlar hardware a
sério, substitui o corpo de `applyCommand()` em `server.js` por chamadas reais,
por exemplo:

| Periférico | Abordagem possível |
|---|---|
| Rato / teclado | `robotjs`, `@nut-tree/nut-js`, APIs do SO |
| Volume / colunas | `child_process` (ex.: `nircmd`, `amixer`, PowerShell) |
| Brilho do monitor | `brightness` (npm), `ddcutil` (Linux), WMI (Windows) |
| Impressora | CUPS (`lp`), Windows Print API, `pdf-to-printer` |
| Webcam | `ffmpeg`, `node-webcam` |
| Dispositivos USB/Bluetooth | `node-hid`, `noble`, ou WebHID no próprio browser |

## Notas de segurança

- Por omissão só escuta em `127.0.0.1`.
- Não há autenticação — se expuseres na rede, coloca um token/reverse proxy.
- Validação de comandos é feita no servidor (não confiar no cliente).
