"use strict";

/**
 * ApowerFilipe — agente local
 * ------------------------------------------------------------
 * - Serve a interface em http://127.0.0.1:3000
 * - Expõe um WebSocket em /ws
 * - Mantém o estado dos periféricos e aplica comandos
 *
 * Nesta versão os dispositivos são simulados. Para hardware real,
 * substitui a função applyCommand() por chamadas ao driver/sistema
 * (ex.: child_process para ferramentas do SO, ou uma lib por tipo).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const STATE_FILE = path.join(__dirname, "state.json");

/* ============================================================
   Especificação de cada tipo (validação de comandos)
   ============================================================ */
const SPEC = {
  mouse: {
    label: "Rato",
    ranges: { dpi: [400, 3200], vol: [0, 100] },
    enums: { profile: ["Escritório", "Gaming", "Precisão"] },
    bools: ["rgb", "silent"],
    invokes: ["restart"]
  },
  keyboard: {
    label: "Teclado",
    ranges: { brightness: [0, 100] },
    enums: { layout: ["ABNT2", "QWERTY", "ISO PT"] },
    bools: ["rgb", "gameMode"],
    invokes: ["macro"]
  },
  speaker: {
    label: "Colunas",
    ranges: { vol: [0, 100], bass: [0, 100], treble: [0, 100] },
    enums: { eq: ["Equilibrado", "Voz", "Música", "Filmes"] },
    bools: ["mute"],
    invokes: []
  },
  printer: {
    label: "Impressora",
    ranges: {},
    enums: { quality: ["Rascunho", "Normal", "Alta"], paper: ["A4", "A5", "Carta"] },
    bools: ["eco", "duplex"],
    invokes: ["test"]
  },
  monitor: {
    label: "Monitor",
    ranges: { brightness: [0, 100], contrast: [0, 100] },
    enums: { res: ["1920×1080", "2560×1440", "3840×2160"] },
    bools: ["hdr", "eye"],
    invokes: []
  },
  webcam: {
    label: "Webcam",
    ranges: {},
    enums: { res: ["720p", "1080p", "1440p"], fps: ["30 fps", "60 fps"] },
    bools: ["mirror", "autoLight"],
    invokes: ["capture"]
  }
};

const INVOKE_TEXT = {
  restart: (d) => "Reinício enviado para " + d.name,
  test: (d) => "Página de teste enviada para " + d.name,
  capture: (d) => "Imagem capturada em " + d.name,
  macro: (d) => "Gravação de macro iniciada em " + d.name
};

/* ============================================================
   Estado
   ============================================================ */
function defaultState() {
  return {
    devices: [
      {
        id: "mouse1", type: "mouse", name: "Rato Sem Fios MX",
        model: "Apower M-350", ip: "192.168.1.24", latency: 12,
        battery: 78, online: true,
        values: { dpi: 1600, vol: 60, profile: "Escritório", rgb: true, silent: false }
      },
      {
        id: "kb1", type: "keyboard", name: "Teclado Mecânico K8",
        model: "Apower K-8 Pro", ip: "192.168.1.31", latency: 9,
        battery: 92, online: true,
        values: { brightness: 80, layout: "ABNT2", rgb: true, gameMode: false }
      },
      {
        id: "spk1", type: "speaker", name: "Colunas Bluetooth",
        model: "Apower Sound Mini", ip: "192.168.1.44", latency: 28,
        battery: 55, online: true,
        values: { vol: 45, bass: 60, treble: 50, eq: "Equilibrado", mute: false }
      },
      {
        id: "mon1", type: "monitor", name: "Monitor 27\"",
        model: "Apower Vision 27", ip: "192.168.1.60", latency: 6,
        battery: null, online: true,
        values: { brightness: 70, contrast: 55, res: "2560×1440", hdr: true, eye: false }
      },
      {
        id: "cam1", type: "webcam", name: "Webcam HD",
        model: "Apower Cam 1080", ip: "192.168.1.66", latency: 22,
        battery: null, online: true,
        values: { res: "1080p", fps: "30 fps", mirror: true, autoLight: true }
      },
      {
        id: "prn1", type: "printer", name: "Impressora Laser",
        model: "Apower Print L2", ip: "192.168.1.52", latency: 41,
        battery: null, online: false,
        values: { quality: "Normal", paper: "A4", eco: true, duplex: false }
      }
    ],
    log: []
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.devices) && parsed.devices.length) {
      if (!Array.isArray(parsed.log)) parsed.log = [];
      return parsed;
    }
  } catch (e) {
    /* primeiro arranque ou ficheiro inválido */
  }
  return defaultState();
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error("[estado] falha ao gravar:", err.message);
    });
  }, 400);
}

function addLog(msg) {
  state.log.unshift({ t: new Date().toISOString(), msg });
  if (state.log.length > 60) state.log.length = 60;
}

