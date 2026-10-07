/* Gemma Station fuer Kays Display (Echo Show 15, 1920x1080).
   Reines JS, kein Framework, kein CDN.

   Teile:
   - Uhr/Datum, Vollbild/Kiosk, Wake Lock (mit Video-Fallback)
   - Gespräch: WebSocket zur Gemma-Brücke, Verbindung nur auf Wunsch
     (Orb-Tipp, Weckwort, Texteingabe) - jede Verbindung ist ein echtes
     Gespräch und wird nach 30 s Ruhe vom Server beendet.
   - Stimme raus: der Server schickt Gemmas Stimme als Binär-Frames
     (PCM 16 bit, mono, 24000 Hz) - hier über WebAudio abspielen.
   - Stimme rein: Orb antippen (Push-to-Talk) oder Weckwort. Mikrofon
     wird einmalig mit "Mikro aktivieren" eingeschaltet; danach lauscht
     der Weckwort-Dienst leise mit (serverseitige Erkennung) und getippte
     Gespräche starten sofort.
   - Kacheln: Musik, Vitaldaten, Heizung, Termine - polled über den
     Lese-Endpunkt der Brücke. Keine Schätzwerte: fehlt eine Quelle,
     bleibt die Kachel ehrlich leer. */

"use strict";

const CFG = Object.assign({
  token: "",
  geraete: [],
  verlaufSek: 20,
  statusSek: 30,
  version: "webui-2.0"
}, window.GEMMA_CONFIG || {});

const $ = (id) => document.getElementById(id);

const state = {
  /* Gespräch */
  ws: null,
  wsOnline: false,
  sessionBereit: false,
  willReden: false,
  hoert: false,
  chat: [],
  /* Wiedergabe */
  aCtx: null,
  wiedergabeBis: 0,
  quellen: new Set(),
  audioOffen: false,
  audioEmpfangen: 0,
  /* Mikrofon */
  mikro: { stream: null, ctx: null, knoten: null, stumm: null, aktiv: false,
           vorlauf: [], rest: null },
  /* Weckwort-Dienst */
  wake: { ws: null, offen: false, versuch: 0, timer: null, puffer: [] },
  /* Sonstiges */
  bilder: localStorage.getItem("gemma_bilder") !== "aus",
  fotos: localStorage.getItem("gemma_fotos") !== "aus",
  fotoListe: [],
  fotoPos: 0,
  fotoTimer: null,
  statusTimer: null,
  leerTimer: null,
  lockTyp: null,
  lockSentinel: null,
  video: null,
  kachelDaten: {},
  verlaufMsgs: [],
  denkEnde: 0
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

/* ---------------- Anzeigen: Punkt, Orb, Chat ---------------- */

function punktSetzen(art, text) {
  const p = $("punkt");
  p.className = "punkt" + (art ? " " + art : "");
  $("punkt-text").textContent = text || "";
}

function orbSetzen(zustand, text) {
  const orb = $("orb");
  orb.classList.toggle("aktiv", zustand === "aktiv");
  orb.classList.toggle("hoert", zustand === "hoert");
  orb.classList.toggle("spricht", zustand === "spricht");
  orb.classList.toggle("aus", zustand === "aus");
  $("orb-status").textContent = text;
}

function chatLeeren() {
  state.chat = [];
  $("chat").innerHTML = "";
}

function chatAnhaengen(wer, text) {
  if (!text) return;
  state.chat.push({ wer, text });
  if (state.chat.length > 40) state.chat.splice(0, state.chat.length - 40);
  const box = $("chat");
  const zeile = document.createElement("div");
  zeile.className = "chat-zeile" + (wer === "Kay" ? " chat-kay" : " chat-gemma");
  const name = document.createElement("span");
  name.className = "chat-wer";
  name.textContent = wer === "Kay" ? "Kay" : "Gemma";
  const txt = document.createElement("span");
  txt.className = "chat-text";
  txt.textContent = text;
  zeile.append(name, txt);
  box.append(zeile);
  while (box.children.length > 40) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function chatAusVerlauf() {
  if (state.chat.length || !state.verlaufMsgs.length) return;
  for (const m of state.verlaufMsgs) {
    chatAnhaengen(m.role === "user" ? "Kay" : "Gemma", m.content);
  }
}

function spieltGerade() {
  if (!state.aCtx) return false;
  if (state.quellen.size > 0) return true;
  return state.wiedergabeBis > state.aCtx.currentTime;
}

function orbTakt() {
  if (state.hoert) { orbSetzen("hoert", "Ich höre zu … nochmal tippen beendet"); return; }
  if (Date.now() < state.denkEnde) { orbSetzen("aktiv", "denkt nach …"); return; }
  if (spieltGerade()) {
    orbSetzen("spricht", "ich rede … tippen, um zu antworten");
    return;
  }
  if (state.willReden && !state.sessionBereit) { orbSetzen("aktiv", "verbinde …"); return; }
  orbSetzen("", "Tippen und sprechen");
}

/* ---------------- Wiedergabe: Gemmas Stimme ---------------- */

function playbackCtx() {
  if (!state.aCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      state.aCtx = new AC({ sampleRate: 24000 });
    } catch (e) {
      state.aCtx = new AC();
    }
  }
  if (state.aCtx.state === "suspended") {
    state.aCtx.resume().catch(() => {});
  }
  return state.aCtx;
}

function resampleF32(daten, von, nach) {
  if (Math.abs(von - nach) < 1) return daten;
  const verhaeltnis = von / nach;
  const n = Math.max(1, Math.floor(daten.length / verhaeltnis));
  const raus = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * verhaeltnis;
    const i0 = Math.floor(pos);
    const i1 = Math.min(daten.length - 1, i0 + 1);
    raus[i] = daten[i0] + (daten[i1] - daten[i0]) * (pos - i0);
  }
  return raus;
}

