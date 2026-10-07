/* Gemma Display, reines JS ohne Framework und ohne CDN.
   Teile: Uhr, Wake Lock mit Video-Fallback, Vollbild/Kiosk,
   WebSocket zur Gemma-Live-Bridge, Verlauf-Poll. */

"use strict";

const CFG = Object.assign({
  token: "",
  geraete: [],
  verlaufSek: 20,
  wsZyklusSek: 60,
  wsBackoffStartSek: 45,
  wsBackoffMaxSek: 360,
  version: "webui-1.0"
}, window.GEMMA_CONFIG || {});

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  wsOnline: false,
  sessionBereit: false,
  backoffSek: CFG.wsBackoffStartSek,
  wsZyklusTimer: null,
  wsNaechsterVersuch: 0,
  lockTyp: null,
  lockSentinel: null,
  video: null,
  antwortText: "",
  antwortQuelle: "",
  antwortZeit: null,
  geraetName: "",
  gespraechZeit: null,
  aktivBis: 0
};

/* ---------------- Uhr und Datum ---------------- */

function uhrTicken() {
  const jetzt = new Date();
  $("uhr").textContent = jetzt.toLocaleTimeString("de-DE", {
    hour: "2-digit", minute: "2-digit"
  });
  $("datum").textContent = jetzt.toLocaleDateString("de-DE", {
    weekday: "long", day: "numeric", month: "long"
  });
}

/* ---------------- Kacheln ---------------- */

function kachel(id, wert, zusatz, zustand) {
  const el = $(id);
  if (!el) return;
  el.querySelector(".kachel-wert").textContent = wert;
  el.querySelector(".kachel-zusatz").textContent = zusatz;
  el.classList.remove("ok", "warn", "fehler");
  if (zustand) el.classList.add(zustand);
}

function badge(id, text, klasse) {
  const el = $(id);
  el.textContent = text;
  el.className = "badges " + klasse;
}

function relZeit(ts) {
  if (!ts) return "";
  const s = Math.round(Date.now() / 1000 - ts);
  if (s < 60) return "gerade eben";
  if (s < 3600) return "vor " + Math.floor(s / 60) + " Min";
  if (s < 86400) return "vor " + Math.floor(s / 3600) + " Std";
  return "vor " + Math.floor(s / 86400) + " Tagen";
}

function orbSetzen(zustand, text) {
  const orb = $("orb");
  orb.classList.toggle("aktiv", zustand === "aktiv");
  orb.classList.toggle("aus", zustand === "aus");
  $("orb-status").textContent = text;
}

function aktivBlinken(sek) {
  state.aktivBis = Date.now() + sek * 1000;
}

function antwortAnzeigen(text, quelle, ts) {
  if (!text) return;
  state.antwortText = text;
  state.antwortQuelle = quelle;
  state.antwortZeit = ts || Math.floor(Date.now() / 1000);
  $("antwort").textContent = text;
  $("antwort-meta").textContent = quelle + " · " + relZeit(state.antwortZeit);
}

/* ---------------- WebSocket zur Bruecke ---------------- */

function wsUrl() {
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("device", "show15");
  p.set("version", CFG.version);
  return "wss://" + location.host + "/gemma-live/ws?" + p.toString();
}

function wsVerbinden() {
  if (state.ws) return;
  if (document.hidden) {
    wsNaechstenVersuchPlanen();
    return;
  }
  kachel("k-session", "verbindet", "Anfrage läuft", "warn");
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    wsNachEnde();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.wsOnline = true;
    state.sessionBereit = false;
    badge("f-ws", "WS online", "badge-ok");
    kachel("k-bruecke", "online", "Brücke antwortet", "ok");
    orbSetzen("idle", "bereit");
    state.wsZyklusTimer = setTimeout(() => {
      try { ws.close(1000, "zyklus"); } catch (e) {}
    }, CFG.wsZyklusSek * 1000);
  };

  ws.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    switch (d.typ) {
      case "bereit":
        state.sessionBereit = true;
        state.backoffSek = CFG.wsBackoffStartSek;
        kachel("k-session", "bereit", "Gemini verbunden", "ok");
        kachel("k-bruecke", "online", "Brücke antwortet", "ok");
        break;
      case "gemma":
        if (d.text) antwortAnzeigen(d.text, "live", null);
        aktivBlinken(12);
        break;
      case "du":
        aktivBlinken(12);
        break;
      case "denkt":
      case "werkzeug":
        aktivBlinken(15);
        break;
      case "zug_ende":
        aktivBlinken(8);
        break;
      case "fehler":
        kachel("k-session", "Fehler", String(d.text || "").slice(0, 60), "fehler");
        break;
      case "ende":
        try { ws.close(1000, "ende"); } catch (e) {}
        break;
    }
  };

  ws.onclose = () => {
    if (state.wsZyklusTimer) { clearTimeout(state.wsZyklusTimer); state.wsZyklusTimer = null; }
    state.ws = null;
    wsNachEnde();
  };

  ws.onerror = () => {
    try { ws.close(); } catch (e) {}
  };
}

