"use strict";

/**
 * ApowerFilipe — agente local
 * ------------------------------------------------------------
 * - Serve a interface em http://127.0.0.1:3000
 * - Expõe um WebSocket em /ws
 * - Mantém o estado dos periféricos e aplica comandos
 * - Permite adicionar, editar, remover, ligar e desligar periféricos
 *
 * Os dispositivos de áudio, brilho e impressoras são controlados no
 * hardware real via PowerShell (hardware.js). Os restantes são
 * simulados. Define APF_HARDWARE=0 para forçar tudo em simulação.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");
const hw = require("./hardware");

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

const DEFAULT_VALUES = {
  mouse: { dpi: 1200, vol: 50, profile: "Escritório", rgb: false, silent: false },
  keyboard: { brightness: 60, layout: "ABNT2", rgb: false, gameMode: false },
  speaker: { vol: 40, bass: 50, treble: 50, eq: "Equilibrado", mute: false },
  printer: { quality: "Normal", paper: "A4", eco: true, duplex: false },
  monitor: { brightness: 60, contrast: 50, res: "1920×1080", hdr: false, eye: false },
  webcam: { res: "1080p", fps: "30 fps", mirror: false, autoLight: false }
};

const HAS_BATTERY = new Set(["mouse", "keyboard", "speaker"]);
const MAX_DEVICES = 100;

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
    log: [],
    ignored: []
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.devices) && parsed.devices.length) {
      if (!Array.isArray(parsed.log)) parsed.log = [];
      if (!Array.isArray(parsed.ignored)) parsed.ignored = [];
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

function isRealControl(device, key) {
  if (!device.hw) return false;
  if (device.hwKind === "audio") return key === "vol" || key === "mute";
  if (device.hwKind === "brightness") return key === "brightness";
  return false;
}

async function applyHardware(device, key, value) {
  if (device.hwKind === "audio") {
    if (key === "vol") return hw.audioSet(value);
    if (key === "mute") return hw.audioMute(Boolean(value));
  } else if (device.hwKind === "brightness") {
    return hw.brightnessSet(value);
  }
  return null;
}

function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Valida um valor de definição face à especificação do tipo. */
function validateValue(spec, key, raw) {
  if (Object.prototype.hasOwnProperty.call(spec.ranges, key)) {
    const [min, max] = spec.ranges[key];
    const n = Number(raw);
    if (raw === "" || raw === null || !Number.isFinite(n)) return { ok: false, error: "Valor inválido para " + key + "." };
    const target = clamp(Math.round(n), min, max);
    return { ok: true, target, label: "Ajuste: " + key + " = " + target };
  }
  if (Object.prototype.hasOwnProperty.call(spec.enums, key)) {
    if (!spec.enums[key].includes(raw)) return { ok: false, error: "Opção inválida para " + key + "." };
    return { ok: true, target: raw, label: "Definição: " + key + " = " + raw };
  }
  if (spec.bools.includes(key)) {
    const target = Boolean(raw);
    return { ok: true, target, label: (target ? "Ativado" : "Desativado") + ": " + key };
  }
  return { ok: false, error: "Propriedade desconhecida." };
}

/** Aplica um valor já validado (no hardware real, se existir) e grava-o. */
async function storeValue(device, key, v) {
  let hwInfo = "";
  const real = isRealControl(device, key);
  if (real) {
    try {
      const r = await applyHardware(device, key, v.target);
      if (r && typeof r.volume === "number") {
        hwInfo = " → OS " + r.volume + "%" + (r.muted ? " (mudo)" : "");
      } else if (r && typeof r.value === "number") {
        hwInfo = " → OS " + r.value + "%";
      }
    } catch (err) {
      return { ok: false, error: "Hardware: " + err.message };
    }
  }
  device.values[key] = v.target;
  addLog((real ? "HW · " : "") + v.label + " (" + device.name + ")" + hwInfo);
  return { ok: true };
}

/** Valida os campos de identificação (nome, modelo, ip, bateria). */
function readInfo(msg, type, partial) {
  const info = {};
  if (!partial || msg.name !== undefined) {
    info.name = cleanText(msg.name, 60);
    if (!info.name) return { error: "O nome é obrigatório." };
  }
  if (!partial || msg.model !== undefined) info.model = cleanText(msg.model, 60);
  if (!partial || msg.ip !== undefined) info.ip = cleanText(msg.ip, 64);
  if (msg.battery !== undefined && HAS_BATTERY.has(type)) {
    if (msg.battery === null || msg.battery === "") {
      info.battery = null;
    } else {
      const n = Number(msg.battery);
      if (!Number.isFinite(n)) return { error: "Bateria inválida." };
      info.battery = clamp(Math.round(n), 0, 100);
    }
  }
  return { info };
}