function audioAbspielen(int16) {
  state.audioEmpfangen++;
  const ctx = playbackCtx();
  const roh = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) roh[i] = int16[i] / 32768;
  const f32 = resampleF32(roh, 24000, ctx.sampleRate);
  const puffer = ctx.createBuffer(1, f32.length, ctx.sampleRate);
  puffer.copyToChannel(f32, 0);
  const quelle = ctx.createBufferSource();
  quelle.buffer = puffer;
  quelle.connect(ctx.destination);
  const start = Math.max(state.wiedergabeBis, ctx.currentTime + 0.08);
  quelle.start(start);
  state.wiedergabeBis = start + puffer.duration;
  state.quellen.add(quelle);
  quelle.onended = () => state.quellen.delete(quelle);
  state.audioOffen = true;
}

function wiedergabeStoppen() {
  for (const q of state.quellen) {
    try { q.stop(); } catch (e) { /* schon vorbei */ }
  }
  state.quellen.clear();
  state.wiedergabeBis = 0;
  state.audioOffen = false;
}

function wiedergabeTakt() {
  if (!state.audioOffen || !state.aCtx || !state.wsOnline) return;
  if (state.aCtx.currentTime > state.wiedergabeBis + 0.05) {
    state.audioOffen = false;
    sendeJson({ typ: "wiedergabe_leer" });
  }
}

/* ---------------- Mikrofon ---------------- */

function pcm16Aus(f32, rate) {
  const ziel = 16000;
  const glatt = resampleF32(f32, rate, ziel);
  const raus = new Int16Array(glatt.length);
  for (let i = 0; i < glatt.length; i++) {
    const w = Math.max(-1, Math.min(1, glatt[i]));
    raus[i] = w < 0 ? w * 32768 : w * 32767;
  }
  return raus;
}