function wsNachEnde() {
  state.wsOnline = false;
  state.sessionBereit = false;
  badge("f-ws", "WS aus", "badge-aus");
  kachel("k-bruecke", "offline", "Brücke nicht verbunden", "fehler");
  kachel("k-session", "inaktiv", "keine Session", "");
  orbSetzen(Date.now() < state.aktivBis ? "aktiv" : "aus",
    Date.now() < state.aktivBis ? "aktiv" : "offline");
  wsNaechstenVersuchPlanen();
}

function wsNaechstenVersuchPlanen() {
  if (state.wsNaechsterVersuch && state.wsNaechsterVersuch > Date.now()) return;
  const jitter = Math.round(Math.random() * 8000);
  const pause = state.backoffSek * 1000 + jitter;
  state.wsNaechsterVersuch = Date.now() + pause;
  kachel("k-bruecke", "offline", "neuer Versuch in " + Math.round(pause / 1000) + " s", "fehler");
  setTimeout(() => {
    state.backoffSek = Math.min(
      Math.round(state.backoffSek * 1.6), CFG.wsBackoffMaxSek);
    state.wsNaechsterVersuch = 0;
    wsVerbinden();
  }, pause);
}

/* ---------------- Verlauf: letzte echte Antwort ---------------- */

async function verlaufHolen(dev) {
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("t", Date.now());
  const r = await fetch("/gemma-live/verlauf/" + encodeURIComponent(dev) +
    ".json?" + p.toString(), { cache: "no-store" });
  if (!r.ok) return null;
  const d = await r.json();
  const msgs = (d.messages || []).filter((m) => m && m.content);
  let letzte = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "assistant") { letzte = msgs[i]; break; }
  }
  return {
    ts: d.ts || 0,
    text: letzte ? letzte.content : "",
    msgs: msgs.length,
    dev: dev
  };
}

async function verlaufPoll() {
  if (!CFG.token || !CFG.geraete.length) {
    kachel("k-gespraech", "—", "kein Token konfiguriert", "warn");
    return;
  }
  const ergebnisse = await Promise.all(
    CFG.geraete.map((g) => verlaufHolen(g).catch(() => null)));
  const gueltige = ergebnisse.filter((e) => e && e.text);
  if (!gueltige.length) return;
  gueltige.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const frisch = gueltige[0];
  state.geraetName = frisch.dev;
  state.gespraechZeit = frisch.ts || null;
  const lebt = state.antwortQuelle === "live" &&
    Date.now() / 1000 - (state.antwortZeit || 0) < 600;
  if (!lebt) antwortAnzeigen(frisch.text, "verlauf", frisch.ts || null);
  kachel("k-gespraech", relZeit(frisch.ts || null) || "unbekannt",
    frisch.msgs + " Nachrichten im Verlauf", "ok");
  kachel("k-geraet", String(frisch.dev).slice(0, 12),
    gueltige.length + " Geräte beobachtet", "");
}

/* ---------------- Verlauf/Konfig der Brücke in Kacheln ---------------- */

async function brueckeConfigHolen() {
  if (!CFG.token) return;
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  try {
    const r = await fetch("/gemma-live/config?" + p.toString(),
      { cache: "no-store" });
    if (!r.ok) return;
    const c = await r.json();
    if (c.modell) kachel("k-modell", c.modell, "aus der Brücke-Config", "");
    if (c.stimme) kachel("k-stimme", c.stimme, "aus der Brücke-Config", "");
  } catch (e) { /* Kachel bleibt Platzhalter */ }
}

/* ---------------- Wake Lock mit Video-Fallback ---------------- */

function lockBadge() {
  const txt = state.lockTyp === "wakelock" ? "Lock: WakeLock"
    : state.lockTyp === "video" ? "Lock: Video"
    : "Lock: aus";
  badge("f-lock", txt, state.lockTyp ? "badge-ok" : "badge-warn");
}