function newId(type) {
  let id;
  do {
    id = type + "-" + Math.random().toString(36).slice(2, 8);
  } while (findDevice(id));
  return id;
}

function addDevice(msg) {
  if (!SPEC[msg.deviceType]) return { ok: false, error: "Tipo de dispositivo inválido." };
  if (state.devices.length >= MAX_DEVICES) return { ok: false, error: "Limite de dispositivos atingido." };

  const type = msg.deviceType;
  const r = readInfo(msg, type, false);
  if (r.error) return { ok: false, error: r.error };

  const device = {
    id: newId(type),
    type,
    name: r.info.name,
    model: r.info.model,
    ip: r.info.ip,
    latency: 6 + Math.round(Math.random() * 26),
    battery: HAS_BATTERY.has(type) ? (r.info.battery === undefined ? 100 : r.info.battery) : null,
    online: true,
    values: Object.assign({}, DEFAULT_VALUES[type])
  };
  state.devices.push(device);
  addLog("Dispositivo adicionado: " + device.name);
  return { ok: true };
}

async function updateDevice(device, msg) {
  const spec = SPEC[device.type];
  if (!spec) return { ok: false, error: "Tipo de dispositivo desconhecido." };

  const r = readInfo(msg, device.type, true);
  if (r.error) return { ok: false, error: r.error };

  // Valida todas as definições antes de aplicar qualquer uma
  const pending = [];
  const incoming = msg.values && typeof msg.values === "object" ? msg.values : {};
  for (const key of Object.keys(incoming)) {
    const v = validateValue(spec, key, incoming[key]);
    if (!v.ok) return { ok: false, error: v.error };
    if (device.values[key] !== v.target) pending.push([key, v]);
  }
  if (pending.length && !device.online) {
    return { ok: false, error: "Liga o dispositivo para alterar as definições." };
  }

  const before = device.name;
  Object.assign(device, r.info);
  if (r.info.name && r.info.name !== before) addLog("Dispositivo renomeado: " + before + " → " + device.name);
  else addLog("Dispositivo editado: " + device.name);

  for (const [key, v] of pending) {
    const res = await storeValue(device, key, v);
    if (!res.ok) return { ok: false, error: res.error, changed: true };
  }
  return { ok: true };
}

function removeDevice(device) {
  state.devices = state.devices.filter((d) => d !== device);
  // Evita que a deteção automática volte a criar dispositivos removidos
  if (device.hwKind === "printer" || ["spk1", "mon1", "prn1"].includes(device.id)) {
    if (!state.ignored.includes(device.id)) state.ignored.push(device.id);
  }
  addLog("Dispositivo removido: " + device.name);
  return { ok: true };
}

async function applyCommand(device, action, payload) {
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

  if (action === "remove") return removeDevice(device);
  if (action === "update") return updateDevice(device, payload || {});
  if (action === "sync") return { ok: true };

  const spec = SPEC[device.type];
  if (!spec) return { ok: false, error: "Tipo de dispositivo desconhecido." };

  if (action === "set") {
    if (!device.online) return { ok: false, error: "Dispositivo desligado." };
    const key = payload && payload.key;
    const v = validateValue(spec, key, payload && payload.value);
    if (!v.ok) return v;
    return storeValue(device, key, v);
  }

  if (action === "invoke") {
    if (!device.online) return { ok: false, error: "Dispositivo desligado." };
    const key = payload && payload.key;
    if (!spec.invokes.includes(key)) return { ok: false, error: "Ação desconhecida." };

    if (key === "test" && device.hwKind === "printer" && device.hwName) {
      try {
        await hw.printerTest(device.hwName);
      } catch (err) {
        return { ok: false, error: "Hardware: " + err.message };
      }
    }

    addLog((INVOKE_TEXT[key] || (() => "Ação " + key))(device));
    return { ok: true };
  }

  return { ok: false, error: "Ação desconhecida." };
}

/* ============================================================
   Mapeamento do hardware detetado → dispositivos do painel
   ============================================================ */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28) || "printer";
}