async function mikroAktivieren() {
  if (state.mikro.aktiv) return true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true,
               noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    $("orb-status").textContent = "Mikrofon nicht verfügbar";
    return false;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try { ctx = new AC({ sampleRate: 16000 }); } catch (e) { ctx = new AC(); }
  const quelle = ctx.createMediaStreamSource(stream);
  const knoten = ctx.createScriptProcessor(4096, 1, 1);
  const stumm = ctx.createGain();
  stumm.gain.value = 0;
  knoten.onaudioprocess = (ev) => {
    mikroChunk(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
  };
  quelle.connect(knoten);
  knoten.connect(stumm);
  stumm.connect(ctx.destination);
  state.mikro = { stream, ctx, knoten, stumm, aktiv: true,
                  vorlauf: [], rest: null };
  wakeVerbinden();
  return true;
}

function mikroChunk(f32, rate) {
  const pcm = pcm16Aus(f32, rate);
  /* Der Weckwort-Dienst hört nur außerhalb eines Gesprächs mit - sonst
     würde er Gemmas eigene Stimme vom Lautsprecher als Weckwort hören. */
  if (!state.hoert && !state.ws) wakeSenden(pcm);
  if (!state.hoert) return;
  const ws = state.ws;
  if (!ws || ws.readyState !== 1 || !state.sessionBereit) {
    /* Vor dem "bereit" puffern (max. 5 s), danach flushen */
    const vor = state.mikro.vorlauf;
    vor.push(pcm);
    let summe = 0;
    for (const p of vor) summe += p.length;
    while (summe > 80000 && vor.length > 1) summe -= vor.shift().length;
    return;
  }
  pcmSenden(ws, pcm);
}

function pcmSenden(ws, pcm) {
  try { ws.send(pcm.buffer); } catch (e) { /* Verbindung weg */ }
}

function vorlaufFlushen() {
  const ws = state.ws;
  if (!ws || ws.readyState !== 1) { state.mikro.vorlauf = []; return; }
  for (const p of state.mikro.vorlauf) pcmSenden(ws, p);
  state.mikro.vorlauf = [];
}

/* ---------------- Weckwort-Dienst ---------------- */

function wakeVerbinden() {
  if (!state.mikro.aktiv || document.hidden) return;
  if (state.wake.ws &&
      (state.wake.ws.readyState === 0 || state.wake.ws.readyState === 1)) return;
  let ws;
  try {
    ws = new WebSocket("wss://" + location.host + "/gemma-live/wake?token=" +
      encodeURIComponent(CFG.token) + "&device=show15");
  } catch (e) {
    wakeErneut();
    return;
  }
  ws.binaryType = "arraybuffer";
  state.wake.ws = ws;
  ws.onopen = () => {
    state.wake.offen = true;
    state.wake.versuch = 0;
    punktSetzen("gruen", "lauscht");
  };
  ws.onmessage = (ev) => {
    let d = null;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.typ === "weck") {
      if (!state.hoert && !document.hidden) redeStarten();
    }
  };
  ws.onclose = () => {
    state.wake.offen = false;
    state.wake.ws = null;
    if (state.mikro.aktiv) punktSetzen("", "");
    wakeErneut();
  };
  ws.onerror = () => {
    try { ws.close(); } catch (e) { /* egal */ }
  };
}

function wakeErneut() {
  if (state.wake.timer) clearTimeout(state.wake.timer);
  state.wake.timer = setTimeout(() => {
    state.wake.timer = null;
    if (state.mikro.aktiv && !document.hidden) wakeVerbinden();
  }, 5000);
}

function wakeSenden(pcm) {
  const ws = state.wake.ws;
  if (!state.wake.offen || !ws || ws.readyState !== 1) return;
  if (state.wake.puffer === undefined) state.wake.puffer = [];
  state.wake.puffer.push(pcm);
  let summe = 0;
  for (const p of state.wake.puffer) summe += p.length;
  /* ~100-ms-Blöcke (1600 Samples) an den Server */
  while (summe >= 1600) {
    const teile = [];
    let braucht = 1600;
    while (braucht > 0 && state.wake.puffer.length) {
      const kopf = state.wake.puffer[0];
      if (kopf.length <= braucht) {
        teile.push(kopf);
        braucht -= kopf.length;
        state.wake.puffer.shift();
      } else {
        teile.push(kopf.subarray(0, braucht));
        state.wake.puffer[0] = kopf.subarray(braucht);
        braucht = 0;
      }
    }
    const gesamt = new Int16Array(1600);
    let pos = 0;
    for (const t of teile) { gesamt.set(t, pos); pos += t.length; }
    try { ws.send(gesamt.buffer); } catch (e) { break; }
    summe -= 1600;
  }
}

/* ---------------- Gespräch: WebSocket ---------------- */

function sendeJson(obj) {
  const ws = state.ws;
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* weg */ }
  }
}

function gespraechSchliessen() {
  const ws = state.ws;
  state.ws = null;
  state.wsOnline = false;
  state.sessionBereit = false;
  state.willReden = false;
  if (ws) { try { ws.close(1000, "fertig"); } catch (e) { /* weg */ } }
  wiedergabeStoppen();
  if (!state.mikro.aktiv) punktSetzen("", "");
  else punktSetzen("gruen", "lauscht");
}