/* ============================================================
   Aplicação de comandos
   ============================================================ */
function findDevice(id) {
  return state.devices.find((d) => d.id === id);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function applyCommand(device, action, payload) {
  if (!device) return { ok: false, error: "Dispositivo não encontrado." };

  if (action === "connect") {
    if (device.online) return { ok: false, error: "Já está ligado." };
    device.online = true;
    device.latency = 6 + Math.round(Math.random() * 26);
    addLog("Dispositivo ligado: " + device.name);
    return { ok: true };
  }

  if (action === "disconnect") {
    if (!device.online) return { ok: false, error: "Já está desligado." };
    device.online = false;
    addLog("Dispositivo desligado: " + device.name);
    return { ok: true };
  }

  if (action === "sync") return { ok: true };

  const spec = SPEC[device.type];
  if (!spec) return { ok: false, error: "Tipo de dispositivo desconhecido." };

  if (action === "set") {
    if (!device.online) return { ok: false, error: "Dispositivo desligado." };
    const key = payload && payload.key;
    const raw = payload && payload.value;

    if (key in spec.ranges) {
      const [min, max] = spec.ranges[key];
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: "Valor inválido." };
      device.values[key] = clamp(Math.round(n), min, max);
      addLog("Ajuste: " + key + " = " + device.values[key] + " (" + device.name + ")");
      return { ok: true };
    }

    if (key in spec.enums) {
      if (!spec.enums[key].includes(raw)) return { ok: false, error: "Opção inválida." };
      device.values[key] = raw;
      addLog("Definição: " + key + " = " + raw + " (" + device.name + ")");
      return { ok: true };
    }

    if (spec.bools.includes(key)) {
      device.values[key] = Boolean(raw);
      addLog((device.values[key] ? "Ativado" : "Desativado") + ": " + key + " (" + device.name + ")");
      return { ok: true };
    }

    return { ok: false, error: "Propriedade desconhecida." };
  }

  if (action === "invoke") {
    if (!device.online) return { ok: false, error: "Dispositivo desligado." };
    const key = payload && payload.key;
    if (!spec.invokes.includes(key)) return { ok: false, error: "Ação desconhecida." };
    addLog((INVOKE_TEXT[key] || (() => "Ação " + key))(device));
    return { ok: true };
  }

  return { ok: false, error: "Ação desconhecida." };
}

/* ============================================================
   WebSocket
   ============================================================ */
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: "/ws" });

function snapshot() {
  return JSON.stringify({
    type: "state",
    devices: state.devices,
    log: state.log,
    serverTime: Date.now()
  });
}

function broadcast() {
  const payload = snapshot();
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.send(snapshot());

  socket.on("pong", () => { socket.isAlive = true; });

  socket.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      return socket.send(JSON.stringify({ type: "error", error: "JSON inválido." }));
    }

    if (!msg || typeof msg !== "object") return;

    if (msg.type === "hello") {
      socket.send(snapshot());
      return;
    }

    if (msg.type === "sync") {
      state.devices.forEach((d) => { d.online = true; });
      addLog("Sincronização global concluída (" + state.devices.length + " dispositivos)");
      saveState();
      broadcast();
      return;
    }

    if (msg.type === "command") {
      const device = findDevice(msg.deviceId);
      const result = applyCommand(device, msg.action, msg);
      if (result.ok) {
        saveState();
        broadcast();
      } else {
        socket.send(JSON.stringify({ type: "error", error: result.error }));
      }
    }
  });
});

const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    client.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

/* Latência simulada a variar */
setInterval(() => {
  let changed = false;
  for (const d of state.devices) {
    if (!d.online) continue;
    const delta = Math.round((Math.random() - 0.5) * 6);
    const next = Math.max(4, Math.min(90, d.latency + delta));
    if (next !== d.latency) { d.latency = next; changed = true; }
  }
  if (changed) broadcast();
}, 5000);

/* ============================================================
   Servidor HTTP estático
   ============================================================ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8"
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (e) {
    res.writeHead(400).end("Pedido inválido");
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("Proibido");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 — não encontrado");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300"
    });
    res.end(data);
  });
}

/* ============================================================
   Arranque / encerramento
   ============================================================ */
if (!state.log.length) {
  addLog("ApowerFilipe iniciado — " + state.devices.length + " dispositivos encontrados");
}

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ⚡ ApowerFilipe — agente local");
  console.log("  ─────────────────────────────────────");
  console.log("  Interface : http://" + HOST + ":" + PORT);
  console.log("  WebSocket : ws://" + HOST + ":" + PORT + "/ws");
  console.log("  Estado    : " + STATE_FILE);
  console.log("");
  console.log("  Ctrl+C para terminar.");
  console.log("");
});

function shutdown() {
  console.log("\n[agente] a encerrar…");
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
  clearInterval(heartbeat);
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