function applyHardwareCaps(caps) {
  const ignored = (id) => state.ignored.includes(id);
  const builtin = (id) => defaultState().devices.find((d) => d.id === id);

  // Colunas → volume/mute reais do sistema
  let speaker = state.devices.find((d) => d.hwKind === "audio") ||
                state.devices.find((d) => d.id === "spk1");
  if (!speaker && caps.audio && !ignored("spk1")) {
    speaker = builtin("spk1");
    state.devices.push(speaker);
  }
  if (speaker) {
    speaker.hw = Boolean(caps.audio);
    speaker.hwKind = caps.audio ? "audio" : null;
    if (caps.audio) {
      if (Number.isFinite(caps.volume)) speaker.values.vol = caps.volume;
      if (typeof caps.muted === "boolean") speaker.values.mute = caps.muted;
    }
  }

  // Monitor → brilho real do ecrã
  let monitor = state.devices.find((d) => d.hwKind === "brightness") ||
                state.devices.find((d) => d.id === "mon1");
  if (!monitor && caps.brightness && !ignored("mon1")) {
    monitor = builtin("mon1");
    state.devices.push(monitor);
  }
  if (monitor) {
    monitor.hw = Boolean(caps.brightness);
    monitor.hwKind = caps.brightness ? "brightness" : null;
    if (caps.brightness && Number.isFinite(caps.brightnessValue)) {
      monitor.values.brightness = caps.brightnessValue;
    }
  }

  // Impressoras reais do Windows
  const realPrinters = state.devices.filter((d) => d.hwKind === "printer");
  const byName = new Map(realPrinters.map((d) => [d.hwName, d]));
  const keep = new Set();

  (caps.printers || []).slice(0, 6).forEach((p) => {
    const id = "prnos-" + slugify(p.name);
    if (ignored(id)) return;
    keep.add(p.name);

    let dev = byName.get(p.name);
    if (!dev) {
      dev = {
        id,
        type: "printer",
        name: p.name,
        model: "Impressora Windows",
        ip: p.port || "local",
        latency: 3,
        battery: null,
        online: true,
        hw: true,
        hwKind: "printer",
        hwName: p.name,
        values: { quality: "Normal", paper: "A4", eco: true, duplex: false }
      };
      state.devices.push(dev);
    } else {
      // Mantém nome/IP/estado que o utilizador tenha editado
      dev.hw = true;
    }
  });

  // Remove impressoras reais que já não existem no Windows
  state.devices = state.devices.filter(
    (d) => d.hwKind !== "printer" || keep.has(d.hwName)
  );

  // A impressora fictícia só aparece quando não há impressoras reais
  const anyPrinterReal = keep.size > 0;
  if (anyPrinterReal) {
    state.devices = state.devices.filter((d) => d.id !== "prn1");
  } else if (!state.devices.some((d) => d.id === "prn1") && !ignored("prn1") &&
             !state.devices.some((d) => d.type === "printer")) {
    const fallback = builtin("prn1");
    if (fallback) state.devices.push(fallback);
  }

  saveState();
}

/* ============================================================
   WebSocket
   ============================================================ */
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Impede que outros sites abertos no browser controlem o agente
  verifyClient: (info) => {
    const origin = info.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === info.req.headers.host;
    } catch (e) {
      return false;
    }
  }
});

function snapshot() {
  return JSON.stringify({
    type: "state",
    devices: state.devices,
    log: state.log,
    spec: SPEC,
    batteryTypes: Array.from(HAS_BATTERY),
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

  socket.on("message", async (buf) => {
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

    if (msg.type === "redetect") {
      state.ignored = [];
      try {
        await detectHardware();
      } catch (err) {
        socket.send(JSON.stringify({ type: "error", error: "Deteção falhou: " + err.message }));
      }
      return;
    }

    if (msg.type === "command") {
      let result;
      try {
        if (msg.action === "add") {
          result = addDevice(msg);
        } else {
          result = await applyCommand(findDevice(msg.deviceId), msg.action, msg);
        }
      } catch (err) {
        result = { ok: false, error: "Erro interno: " + err.message };
      }

      if (result.ok || result.changed) {
        saveState();
        broadcast();
      }
      if (!result.ok) {
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
async function bootstrap() {
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
    console.log("  Hardware  : a detetar…");
    console.log("");
    console.log("  Ctrl+C para terminar.");
    console.log("");
  });

  // Deteção em segundo plano: o servidor fica disponível imediatamente
  try {
    await detectHardware();
  } catch (err) {
    console.error("[hardware] deteção falhou:", err.message);
  }
}

let detecting = false;
async function detectHardware() {
  if (detecting) return;
  detecting = true;
  try {
    const caps = await hw.detect();
    applyHardwareCaps(caps);

    const parts = [];
    if (caps.audio) parts.push("áudio");
    if (caps.brightness) parts.push("brilho");
    if (caps.printers.length) parts.push(caps.printers.length + " impressora(s)");

    addLog("Hardware real detetado: " + (parts.length ? parts.join(", ") : "nenhum (modo simulado)"));
    saveState();
    broadcast();

    console.log("[hardware] " + (parts.length ? parts.join(", ") : "nenhum — modo simulado"));
  } finally {
    detecting = false;
  }
}

bootstrap();

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