function gespraechVerbinden() {
  if (state.ws) return;
  let ws;
  try {
    ws = new WebSocket("wss://" + location.host + "/gemma-live/ws?token=" +
      encodeURIComponent(CFG.token) + "&device=show15&version=" +
      encodeURIComponent(CFG.version));
  } catch (e) {
    $("orb-status").textContent = "Verbindung fehlgeschlagen";
    return;
  }
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onopen = () => {
    state.wsOnline = true;
  };
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      audioAbspielen(new Int16Array(ev.data));
      return;
    }
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    switch (d.typ) {
      case "bereit":
        state.sessionBereit = true;
        if (state.willReden) {
          state.hoert = true;
          vorlaufFlushen();
          orbSetzen("hoert", "Ich höre zu … nochmal tippen beendet");
        }
        break;
      case "du":
        if (d.text) chatAnhaengen("Kay", d.text);
        state.denkEnde = 0;
        break;
      case "gemma":
        if (d.text) chatAnhaengen("Gemma", d.text);
        break;
      case "denkt":
      case "werkzeug":
        state.denkEnde = Date.now() + 20000;
        break;
      case "werkzeug_fertig":
        state.denkEnde = 0;
        break;
      case "unterbrochen":
        wiedergabeStoppen();
        break;
      case "zug_ende":
        state.denkEnde = 0;
        break;
      case "geraet":
        /* Dieses Display steuert keine Geräte - ehrlich antworten. */
        sendeJson({ typ: "werkzeug_ergebnis", id: String(d.id || ""),
                    ergebnis: "Hier nicht möglich: dieses Gerät hat keine Geräte-Steuerung." });
        break;
      case "fehler":
        $("orb-status").textContent = "kurze Pause, gleich wieder";
        break;
      case "ende":
        gespraechSchliessen();
        break;
    }
  };
  ws.onclose = () => {
    if (state.ws === ws) {
      state.ws = null;
      state.wsOnline = false;
      state.sessionBereit = false;
      wiedergabeStoppen();
      if (state.hoert) state.hoert = false;
      if (!state.mikro.aktiv) punktSetzen("", "");
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch (e) { /* weg */ }
  };
}

/* Orb-Tipp / Weckwort / Text: der gemeinsame Weg ins Gespräch */

function redeStarten() {
  wiedergabeStoppen();
  state.willReden = true;
  state.hoert = false;
  orbSetzen("aktiv", state.mikro.aktiv ? "verbinde …" : "Mikrofon an …");
  gespraechVerbinden();
  mikroAktivieren().then((ok) => {
    if (!ok) { state.willReden = false; return; }
    if (state.sessionBereit && state.willReden) {
      state.hoert = true;
      vorlaufFlushen();
      orbSetzen("hoert", "Ich höre zu … nochmal tippen beendet");
    }
  });
}

function redeStoppen() {
  state.hoert = false;
  state.willReden = false;
  state.mikro.vorlauf = [];
  state.denkEnde = Date.now() + 25000;
  orbSetzen("aktiv", "denkt nach …");
}

function orbTap() {
  playbackCtx();          /* Tonfreigabe durch Nutzer-Tipp */
  if (state.hoert) { redeStoppen(); return; }
  redeStarten();
}

/* Text statt Sprache (Falls Weg + Prüfung) */

function textSenden(text) {
  text = String(text || "").trim();
  if (!text) return;
  chatAnhaengen("Kay", text);
  state.willReden = false;
  gespraechVerbinden();
  const ws = state.ws;
  if (state.sessionBereit && ws) {
    sendeJson({ typ: "text", text });
    return;
  }
  const warte = setInterval(() => {
    if (state.sessionBereit && state.ws) {
      clearInterval(warte);
      sendeJson({ typ: "text", text });
    } else if (!state.ws) {
      clearInterval(warte);
    }
  }, 200);
  setTimeout(() => clearInterval(warte), 15000);
}

/* ---------------- Kacheln: Status holen ---------------- */

async function statusHolen() {
  if (!CFG.token) return;
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("t", Date.now());
  let d;
  try {
    const r = await fetch("/gemma-live/status?" + p.toString(),
      { cache: "no-store" });
    if (!r.ok) return;
    d = await r.json();
  } catch (e) {
    return;
  }
  kachelMusik(d.musik);
  kachelVital(d.vital);
  kachelHeizung(d.heizung);
  kachelTermine(d.termine);
  if (Array.isArray(d.fotos)) {
    const davor = state.fotoListe.length;
    state.fotoListe = d.fotos;
    if (!d.fotos.length && state.fotos) fotoLeerZeigen();
    if (davor !== d.fotos.length && state.fotos && !state.fotoTimer) fotoZeigen();
  }
}

/* ---------------- Fotos: eigene Fläche mit Platz-Schalter ----------------
   Quelle ist dieselbe wie in der Station/Diashow (Foto-Ablage auf dem
   Server). Schalter AUS: Fläche kollabiert komplett, keine Foto-Daten. */

function fotoUrl(eintrag) {
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("t", eintrag.name);
  return "/gemma-live/foto/" + encodeURIComponent(eintrag.album) + "/" +
    encodeURIComponent(eintrag.name) + "?" + p.toString();
}

