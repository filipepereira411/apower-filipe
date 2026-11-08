"use strict";

/**
 * ApowerFilipe — camada de hardware (Windows)
 * ------------------------------------------------------------
 * Executa scripts PowerShell e devolve valores normalizados.
 * Se APF_HARDWARE=0, tudo fica em modo simulado.
 *
 * Nota: a primeira chamada ao áudio compila C# (~15-20s em PCs antigos);
 * as seguintes usam a DLL em cache e demoram ~1s.
 */

const path = require("path");
const { execFile } = require("child_process");

const DIR = path.join(__dirname, "hardware");
const IS_WIN = process.platform === "win32";
const ENABLED = process.env.APF_HARDWARE !== "0";

function run(script, args, timeout) {
  return new Promise((resolve, reject) => {
    const file = path.join(DIR, script);
    const opts = {
      windowsHide: true,
      timeout: timeout || 20000,
      maxBuffer: 1024 * 1024
    };

    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file].concat(args || []),
      opts,
      (err, stdout, stderr) => {
        const text = String(stdout || "").trim();
        const line = text.split(/\r?\n/).filter(Boolean).pop() || "";

        let data = null;
        try { data = JSON.parse(line); } catch (e) { /* sem JSON */ }

        if (data) return resolve(data);

        const detail = String(stderr || "").trim() ||
          (err && (err.killed ? "Timeout ao executar " + script : err.message)) ||
          "Sem resposta do PowerShell";
        reject(new Error(detail));
      }
    );
  });
}

function guard() {
  if (!IS_WIN) throw new Error("Hardware real apenas suportado no Windows.");
  if (!ENABLED) throw new Error("Hardware desativado (APF_HARDWARE=0).");
}

/* ---------------- Áudio ---------------- */
async function audioGet() {
  guard();
  const r = await run("audio.ps1", ["get"], 45000);
  if (!r.ok) throw new Error(r.error || "Falha no áudio.");
  return { volume: Number(r.volume), muted: Boolean(r.muted) };
}

async function audioSet(percent) {
  guard();
  const r = await run("audio.ps1", ["set", String(Math.round(percent))], 45000);
  if (!r.ok) throw new Error(r.error || "Falha ao definir volume.");
  return { volume: Number(r.volume), muted: Boolean(r.muted) };
}

async function audioMute(shouldMute) {
  guard();
  const r = await run("audio.ps1", ["mute", shouldMute ? "1" : "0"], 45000);
  if (!r.ok) throw new Error(r.error || "Falha ao alterar mute.");
  return { volume: Number(r.volume), muted: Boolean(r.muted) };
}

/* ---------------- Brilho ---------------- */
async function brightnessGet() {
  guard();
  const r = await run("brightness.ps1", ["get"], 20000);
  if (!r.ok) throw new Error(r.error || "Brilho indisponível.");
  return { value: Number(r.value) };
}

async function brightnessSet(percent) {
  guard();
  const r = await run("brightness.ps1", ["set", String(Math.round(percent))], 20000);
  if (!r.ok) throw new Error(r.error || "Falha ao definir brilho.");
  return { value: Number(r.value) };
}

/* ---------------- Impressoras ---------------- */
async function printersList() {
  guard();
  const r = await run("printers.ps1", ["list"], 20000);
  if (!r.ok) throw new Error(r.error || "Falha ao listar impressoras.");
  const list = Array.isArray(r.printers) ? r.printers : [];
  return list
    .filter((p) => p && p.Name)
    .map((p) => ({
      name: String(p.Name),
      port: String(p.PortName || ""),
      driver: String(p.DriverName || "")
    }));
}

async function printerTest(name) {
  guard();
  const r = await run("printers.ps1", ["test", name], 20000);
  if (!r.ok) throw new Error(r.error || "Falha ao imprimir página de teste.");
  return true;
}

/* ---------------- Deteção de capacidades ---------------- */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(fn, tries) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await delay(800);
    }
  }
  throw lastErr;
}

async function detect() {
  const caps = {
    platform: process.platform,
    enabled: ENABLED,
    audio: false,
    volume: null,
    muted: null,
    brightness: false,
    brightnessValue: null,
    printers: []
  };

  if (!IS_WIN || !ENABLED) return caps;

  const [audio, bright, printers] = await Promise.allSettled([
    attempt(audioGet, 2),
    attempt(brightnessGet, 3),
    attempt(printersList, 2)
  ]);

  if (audio.status === "fulfilled") {
    caps.audio = true;
    caps.volume = audio.value.volume;
    caps.muted = audio.value.muted;
  }
  if (bright.status === "fulfilled") {
    caps.brightness = true;
    caps.brightnessValue = bright.value.value;
  }
  if (printers.status === "fulfilled") {
    caps.printers = printers.value;
  }

  return caps;
}

module.exports = {
  platform: process.platform,
  enabled: ENABLED,
  detect,
  audioGet,
  audioSet,
  audioMute,
  brightnessGet,
  brightnessSet,
  printersList,
  printerTest
};