function kioskKachel() {
  const voll = !!document.fullscreenElement;
  const lock = state.lockTyp === "wakelock" ? "WakeLock aktiv"
    : state.lockTyp === "video" ? "Video hält wach"
    : "kein Wake Lock";
  kachel("k-kiosk", voll ? "Vollbild" : "Fenster", lock,
    state.lockTyp ? "ok" : "warn");
  badge("f-voll", voll ? "Vollbild" : "kein Vollbild",
    voll ? "badge-ok" : "badge-aus");
}

async function lockStarten() {
  if (document.hidden) return;
  if (state.lockTyp) { lockBadge(); kioskKachel(); return; }
  if (navigator.wakeLock && navigator.wakeLock.request) {
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      state.lockTyp = "wakelock";
      state.lockSentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (state.lockTyp === "wakelock") {
          state.lockTyp = null;
          state.lockSentinel = null;
          lockBadge();
        }
      });
      lockBadge();
      kioskKachel();
      return;
    } catch (e) { /* fällt zum Video durch */ }
  }
  videoHalterStarten();
}

function videoHalterStarten() {
  if (state.video) { state.lockTyp = "video"; lockBadge(); kioskKachel(); return; }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 2; canvas.height = 2;
    const ctx = canvas.getContext("2d");
    const video = document.createElement("video");
    video.muted = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("autoplay", "");
    video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    const stream = canvas.captureStream(2);
    const zeichnen = () => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 2, 2);
      if (video.requestVideoFrameCallback) {
        video.requestVideoFrameCallback(zeichnen);
      } else {
        requestAnimationFrame(zeichnen);
      }
    };
    zeichnen();
    video.srcObject = stream;
    const play = video.play();
    if (play && play.catch) {
      play.catch(() => { /* erneut beim nächsten Nutzer-Tipp */ });
    }
    state.video = video;
    state.lockTyp = "video";
  } catch (e) {
    state.lockTyp = null;
  }
  lockBadge();
  kioskKachel();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    state.lockTyp = null;
    state.lockSentinel = null;
    if (state.video) { state.video.pause(); }
    lockStarten();
  }
});

/* ---------------- Vollbild und Kiosk ---------------- */

function vollbildAnfordern() {
  const el = document.documentElement;
  const fn = el.requestFullscreen || el.webkitRequestFullscreen;
  if (fn) {
    try {
      const r = fn.call(el);
      if (r && r.catch) r.catch(() => {});
    } catch (e) {}
  }
}

function startupPruefen() {
  const voll = !!document.fullscreenElement;
  $("startup").classList.toggle("sichtbar", !voll);
  if (!voll && !localStorage.getItem("gemma_kiosk")) {
    $("startup-hinweis").textContent =
      "Erster Start: mit Kiosk starten merkt sich diese Seite den Modus.";
  }
}

document.addEventListener("fullscreenchange", startupPruefen);
document.addEventListener("webkitfullscreenchange", startupPruefen);

$("kiosk-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  localStorage.setItem("gemma_kiosk", "1");
  vollbildAnfordern();
  lockStarten();
});

document.addEventListener("click", () => {
  lockStarten();
  if (localStorage.getItem("gemma_kiosk") && !document.fullscreenElement) {
    vollbildAnfordern();
  }
});

/* ---------------- Start ---------------- */

function orbUhr() {
  if (state.aktivBis && Date.now() < state.aktivBis) {
    orbSetzen("aktiv", "arbeitet");
  } else if (state.wsOnline) {
    orbSetzen("idle", "bereit");
  } else {
    orbSetzen("aus", "offline");
  }
}

setInterval(uhrTicken, 1000);
setInterval(orbUhr, 1000);
setInterval(() => {
  verlaufPoll();
  if (state.antwortQuelle === "verlauf") {
    $("antwort-meta").textContent =
      state.antwortQuelle + " · " + relZeit(state.antwortZeit);
  }
  kachel("k-aktiv",
    Date.now() < state.aktivBis ? "arbeitet" : "ruht",
    Date.now() < state.aktivBis ? "Werkzeug oder Antwort läuft" : "kein Vorgang",
    Date.now() < state.aktivBis ? "warn" : "");
}, 10000);

uhrTicken();
orbUhr();
startupPruefen();
lockStarten();
wsVerbinden();
verlaufPoll();
brueckeConfigHolen();