function fotoZeigen() {
  const bild = $("foto-bild");
  if (!state.fotos) return;
  if (!state.fotoListe.length) { fotoLeerZeigen(); return; }
  const eintrag = state.fotoListe[state.fotoPos % state.fotoListe.length];
  state.fotoPos = (state.fotoPos + 1) % Math.max(1, state.fotoListe.length);
  if (bild.getAttribute("src") !== fotoUrl(eintrag)) {
    bild.src = fotoUrl(eintrag);
    bild.hidden = false;
  }
  $("foto-leer").hidden = true;
  if (!state.fotoTimer) {
    state.fotoTimer = setInterval(() => {
      if (state.fotos && !document.hidden) fotoZeigen();
    }, 20000);
  }
}

function fotoLeerZeigen() {
  $("foto-bild").hidden = true;
  $("foto-bild").removeAttribute("src");
  $("foto-leer").hidden = false;
}

function fotoSchalten() {
  state.fotos = !state.fotos;
  localStorage.setItem("gemma_fotos", state.fotos ? "an" : "aus");
  fotoKnopfSetzen();
  $("haupt").classList.toggle("ohne-fotos", !state.fotos);
  if (state.fotos) {
    fotoZeigen();
  } else {
    if (state.fotoTimer) { clearInterval(state.fotoTimer); state.fotoTimer = null; }
    $("foto-bild").removeAttribute("src");
    $("foto-bild").hidden = true;
  }
}

function fotoKnopfSetzen() {
  const b = $("foto-btn");
  b.classList.toggle("an", state.fotos);
  b.setAttribute("aria-pressed", state.fotos ? "true" : "false");
}

function kachelMusik(m) {
  const titel = $("musik-titel");
  const kuenstler = $("musik-kuenstler");
  const cover = $("musik-cover");
  state.kachelDaten["k-musik"] = m || null;
  if (!m || (!m.verbunden && !m.titel)) {
    titel.textContent = "nicht verbunden";
    kuenstler.textContent = "Musik läuft woanders oder ist aus";
    if (!cover.hidden) cover.hidden = true;
    $("m-play").innerHTML = "&#9654;";
    return;
  }
  titel.textContent = m.titel || "nichts läuft";
  kuenstler.textContent = m.titel
    ? ([m.kuenstler, m.geraet].filter(Boolean).join(" · ") || "—")
    : (m.verbunden ? "Spotify ist verbunden" : "Musik ist aus");
  /* Bilder-Schalter: AUS = Bild gar nicht erst laden (nur Text) */
  if (state.bilder && m.cover) {
    if (cover.getAttribute("src") !== m.cover) cover.src = m.cover;
    cover.hidden = false;
  } else {
    cover.removeAttribute("src");
    cover.hidden = true;
  }
  $("m-play").innerHTML = m.laeuft ? "&#9208;" : "&#9654;";
}

function bilderSchalten() {
  state.bilder = !state.bilder;
  localStorage.setItem("gemma_bilder", state.bilder ? "an" : "aus");
  bilderKnopfSetzen();
  kachelMusik(state.kachelDaten["k-musik"]);
}

function bilderKnopfSetzen() {
  const b = $("bilder-btn");
  b.classList.toggle("an", state.bilder);
  b.setAttribute("aria-pressed", state.bilder ? "true" : "false");
  b.textContent = state.bilder ? "Bilder an" : "Bilder aus";
}

function kachelVital(v) {
  state.kachelDaten["k-vital"] = v || null;
  const zahl = (x, nach) => (typeof x === "number" && isFinite(x))
    ? Math.round(x) + (nach || "") : "—";
  $("v-puls").textContent = zahl(v && v.puls);
  $("v-schritte").textContent = zahl(v && v.schritte);
  $("v-schlaf").textContent = zahl(v && v.schlaf);
  $("v-ready").textContent = zahl(v && v.readiness);
  $("v-alter").textContent = (v && v.datum && v.datum !== heuteStr())
    ? "Stand: " + v.datum : (v && v.puls != null ? "von heute" : "noch keine Werte von der Uhr");
}

function heuteStr() {
  const d = new Date();
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const tag = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mon + "-" + tag;
}

function kachelHeizung(zonen) {
  const box = $("heizung-liste");
  box.innerHTML = "";
  state.kachelDaten["k-heizung"] = zonen || null;
  if (!zonen || !zonen.length) {
    const leer = document.createElement("div");
    leer.className = "kachel-zusatz";
    leer.textContent = "keine Werte";
    box.append(leer);
    return;
  }
  for (const z of zonen) {
    const zeile = document.createElement("div");
    zeile.className = "heizung-zeile";
    const name = document.createElement("span");
    name.className = "heizung-name";
    name.textContent = z.name || "—";
    const wert = document.createElement("span");
    wert.className = "heizung-wert";
    const ist = (typeof z.ist === "number") ? z.ist.toFixed(1).replace(".", ",") + "°" : "—";
    const soll = (typeof z.soll === "number") ? z.soll.toFixed(1).replace(".", ",") + "°" : "";
    wert.textContent = soll ? `${ist} · soll ${soll}` : ist;
    zeile.append(name, wert);
    box.append(zeile);
  }
}

const TAGE_KURZ = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function kachelTermine(termine) {
  const box = $("termin-liste");
  box.innerHTML = "";
  state.kachelDaten["k-termine"] = termine || null;
  if (!termine || !termine.length) {
    const leer = document.createElement("div");
    leer.className = "kachel-zusatz";
    leer.textContent = "nichts geplant";
    box.append(leer);
    return;
  }
  for (const t of termine.slice(0, 4)) {
    const zeile = document.createElement("div");
    zeile.className = "termin-zeile";
    const wann = document.createElement("span");
    wann.className = "termin-wann";
    wann.textContent = terminWann(t);
    const was = document.createElement("span");
    was.className = "termin-was";
    was.textContent = t.titel || "—";
    zeile.append(wann, was);
    box.append(zeile);
  }
}

function terminWann(t) {
  if (!t.tag) return "—";
  const teile = String(t.tag).split("-");
  const d = new Date(Number(teile[0]), Number(teile[1]) - 1, Number(teile[2]));
  const heute = heuteStr();
  const morgen = new Date();
  morgen.setDate(morgen.getDate() + 1);
  let name;
  if (String(t.tag) === heute) name = "heute";
  else if (String(t.tag) === morgenStr()) name = "morgen";
  else name = TAGE_KURZ[d.getDay()] + " " + d.getDate() + "." + (d.getMonth() + 1) + ".";
  if (t.ganztaegig) return name;
  return name + (t.zeit ? ", " + t.zeit : "");
}

function morgenStr() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const mon = String(d.getMonth() + 1).padStart(2, "0");
  const tag = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mon + "-" + tag;
}

async function musikAktion(aktion) {
  if (!CFG.token) return;
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("aktion", aktion);
  p.set("t", Date.now());
  try {
    const r = await fetch("/gemma-live/status?" + p.toString(),
      { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      if (d && d.musik) kachelMusik(d.musik);
      return;
    }
  } catch (e) { /* Kachel bleibt wie sie ist */ }
  statusHolen();
}

/* ---------------- Verlauf (letzte Gespräche aller Geräte) ---------------- */

async function verlaufHolen(dev) {
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("t", Date.now());
  const r = await fetch("/gemma-live/verlauf/" + encodeURIComponent(dev) +
    ".json?" + p.toString(), { cache: "no-store" });
  if (!r.ok) return null;
  const d = await r.json();
  const msgs = (d.messages || []).filter((m) => m && m.content);
  return { ts: d.ts || 0, msgs: msgs.slice(-8) };
}

async function verlaufPoll() {
  if (!CFG.token || !CFG.geraete.length || state.chat.length) return;
  const ergebnisse = await Promise.all(
    CFG.geraete.map((g) => verlaufHolen(g).catch(() => null)));
  const gueltige = ergebnisse.filter((e) => e && e.msgs.length);
  if (!gueltige.length) return;
  gueltige.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  state.verlaufMsgs = gueltige[0].msgs;
  chatAusVerlauf();
}

/* ---------------- Detail-Overlay ---------------- */

function overlayOeffnen(id) {
  const el = $(id);
  if (!el || $("overlay").classList.contains("offen")) return;
  const daten = state.kachelDaten[id] || null;
  const label = el.querySelector(".kachel-label");
  $("overlay-label").textContent = label ? label.textContent : "";
  const inhalt = $("overlay-inhalt");
  inhalt.innerHTML = "";
  let meta = "";

  if (id === "k-gespraech") {
    const msgs = state.chat.length
      ? state.chat.map((m) => ({ wer: m.wer, text: m.text }))
      : state.verlaufMsgs.map((m) => ({
          wer: m.role === "user" ? "Kay" : "Gemma", text: m.content }));
    if (!msgs.length) {
      const leer = document.createElement("div");
      leer.className = "ov-leer";
      leer.textContent = "Noch kein Gespräch.";
      inhalt.append(leer);
    }
    for (const m of msgs) {
      const zeile = document.createElement("div");
      zeile.className = "ov-msg" + (m.wer === "Kay" ? " ov-user" : "");
      const wer = document.createElement("div");
      wer.className = "ov-msg-wer";
      wer.textContent = m.wer;
      const txt = document.createElement("div");
      txt.className = "ov-msg-text";
      txt.textContent = m.text;
      zeile.append(wer, txt);
      inhalt.append(zeile);
    }
  } else if (id === "k-musik" && daten) {
    zeileInOverlay(inhalt, "Titel", daten.titel);
    zeileInOverlay(inhalt, "Von", daten.kuenstler);
    zeileInOverlay(inhalt, "Läuft auf", daten.geraet);
    if (!daten.verbunden && !daten.titel) {
      zeileInOverlay(inhalt, "Hinweis", "Gerade läuft keine Musik.");
    }
  } else if (id === "k-vital" && daten) {
    zeileInOverlay(inhalt, "Puls", typeof daten.puls === "number" ? Math.round(daten.puls) : null);
    zeileInOverlay(inhalt, "Schritte", typeof daten.schritte === "number" ? Math.round(daten.schritte) : null);
    zeileInOverlay(inhalt, "Schlaf-Score", typeof daten.schlaf === "number" ? Math.round(daten.schlaf) : null);
    zeileInOverlay(inhalt, "Fit-Score", typeof daten.readiness === "number" ? Math.round(daten.readiness) : null);
    if (daten.datum) zeileInOverlay(inhalt, "Tag", daten.datum);
    if (!daten.puls && !daten.schritte && !daten.schlaf) {
      zeileInOverlay(inhalt, "Hinweis", "Noch keine Werte von der Uhr.");
    }
  } else if (id === "k-heizung" && Array.isArray(daten)) {
    for (const z of daten) {
      const ist = (typeof z.ist === "number") ? z.ist.toFixed(1).replace(".", ",") + "°" : "—";
      const soll = (typeof z.soll === "number") ? z.soll.toFixed(1).replace(".", ",") + "°" : "—";
      zeileInOverlay(inhalt, z.name || "—", `${ist} ist · ${soll} soll`);
    }
  } else if (id === "k-termine" && Array.isArray(daten)) {
    for (const t of daten) {
      zeileInOverlay(inhalt, terminWann(t), t.titel || "—");
    }
  } else {
    const leer = document.createElement("div");
    leer.className = "ov-leer";
    leer.textContent = "Gerade keine Daten.";
    inhalt.append(leer);
  }

  $("overlay-meta").textContent = meta;
  const ov = $("overlay");
  ov.classList.add("offen");
  ov.setAttribute("aria-hidden", "false");
  $("overlay-x").focus();
}

function zeileInOverlay(inhalt, schluessel, wert) {
  const zeile = document.createElement("div");
  zeile.className = "ov-roh-zeile";
  const k = document.createElement("span");
  k.className = "ov-roh-key";
  k.textContent = schluessel;
  const v = document.createElement("span");
  v.className = "ov-roh-wert";
  v.textContent = (wert === null || wert === undefined || wert === "") ? "—" : String(wert);
  zeile.append(k, v);
  inhalt.append(zeile);
}

function overlaySchliessen() {
  const ov = $("overlay");
  ov.classList.remove("offen");
  ov.setAttribute("aria-hidden", "true");
}

function kachelnKlickbarMachen() {
  for (const k of document.querySelectorAll(".kachel, .gespraech-kachel")) {
    if (!k.id) continue;
    k.classList.add("klickbar");
    k.setAttribute("role", "button");
    k.setAttribute("tabindex", "0");
    k.addEventListener("click", (ev) => {
      if (ev.target.closest("button")) return;
      overlayOeffnen(k.id);
    });
    k.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        overlayOeffnen(k.id);
      }
    });
  }
  $("overlay-x").addEventListener("click", (ev) => {
    ev.stopPropagation();
    overlaySchliessen();
  });
  $("overlay-box").addEventListener("click", (ev) => ev.stopPropagation());
  $("overlay").addEventListener("click", (ev) => {
    if (ev.target === $("overlay")) overlaySchliessen();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") overlaySchliessen();
  });
}

/* ---------------- Wake Lock mit Video-Fallback ---------------- */

async function lockStarten() {
  if (document.hidden) return;
  if (state.lockTyp) return;
  if (navigator.wakeLock && navigator.wakeLock.request) {
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      state.lockTyp = "wakelock";
      state.lockSentinel = sentinel;
      sentinel.addEventListener("release", () => {
        if (state.lockTyp === "wakelock") {
          state.lockTyp = null;
          state.lockSentinel = null;
        }
      });
      return;
    } catch (e) { /* fällt zum Video durch */ }
  }
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
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(zeichnen);
      else requestAnimationFrame(zeichnen);
    };
    zeichnen();
    video.srcObject = stream;
    const play = video.play();
    if (play && play.catch) play.catch(() => {});
    state.video = video;
    state.lockTyp = "video";
  } catch (e) {
    state.lockTyp = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    state.lockTyp = null;
    state.lockSentinel = null;
    if (state.video) state.video.pause();
    lockStarten();
    wakeVerbinden();
    statusHolen();
  } else {
    /* Tab unsichtbar: Mikrofon-Stream für den Weckwort-Dienst pausieren */
    if (state.wake.offen && state.wake.ws) {
      try { state.wake.ws.close(); } catch (e) { /* weg */ }
    }
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
    } catch (e) { /* Browser wehrt sich */ }
  }
}

function startupPruefen() {
  const voll = !!document.fullscreenElement;
  const auto = location.hash === "#kiosk";
  if (auto && !localStorage.getItem("gemma_kiosk")) {
    localStorage.setItem("gemma_kiosk", "1");
  }
  $("startup").classList.toggle("sichtbar", !voll && !auto);
}

document.addEventListener("fullscreenchange", startupPruefen);
document.addEventListener("webkitfullscreenchange", startupPruefen);

$("kiosk-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  localStorage.setItem("gemma_kiosk", "1");
  vollbildAnfordern();
  lockStarten();
  playbackCtx();
});

document.addEventListener("click", () => {
  lockStarten();
  if (localStorage.getItem("gemma_kiosk") && !document.fullscreenElement) {
    vollbildAnfordern();
  }
});

/* ---------------- Tasten ---------------- */

$("bilder-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  bilderSchalten();
});
$("foto-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  fotoSchalten();
});
$("orb").addEventListener("click", (ev) => {
  ev.stopPropagation();
  orbTap();
});
$("m-play").addEventListener("click", (ev) => {
  ev.stopPropagation();
  musikAktion(state.kachelDaten["k-musik"] && state.kachelDaten["k-musik"].laeuft
    ? "musik_pause" : "musik_weiter");
});
$("m-naechster").addEventListener("click", (ev) => {
  ev.stopPropagation();
  musikAktion("musik_naechster");
});
$("m-vorher").addEventListener("click", (ev) => {
  ev.stopPropagation();
  musikAktion("musik_vorher");
});
$("mikro-btn").addEventListener("click", async (ev) => {
  ev.stopPropagation();
  if (state.mikro.aktiv) {
    /* Mikro wieder aus: Streams sauber schließen */
    state.mikro.aktiv = false;
    if (state.wake.ws) { try { state.wake.ws.close(); } catch (e) {} }
    if (state.hoert) redeStoppen();
    try { state.mikro.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { state.mikro.ctx.close(); } catch (e) {}
    state.mikro = { stream: null, ctx: null, knoten: null, stumm: null,
                    aktiv: false, vorlauf: [], rest: null };
    $("mikro-btn").textContent = "Mikro aktivieren";
    $("mikro-btn").classList.remove("an");
    punktSetzen("", "");
    $("orb-status").textContent = "Tippen und sprechen";
    return;
  }
  const ok = await mikroAktivieren();
  if (ok) {
    $("mikro-btn").textContent = "Mikro an";
    $("mikro-btn").classList.add("an");
    punktSetzen("gruen", "lauscht");
  }
});
$("tippen-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  $("tippen-overlay").classList.add("offen");
  $("tippen-overlay").setAttribute("aria-hidden", "false");
  $("tippen-eingabe").focus();
});
$("tippen-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const feld = $("tippen-eingabe");
  const text = feld.value.trim();
  if (!text) return;
  feld.value = "";
  $("tippen-overlay").classList.remove("offen");
  $("tippen-overlay").setAttribute("aria-hidden", "true");
  textSenden(text);
});

/* ---------------- Start ---------------- */

uhrTicken();
orbTakt();
bilderKnopfSetzen();
fotoKnopfSetzen();
$("haupt").classList.toggle("ohne-fotos", !state.fotos);
if (state.fotos) fotoZeigen();
setInterval(uhrTicken, 1000);
setInterval(orbTakt, 1000);
setInterval(wiedergabeTakt, 250);
setInterval(statusHolen, Math.max(15, CFG.statusSek) * 1000);
setInterval(verlaufPoll, 30000);
startupPruefen();
lockStarten();
kachelnKlickbarMachen();
statusHolen();
verlaufPoll();

/* Prüfhaken (unsichtbar, für automatische Tests): */
window.gemmaIntern = {
  textSenden,
  orbTap,
  mikroAktivieren,
  zustand: () => ({
    ws: !!state.ws, online: state.wsOnline, bereit: state.sessionBereit,
    hoert: state.hoert, mikro: state.mikro.aktiv,
    wake: state.wake.offen, chat: state.chat.length,
    audioFrames: state.audioEmpfangen,
    kacheln: Object.keys(state.kachelDaten)
  })
};
