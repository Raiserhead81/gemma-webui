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
  audio: { weg: null, still: 0, letzterTakt: 0, sperrt: false,
           ring: [], ringZahl: 0, stuecke: [], stueckeZahl: 0, el: null },
  klang: "soundbar",
  letztesGemma: 0,
  hinweisText: "",
  hinweisBis: 0,
  wetter: null,
  welt: null,
  radar: { frames: [], pos: 0, rot: null, liste: null },
  wachSeit: 0,
  wachNeustarts: 0,
  wachAudioLebt: false,
  wachVideoLebt: false,
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

/* ---------------- Gesprächs-Kachel: nur anlegen, wenn gewünscht ----------------
   config.js: zeige_gespraech: true → Verlauf-Kachel wieder sichtbar.
   Ohne das Feld (oder false) bleibt sie weg, die übrigen Kacheln
   übernehmen den Platz (gleicher Kollaps wie beim Foto-Schalter). */

const ZEIGE_GESPRAECH = !!CFG.zeige_gespraech;

function gespraechKachelAufbauen() {
  if (!ZEIGE_GESPRAECH) return;
  const kachel = document.createElement("section");
  kachel.className = "gespraech-kachel";
  kachel.id = "k-gespraech";
  const label = document.createElement("div");
  label.className = "kachel-label";
  label.textContent = "Gespräch";
  const chat = document.createElement("div");
  chat.className = "chat";
  chat.id = "chat";
  kachel.append(label, chat);
  $("haupt").prepend(kachel);
}

function chatLeeren() {
  state.chat = [];
  const box = $("chat");
  if (box) box.innerHTML = "";
}

function chatAnhaengen(wer, text) {
  if (!text) return;
  const box = $("chat");
  const letzte = state.chat[state.chat.length - 1];
  if (letzte && letzte.wer === wer && Date.now() - letzte.zeit < 15000) {
    letzte.text += text;
    letzte.zeit = Date.now();
    if (!box) return;
    const zeile = box.lastElementChild;
    if (zeile) zeile.querySelector(".chat-text").textContent = letzte.text;
    box.scrollTop = box.scrollHeight;
    return;
  }
  state.chat.push({ wer, text, zeit: Date.now() });
  if (state.chat.length > 40) state.chat.splice(0, state.chat.length - 40);
  if (!box) return;
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

function hinweisSetzen(text, sek) {
  state.hinweisText = text;
  state.hinweisBis = Date.now() + (sek || 60) * 1000;
  $("orb-status").textContent = text;
  $("fuss-hinweis").textContent = text;
}

function orbTakt() {
  if (Date.now() < state.hinweisBis) {
    $("orb-status").textContent = state.hinweisText;
    return;
  }
  if (state.hoert) { orbSetzen("hoert", "Ich höre zu … nochmal tippen beendet"); return; }
  if (Date.now() < state.denkEnde) { orbSetzen("aktiv", "denkt nach …"); return; }
  if (Date.now() - state.letztesGemma < 9000 && !spieltGerade() &&
      Date.now() - state.letztesGemma < 9000 && state.klang === "soundbar") {
    orbSetzen("spricht", "ich rede (über die Soundbar)");
    return;
  }
  if (spieltGerade()) {
    orbSetzen("spricht", "ich rede … tippen, um zu antworten");
    return;
  }
  if (state.willReden && !state.sessionBereit) { orbSetzen("aktiv", "verbinde …"); return; }
  orbSetzen("", "Tippen und sprechen");
}

/* ---------------- Wiedergabe: Gemmas Stimme ----------------
   Zwei Wege, automatisch gewaehlt (nur Klang-Ziel "Display"):
   - WebAudio: PCM-Frames als AudioBuffer in einem 24-kHz-Kontext
     (lehnt das Geraet 24 kHz ab, gilt die Browser-Rate + Resampling).
   - WAV ueber ein normales <audio>-Element: empfangene PCM-Frames werden
     zu WAV-Blobs (24 kHz) zusammengesetzt und nacheinander abgespielt -
     der Weg, der auf Geraeten mit zickigem WebAudio praktisch immer tut.
   Bleibt WebAudio 2 s still, obwohl Audio da ist, wechselt die UI selbst
   auf den WAV-Weg (die letzten 4 s aus einem Ring laufen dort nach).
   Klang-Ziel "Soundbar": das Geraet schweigt absichtlich, Gemmas Stimme
   kommt aus der Soundbar (daher keine Frames). */

function playbackCtx() {
  if (!state.aCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      state.aCtx = new AC({ sampleRate: 24000 });
    } catch (e) {
      state.aCtx = new AC();          /* Geraet lehnt 24 kHz ab: Browser-Rate */
    }
  }
  if (state.aCtx.state === "suspended") {
    state.aCtx.resume().catch(() => { state.audio.sperrt = true; tonAnzeige(); });
  }
  return state.aCtx;
}

function tonWegAktiv() {
  if (CFG.tonWeg === "wav" || CFG.tonWeg === "webaudio") return CFG.tonWeg;
  return state.audio.weg || "webaudio";
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
  if (state.klang === "soundbar") return;      /* Stimme kommt aus der Soundbar */
  if (tonWegAktiv() === "webaudio" && state.aCtx &&
      state.aCtx.state === "running") {
    webaudioAbspielen(int16);
  } else {
    wavFuettern(int16);
  }
}

function webaudioAbspielen(int16) {
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
  /* Ring fuer den Notwechsel zum WAV-Weg (letzte ~4 s) */
  state.audio.ring.push(int16);
  state.audio.ringZahl += int16.length;
  while (state.audio.ringZahl > 96000 && state.audio.ring.length > 1) {
    state.audio.ringZahl -= state.audio.ring.shift().length;
  }
}

/* ---------- WAV-Weg ---------- */

function audioElement() {
  if (state.audio.el) return state.audio.el;
  const el = document.createElement("audio");
  el.setAttribute("playsinline", "");
  el.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(el);
  el.addEventListener("ended", () => {
    try { URL.revokeObjectURL(el.dataset.url || ""); } catch (e) { /* egal */ }
    el.removeAttribute("src");
    wavStartenFallsFrei();
    wiedergabePruefen();
  });
  state.audio.el = el;
  return el;
}

function wavBlobAus(liste, n) {
  const puffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(puffer);
  const wort = (pos, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(pos + i, text.charCodeAt(i));
  };
  wort(0, "RIFF"); view.setUint32(4, 36 + n * 2, true);
  wort(8, "WAVE"); wort(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); wort(36, "data");
  view.setUint32(40, n * 2, true);
  let pos = 44;
  for (const stueck of liste) {
    for (let i = 0; i < stueck.length; i++, pos += 2) view.setInt16(pos, stueck[i], true);
  }
  return new Blob([puffer], { type: "audio/wav" });
}

function wavFuettern(int16) {
  state.audio.stuecke.push(int16);
  state.audio.stueckeZahl += int16.length;
  state.audioOffen = true;
  wavStartenFallsFrei();
}

function wavStartenFallsFrei() {
  const el = audioElement();
  if (el.src && !el.paused && !el.ended) return;
  if (!state.audio.stueckeZahl) { wiedergabePruefen(); return; }
  const grenze = 24000 * 60;                 /* max. 60 s pro Blob */
  let n = 0, i = 0;
  for (; i < state.audio.stuecke.length && n < grenze; i++) {
    n += state.audio.stuecke[i].length;
  }
  const teil = state.audio.stuecke.slice(0, i);
  state.audio.stuecke = state.audio.stuecke.slice(i);
  state.audio.stueckeZahl -= n;
  const url = URL.createObjectURL(wavBlobAus(teil, n));
  el.dataset.url = url;
  el.src = url;
  const p = el.play();
  if (p && p.catch) p.catch(() => { state.audio.sperrt = true; tonAnzeige(); });
}

/* ---------- gemeinsam: Ende erkennen, stoppen, Zustand zeigen ---------- */

function wiedergabePruefen() {
  if (!state.audioOffen || !state.wsOnline) return;
  let leer = false;
  if (state.klang === "soundbar") {
    leer = false;
  } else if (tonWegAktiv() === "wav") {
    const el = state.audio.el;
    leer = !state.audio.stueckeZahl &&
           (!el || !el.src || el.ended || el.paused);
  } else if (state.aCtx) {
    leer = state.aCtx.currentTime > state.wiedergabeBis + 0.05;
  }
  if (leer) {
    state.audioOffen = false;
    sendeJson({ typ: "wiedergabe_leer" });
  }
}

function wiedergabeTakt() {
  wiedergabePruefen();
  if (state.klang !== "soundbar" && tonWegAktiv() === "webaudio" &&
      state.audioOffen) {
    const ctx = state.aCtx;
    if (!ctx || ctx.state !== "running") {
      state.audio.still++;
    } else if (ctx.currentTime <= state.audio.letzterTakt) {
      state.audio.still++;
    } else {
      state.audio.still = 0;
      state.audio.letzterTakt = ctx.currentTime;
    }
    if (state.audio.still >= 8) {            /* 2 s kein Fortschritt */
      klangNotWav();
    }
  }
}

function klangNotWav() {
  state.audio.weg = "wav";
  state.audio.still = 0;
  for (const stueck of state.audio.ring) wavFuettern(stueck);
  state.audio.ring = [];
  state.audio.ringZahl = 0;
  for (const q of state.quellen) { try { q.stop(); } catch (e) { /* weg */ } }
  state.quellen.clear();
  state.wiedergabeBis = 0;
  tonAnzeige();
}

function wiedergabeStoppen() {
  for (const q of state.quellen) { try { q.stop(); } catch (e) { /* weg */ } }
  state.quellen.clear();
  state.wiedergabeBis = 0;
  state.audio.ring = [];
  state.audio.ringZahl = 0;
  state.audio.stuecke = [];
  state.audio.stueckeZahl = 0;
  if (state.audio.el) {
    try { state.audio.el.pause(); } catch (e) { /* weg */ }
    state.audio.el.removeAttribute("src");
  }
  state.audioOffen = false;
}

function spieltGerade() {
  if (state.quellen.size > 0) return true;
  const el = state.audio.el;
  if (el && el.src && !el.paused && !el.ended) return true;
  if (!state.aCtx) return false;
  return state.wiedergabeBis > state.aCtx.currentTime;
}

/* Ton-Zustand sichtbar machen (Kay-Sprache, ohne Fachbegriffe) */

/* ---------- Wachen: Audio-Loop (Hauptwache) + Video + Wake Lock ----------
   Der stille Audio-Loop (Oszillator, praktisch unhörbar) läuft in JEDEM
   Klang-Modus: bei "Soundbar" ist der Geräte-Audio-Pfad frei (Gemma spricht
   über lsp/Soundbar), bei "Display" stört der Loop das Playback nicht
   (eigener AudioContext). Start nur nach Nutzergeste, Auto-Restart bei
   Sichtbar-Werden und per Heartbeat - jeder Neustart wird mit Uhrzeit
   im Fuß-Zähler sichtbar gemacht. */

const SILK = /silk/i.test(navigator.userAgent);
const SILK_MEDIA = "/media.mp3";
let silkAudio = null;

/* ---------- Silk-Wache (Mechanik nach DaGammla/keep-silk-open, MIT) -------
   Stille MP3, jede Minute neu geladen (Fire OS haelt den Tab bei aktiver
   Wiedergabe offen), startet stumm und wird bei der ersten Beruehrung
   unmuetig (unsichtbar klein). Nur bei Silk-UA aktiv; sonst laufen
   Oszillator-/Video-Wache. Selbst implementiert statt fremdes Script. */
function silkWacheStarten() {
  if (!SILK || silkAudio) return;
  try {
    const el = document.createElement("audio");
    el.muted = true;
    el.autoplay = true;
    el.setAttribute("playsinline", "");
    el.dataset.keep = "1";
    el.src = SILK_MEDIA + "?q=" + Date.now();
    el.onended = () => {
      el.src = SILK_MEDIA + "?q=" + Date.now();
      el.currentTime = 0;
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    };
    document.body.appendChild(el);
    const haerbar = () => {
      if (!el.muted) return;
      el.muted = false;
      el.src = SILK_MEDIA + "?q=" + Date.now();
      const p = el.play();
      if (p && p.catch) p.catch(() => {});
    };
    for (const ev of ["keydown", "pointerdown", "click"]) {
      document.addEventListener(ev, haerbar, { once: false });
    }
    const p = el.play();
    if (p && p.catch) p.catch(() => {});
    silkAudio = el;
  } catch (e) { silkAudio = null; }
}

function audioWacheStarten() {
  /* Auf Kays Silk ist die Silk-Wache die ALLEINIGE Audio-Wache - hier
     keinen eigenen Oszillator starten (Doppel-Audio). */
  if (SILK) { silkWacheStarten(); return; }
  if (state.wachen) {
    if (state.wachen.state === "suspended") {
      state.wachen.resume().catch(() => {});
    }
    return;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.wachen = new AC();
    const osc = state.wachen.createOscillator();
    const gain = state.wachen.createGain();
    gain.gain.value = 0.001;          /* praktisch stumm, zaehlt als Ton */
    osc.frequency.value = 220;
    osc.connect(gain);
    gain.connect(state.wachen.destination);
    osc.start();
    state.wachen.resume().catch(() => {});
  } catch (e) {
    state.wachen = null;
  }
}

function wachMarkieren(grund) {
  /* Erster Start oder Neustart nach Kill: Zeitstempel neu, Neustarts zaehlen */
  if (!state.wachSeit) {
    state.wachSeit = Date.now();
    state.wachNeustarts = 0;
  } else if (grund) {
    state.wachNeustarts++;
  }
}

function wachenTakt() {
  /* Audio-Wache (Hauptwache, immer und in jedem Klang-Modus) */
  audioWacheStarten();
  let audioLebt = false;
  if (state.wachen && state.wachen.state === "running") {
    audioLebt = true;
  } else if (state.wachen && !document.hidden) {
    state.wachen.resume().catch(() => {});
  }
  if (audioLebt && !state.wachAudioLebt) wachMarkieren("audio");
  state.wachAudioLebt = audioLebt;

  /* Video-Wache (zweite Schicht) */
  let videoLebt = false;
  if (state.video && state.lockTyp === "video" && !document.hidden) {
    if (state.video.paused) {
      const p = state.video.play();
      if (p && p.catch) p.catch(() => {});
    }
    videoLebt = !state.video.paused;
  }
  if (videoLebt && !state.wachVideoLebt && state.wachAudioLebt === false) {
    wachMarkieren("video");
  }
  state.wachVideoLebt = videoLebt;

  /* Sichtbarer Nachweis im Fuss. Auf Silk zeigt er "wach: Silk-Ton",
     sobald die stille MP3 tatsächlich spielt. */
  if ($("fuss-hinweis") && Date.now() >= state.hinweisBis) {
    const keep = document.querySelector('audio[data-keep="1"]');
    const keepLebt = !!SILK && !!keep && !keep.paused;
    if (SILK && keepLebt && !state.wachSeit) {
      state.wachSeit = Date.now();
    }
    if (SILK && !keepLebt && state.wachSeit) {
      state.wachSeit = 0;               /* Wache weg -> Zaehler neutral */
    }
    if (state.wachSeit && (audioLebt || videoLebt || keepLebt)) {
      const seit = new Date(state.wachSeit).toLocaleTimeString("de-DE",
        { hour: "2-digit", minute: "2-digit" });
      const neu = state.wachNeustarts
        ? " · " + state.wachNeustarts + " Neustart" +
          (state.wachNeustarts > 1 ? "s" : "")
        : "";
      $("fuss-hinweis").textContent = SILK
        ? "wach: Silk-Ton · seit " + seit + neu
        : "wach seit " + seit + " (" +
          [audioLebt ? "Audio" : "", videoLebt ? "Video" : ""]
            .filter(Boolean).join("+") + ")" + neu;
      $("fuss-hinweis").title = "Wake Lock: " +
        (state.lockTyp === "wakelock" ? "Bildschirm-Sperre"
         : state.lockTyp === "video" ? "Wiedergabe-Wächter" : "keiner");
    } else {
      $("fuss-hinweis").textContent = "";
    }
  }
}

/* Heartbeat: alle 5 Min die Wachen anfassen (endet ein Stillstand, greift
   der 2-s-Takt und zaehlt den Neustart mit neuer Zeit) */
setInterval(() => {
  if (document.hidden) return;
  audioWacheStarten();
  if (state.video && state.lockTyp === "video" && state.video.paused) {
    const p = state.video.play();
    if (p && p.catch) p.catch(() => {});
  }
}, 300000);

function tonAnzeige() {
  const el = $("ton");
  el.hidden = false;
  if (state.klang === "soundbar") {
    el.textContent = "Klang: Soundbar";
    el.className = "ton ok";
  } else if (state.audio.weg === "wav" ||
             (state.aCtx && state.aCtx.state === "running")) {
    el.textContent = "Ton an";
    el.className = "ton ok";
  } else {
    el.textContent = "Ton freischalten";
    el.className = "ton warn";
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

let mikroLaeuft = null;

async function mikroAktivieren() {
  if (state.mikro.aktiv) return true;
  /* Nur EIN getUserMedia - gleichzeitig feurende Wege (Weckwort + Orb-Tipp)
     teilen sich denselben Aufruf, Silk lehnt einen zweiten Stream ab. */
  if (mikroLaeuft) return mikroLaeuft;
  mikroLaeuft = (async () => {
    let stream;
    try {
      /* Schlichtestmoeglicher Aufruf: {audio: true} OHNE Constraints -
         Geraete wie Kays Silk werfen bei channelCount/echoCancellation-
         Objekten sofort OverconstrainedError OHNE Berechtigungs-Dialog.
         echoCancellation etc. sind Nice-to-have, der Server resampled
         ohnehin auf 16 kHz. */
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e && e.name) || "unbekannt";
      /* Zwangstransparenz: der ROHE Fehler-Name steht vorn - so sehen wir
         in 10 Sekunden, ob das Geraet blockt (NotAllowed) oder unser
         Aufruf/Device schuld ist (Overconstrained/NotReadable/...). */
      if (name === "NotAllowedError" || name === "SecurityError") {
        hinweisSetzen("Mikro: " + name + " - im Browser-Zugriffsfenster erlauben", 120);
      } else {
        hinweisSetzen("Mikro: " + name + " - kurz warten, dann nochmal tippen", 120);
      }
      mikroLaeuft = null;
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
  mikroLaeuft = null;
  return true;
  })();
  return mikroLaeuft;
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
  state.hoert = false;
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
        state.letztesGemma = Date.now();
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
      state.hinweisBis = 0;
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
    const r = await fetch(location.origin + "/gemma-live/status?" + p.toString(),
      { cache: "no-store" });
    if (!r.ok) return;
    d = await r.json();
  } catch (e) {
    return;
  }
  if (d.klang && d.klang.ziel) {
    const vorher = state.klang;
    state.klang = d.klang.ziel;
    if (vorher !== state.klang) tonAnzeige();
  }
  weltHolen(d);
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
  radarKachelStart();   /* aus: Hinweis, kein Laden; an: Radar wieder */
}

function bilderKnopfSetzen() {
  const b = $("bilder-btn");
  b.classList.toggle("an", state.bilder);
  b.setAttribute("aria-pressed", state.bilder ? "true" : "false");
  b.textContent = state.bilder ? "Bilder an" : "Bilder aus";
}

function kachelVital(v) {
  state.kachelDaten["k-vital"] = v || null;
  const box = $("vital-raster");
  if (!box) return;
  box.innerHTML = "";
  const felder = [
    ["puls", "Puls"], ["schritte", "Schritte"],
    ["schlaf", "Schlaf"], ["readiness", "Fit"]
  ];
  const daten = felder
    .map(([key, name]) => ({
      name,
      wert: (v && typeof v[key] === "number" && isFinite(v[key]))
        ? Math.round(v[key]) : null
    }))
    .filter((f) => f.wert !== null);
  if (!daten.length) {
    /* Nie Daten oder nichts Greifbares: ein ruhiger Satz statt Striche */
    const leer = document.createElement("div");
    leer.className = "kachel-zusatz";
    leer.textContent = "Die Uhr meldet sich, sobald neue Werte da sind.";
    box.append(leer);
    $("v-alter").textContent = "";
    return;
  }
  for (const f of daten) {
    const zelle = document.createElement("div");
    zelle.className = "vital-wert";
    const zahl = document.createElement("span");
    zahl.textContent = f.wert;
    const name = document.createElement("small");
    name.textContent = f.name;
    zelle.append(zahl, name);
    box.append(zelle);
  }
  $("v-alter").textContent = vitalStand(v);
}

/* "von heute" oder ehrlich: "Stand: 6. Okt." */
function vitalStand(v) {
  if (!v || !v.datum) return "";
  if (v.datum === heuteStr()) return "von heute";
  const teile = String(v.datum).split("-");
  const d = new Date(Number(teile[0]), Number(teile[1]) - 1, Number(teile[2]));
  if (isNaN(d.getTime())) return "Stand: " + v.datum;
  return "Stand: " + d.toLocaleDateString("de-DE", { day: "numeric", month: "short" });
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
    const r = await fetch(location.origin + "/gemma-live/status?" + p.toString(),
      { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      if (d && d.musik) kachelMusik(d.musik);
      return;
    }
  } catch (e) { /* Kachel bleibt wie sie ist */ }
  statusHolen();
}

async function klangSchalten() {
  const ziel = state.klang === "soundbar" ? "klang_show" : "klang_soundbar";
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("aktion", ziel);
  p.set("t", Date.now());
  try {
    const r = await fetch(location.origin + "/gemma-live/status?" + p.toString(), { cache: "no-store" });
    if (r.ok) {
      const d = await r.json();
      if (d && d.klang && d.klang.ziel) {
        state.klang = d.klang.ziel;
        if (state.klang === "soundbar") {
          wiedergabeStoppen();               /* Soundbar spricht: Ton hier aus */
        }
      }
    }
  } catch (e) { /* Anzeige bleibt wie sie ist */ }
  tonAnzeige();
}

/* ---------------- Wetter: 3 Tage (Open-Meteo, kein Key) ---------------- */

const WETTER_URL = "https://api.open-meteo.com/v1/forecast?latitude=53.8655&longitude=10.6866" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
  "&timezone=Europe%2FBerlin&forecast_days=3";

async function wetterHolen() {
  try {
    const c = localStorage.getItem("gemma_wetter");
    if (c) {
      const d = JSON.parse(c);
      if (d && d.daten && Date.now() - d.t < 600000) { kachelWetter(d.daten); return; }
    }
  } catch (e) { /* Cache kaputt: neu holen */ }
  try {
    const r = await fetch(WETTER_URL, { cache: "no-store" });
    if (!r.ok) throw new Error("wetter http");
    const d = await r.json();
    if (!d.daily) throw new Error("wetter leer");
    try { localStorage.setItem("gemma_wetter", JSON.stringify({ t: Date.now(), daten: d })); }
    catch (e) { /* Cache voll: egal */ }
    kachelWetter(d);
  } catch (e) {
    kachelWetter(null);
  }
}

function wetterIcon(code) {
  let art = "wolke";
  if (code === 0) art = "sonne";
  else if (code >= 1 && code <= 2) art = "heiter";
  else if (code === 3) art = "wolke";
  else if (code === 45 || code === 48) art = "nebel";
  else if (code >= 51 && code <= 67) art = "regen";
  else if (code >= 71 && code <= 77) art = "schnee";
  else if (code >= 80 && code <= 82) art = "schauer";
  else if (code >= 85 && code <= 86) art = "schnee";
  else if (code >= 95) art = "blitz";
  const strahlen = '<g stroke="#ffd166" stroke-width="3" stroke-linecap="round">' +
    '<line x1="32" y1="6" x2="32" y2="14"/><line x1="32" y1="50" x2="32" y2="58"/>' +
    '<line x1="6" y1="32" x2="14" y2="32"/><line x1="50" y1="32" x2="58" y2="32"/>' +
    '<line x1="13" y1="13" x2="19" y2="19"/><line x1="45" y1="45" x2="51" y2="51"/>' +
    '<line x1="51" y1="13" x2="45" y2="19"/><line x1="19" y1="45" x2="13" y2="51"/></g>';
  const sonne = '<circle cx="32" cy="32" r="12" fill="#ffd166"/>' + strahlen;
  const wolke = '<path d="M18 42 a9 9 0 0 1 1.5-17.9 a12 12 0 0 1 23-3.2 a8.5 8.5 0 0 1 3.5 16.3 z" fill="#b9c6da"/>';
  const formen = {
    sonne: sonne,
    heiter: '<circle cx="24" cy="22" r="9" fill="#ffd166"/>' + wolke,
    wolke: wolke,
    nebel: '<g stroke="#b9c6da" stroke-width="4" stroke-linecap="round">' +
      '<line x1="12" y1="24" x2="52" y2="24"/><line x1="16" y1="34" x2="48" y2="34"/>' +
      '<line x1="12" y1="44" x2="52" y2="44"/></g>',
    regen: wolke + '<g stroke="#4fa3ff" stroke-width="3.5" stroke-linecap="round">' +
      '<line x1="24" y1="46" x2="21" y2="54"/><line x1="33" y1="46" x2="30" y2="56"/>' +
      '<line x1="42" y1="46" x2="39" y2="54"/></g>',
    schauer: wolke + '<g stroke="#4fa3ff" stroke-width="3.5" stroke-linecap="round">' +
      '<line x1="22" y1="47" x2="18" y2="55"/><line x1="34" y1="47" x2="30" y2="57"/>' +
      '<line x1="46" y1="47" x2="42" y2="55"/></g>' +
      '<line x1="40" y1="36" x2="34" y2="44" stroke="#4fa3ff" stroke-width="3" stroke-linecap="round"/>',
    schnee: wolke + '<g fill="#dff2ff"><circle cx="24" cy="50" r="2.4"/><circle cx="33" cy="54" r="2.4"/>' +
      '<circle cx="42" cy="50" r="2.4"/></g>',
    blitz: wolke + '<path d="M33 42 L26 54 L32 54 L29 62 L38 50 L32 50 Z" fill="#ffd166"/>',
  };
  return "<svg viewBox='0 0 64 64' class='wtag-svg' aria-hidden='true'>" + (formen[art] || wolke) + "</svg>";
}

function wochentagKurz(iso) {
  const teile = String(iso).split("-");
  const d = new Date(Number(teile[0]), Number(teile[1]) - 1, Number(teile[2]));
  return TAGE_KURZ[d.getDay()];
}

function kachelWetter(d) {
  state.wetter = d;
  const box = $("wetter-tage");
  box.innerHTML = "";
  if (!d || !d.daily || !d.daily.time || !d.daily.time.length) {
    const leer = document.createElement("div");
    leer.className = "kachel-zusatz";
    leer.textContent = "Wetter gerade nicht erreichbar";
    box.append(leer);
    return;
  }
  const tage = d.daily;
  for (let i = 0; i < Math.min(3, tage.time.length); i++) {
    const zelle = document.createElement("div");
    zelle.className = "wtag" + (i === 0 ? " wtag-heute" : "");
    const name = i === 0 ? "heute" : wochentagKurz(tage.time[i]);
    const regen = (tage.precipitation_probability_max[i] == null)
      ? "—" : Math.round(tage.precipitation_probability_max[i]) + " %";
    zelle.innerHTML =
      '<div class="wtag-name">' + name + "</div>" +
      '<div class="wtag-icon">' + wetterIcon(tage.weather_code[i]) + "</div>" +
      '<div class="wtag-werte"><b>' + Math.round(tage.temperature_2m_max[i]) +
      "°</b> / " + Math.round(tage.temperature_2m_min[i]) + "°</div>" +
      '<div class="wtag-regen">' + regen + " Regen</div>";
    box.append(zelle);
  }
  state.kachelDaten["k-wetter"] = d;
}

/* ---------------- gemivo-Welt ---------------- */

function weltHolen(d) {
  /* Server-Daten stecken im /status (bruecke, 60s-Cache) */
  if (!d || !d.welt) return;
  state.welt = d.welt;
  d.welt.zeit = d.zeit;   /* Stand-Angabe: kachelWelt sieht nur d.welt */
  kachelWelt(d.welt);
}

/* Farbschwellen bewusst hardcoded (Kay-Wunsch, ehrlich): gruene Zahl
   bis 69, gelbe ab 70, rote ab 90 - gleich fuer CPU, RAM und Disk. */
function serverStufe(wert) {
  return wert >= 90 ? "server-rot" : wert >= 70 ? "server-gelb" : "server-gruen";
}

function uptimeMenschlich(sek) {
  const tage = Math.floor(sek / 86400);
  const stunden = Math.floor((sek % 86400) / 3600);
  if (tage >= 1) {
    return tage + (tage === 1 ? " Tag" : " Tage")
      + (stunden ? " " + stunden + " Std" : "");
  }
  return stunden + " Std " + Math.floor((sek % 3600) / 60) + " Min";
}

function kachelWelt(d) {
  /* SERVER-Kachel: grosse Zahlen CPU/RAM/Disk (+ Temp, falls da),
     Zeile 2 = Uptime + Dienste-down. Die App-Ampel lebt nur im Overlay. */
  const v = d.vital || {};
  const box = $("server-zahlen");
  box.innerHTML = "";
  const werte = [["CPU", v.cpu_prozent], ["RAM", v.ram_prozent],
                 ["Disk", v.disk_prozent]];
  if (typeof v.temp_celsius === "number") werte.push(["Temp", v.temp_celsius, "°"]);
  let gezeigt = 0;
  for (const [name, wert, einheit] of werte) {
    if (typeof wert !== "number") continue;
    gezeigt += 1;
    const zelle = document.createElement("div");
    zelle.className = "server-zahl";
    const zahl = document.createElement("span");
    zahl.className = "server-wert " + serverStufe(wert);
    zahl.textContent = Math.round(wert) + (einheit || "%");
    const label = document.createElement("small");
    label.textContent = name;
    zelle.append(zahl, label);
    box.append(zelle);
  }
  if (!gezeigt) {
    const leer = document.createElement("div");
    leer.className = "kachel-zusatz";
    leer.textContent = "—";
    box.append(leer);
  }
  const zeile2 = $("welt-zeile2");
  zeile2.innerHTML = "";
  const stuecke = [];
  if (typeof v.uptime_sekunden === "number") {
    stuecke.push(["Uptime " + uptimeMenschlich(v.uptime_sekunden), ""]);
  } else if (v.uptime_tage != null) {
    stuecke.push(["Uptime " + v.uptime_tage + " Tage", ""]);
  }
  const dienste = v.dienste;
  if (dienste && typeof dienste.failed === "number") {
    stuecke.push([dienste.failed + (dienste.failed === 1 ? " Dienst down" : " Dienste down"),
                  dienste.failed > 0 ? "dienst-down rot" : "dienst-down"]);
  }
  stuecke.forEach(([text, klasse], i) => {
    if (i) zeile2.append(" · ");
    const span = document.createElement("span");
    if (klasse) span.className = klasse;
    span.textContent = text;
    zeile2.append(span);
  });
  if (!stuecke.length) zeile2.textContent = "—";
  const alter = d.zeit ? Math.round(Date.now() / 1000 - d.zeit) : 999;
  $("welt-alter").textContent = alter < 300 ? "Stand: gerade geprüft"
    : "Stand: vor " + Math.round(alter / 60) + " Min";
  state.kachelDaten["k-welt"] = d;
}

/* ---------------- Regenradar (Rainviewer über dunkler Karte) ----------------
   Die Wand-Kachel zeigt ein statisches Basemap-Mosaik (CARTO dark, wird vom
   Browser gecacht) mit Lübeck-Marker, darüber die animierten Radar-Frames.
   Frames und Timers teilt sie sich mit dem Radar im Wetter-Overlay. */

const RADAR_Z = 6, RADAR_X = 33, RADAR_Y = 20;          /* Lübeck-Kachel (Overlay) */
const RADAR_LAT = 53.8655, RADAR_LON = 10.6867;         /* Marker */

function radarFrameUrl(basis, zx, zy) {
  return basis + "/256/" + RADAR_Z + "/" + zx + "/" + zy + "/2/1_1.png";
}

async function radarFramesHolen() {
  try {
    const r = await fetch("https://api.rainviewer.com/public/weather-maps.json",
      { cache: "no-store" });
    const d = await r.json();
    const past = (d.radar && d.radar.past) || [];
    state.radar.frames = past.slice(-8).map((f) => d.host + f.path);
    radarKarteBauen();
  } catch (e) {
    state.radar.frames = [];
  }
}

/* Web-Mercator: Längen-/Breitengrad → Pixel in der Karten-Welt */
function radarWeltPx(lat, lon, z) {
  const n = Math.pow(2, z) * 256;
  const rad = lat * Math.PI / 180;
  return {
    x: (lon + 180) / 360 * n,
    y: (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n
  };
}

/* Mosaik + Radar-Ebenen + Marker auf die aktuelle Kachelgröße legen.
   Lübeck liegt exakt in der Mitte, die Kacheln decken die ganze Fläche. */
function radarKarteBauen() {
  const karte = $("radar-karte");
  const mosaik = $("radar-mosaik");
  const marker = $("radar-marker");
  if (!karte || !mosaik) return;
  const w = karte.clientWidth, h = karte.clientHeight;
  if (!w || !h) return;
  mosaik.innerHTML = "";
  mosaik.style.width = w + "px";
  mosaik.style.height = h + "px";
  mosaik.style.left = "0px";
  mosaik.style.top = "0px";

  const zentrum = radarWeltPx(RADAR_LAT, RADAR_LON, RADAR_Z);
  const linksWelt = zentrum.x - w / 2, obenWelt = zentrum.y - h / 2;
  const ersteSpalte = Math.floor(linksWelt / 256), letzteSpalte = Math.floor((linksWelt + w) / 256);
  const ersteZeile = Math.floor(obenWelt / 256), letzteZeile = Math.floor((obenWelt + h) / 256);
  const kachelPosition = (zx, zy) => ({
    links: zx * 256 - linksWelt,
    oben: zy * 256 - obenWelt
  });

  /* dunkles Basemap-Mosaik (Esri Dark Gray, statisch, Browser-Cache)
     + Referenz-Layer mit Stadt-Labels (Hamburg, Bremen, Ostsee …) */
  const esri = (dienst, zx, zy) =>
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/" + dienst +
    "/MapServer/tile/" + RADAR_Z + "/" + zy + "/" + zx;
  for (let zy = ersteZeile; zy <= letzteZeile; zy++) {
    for (let zx = ersteSpalte; zx <= letzteSpalte; zx++) {
      const p = kachelPosition(zx, zy);
      const img = document.createElement("img");
      img.className = "radar-karte-tile";
      img.alt = "";
      img.loading = "lazy";
      img.style.left = p.links + "px";
      img.style.top = p.oben + "px";
      img.src = esri("World_Dark_Gray_Base", zx, zy);
      mosaik.append(img);
      const namen = document.createElement("img");
      namen.className = "radar-karte-labels";
      namen.alt = "";
      namen.loading = "lazy";
      namen.style.left = p.links + "px";
      namen.style.top = p.oben + "px";
      namen.src = esri("World_Dark_Gray_Reference", zx, zy);
      mosaik.append(namen);
    }
  }

  /* Radar-Ebenen: ein Layer je Frame, Kacheln lazy beim ersten Anzeigen */
  const ebenen = document.createElement("div");
  ebenen.className = "radar-ebenen";
  ebenen.style.width = w + "px";
  ebenen.style.height = h + "px";
  state.radar.ebenen = state.radar.frames.map((basis) => {
    const ebene = document.createElement("div");
    ebene.className = "radar-ebene";
    for (let zy = ersteZeile; zy <= letzteZeile; zy++) {
      for (let zx = ersteSpalte; zx <= letzteSpalte; zx++) {
        const img = document.createElement("img");
        img.alt = "";
        const p = kachelPosition(zx, zy);
        img.style.left = p.links + "px";
        img.style.top = p.oben + "px";
        img.dataset.src = radarFrameUrl(basis, ((zx % 64) + 64) % 64, zy);
        img.hidden = true;
        ebene.append(img);
      }
    }
    ebenen.append(ebene);
    return ebene;
  });
  mosaik.append(ebenen);

  /* Marker an der echten mercator-Position: exakt die Mitte = Lübeck */
  if (marker) {
    marker.style.left = (w / 2) + "px";
    marker.style.top = (h / 2) + "px";
  }
  radarDrehen();
}

function radarDrehen() {
  if (!state.radar.frames.length) return;
  const pos = state.radar.pos % state.radar.frames.length;
  const basis = state.radar.frames[pos];
  /* Radar im Wetter-Overlay (einzelne Lübeck-Kachel, wie gehabt) */
  const overlay = $("radar-bild");
  if (overlay) overlay.src = radarFrameUrl(basis, RADAR_X, RADAR_Y);
  /* Wand: Layer-Sichtbarkeit umschalten, Kacheln beim ersten Mal laden */
  (state.radar.ebenen || []).forEach((ebene, i) => {
    if (!ebene) return;
    const aktiv = i === pos;
    ebene.classList.toggle("aktiv", aktiv);
    if (aktiv && !ebene.dataset.geladen) {
      ebene.querySelectorAll("img").forEach((img) => {
        if (!img.src) { img.src = img.dataset.src; img.hidden = false; }
      });
      ebene.dataset.geladen = "1";
    }
  });
  state.radar.pos++;
}

function radarHinweisSetzen(text) {
  for (const id of ["radar-hinweis", "radar-kachel-hinweis"]) {
    const el = $(id);
    if (!el) continue;
    if (text) { el.textContent = text; el.hidden = false; }
    else el.hidden = true;
  }
}

function radarStart() {
  radarStop();
  if (!state.bilder) {
    radarHinweisSetzen("Bilder sind aus - den Bilder-Knopf antippen");
    return;
  }
  radarHinweisSetzen(null);
  radarKarteBauen();
  radarFramesHolen().then(() => {
    radarDrehen();
    state.radar.rot = setInterval(radarDrehen, 900);
  });
  state.radar.liste = setInterval(radarFramesHolen, 300000);
}

/* Radar-Kachel auf der Wand: gleiche Frames und Timers wie im Overlay.
   Bilder aus: Hinweis statt Radar, es wird nichts geladen. */
function radarKachelStart() {
  const karte = $("radar-karte");
  if (!karte) return;
  if (!state.bilder) {
    radarStop();
    karte.hidden = true;
    radarHinweisSetzen("Bilder sind aus - den Bilder-Knopf antippen");
    return;
  }
  karte.hidden = false;
  radarStart();
}

function radarStop() {
  if (state.radar.rot) { clearInterval(state.radar.rot); state.radar.rot = null; }
  if (state.radar.liste) { clearInterval(state.radar.liste); state.radar.liste = null; }
}

/* ---------------- Verlauf (letzte Gespräche aller Geräte) ---------------- */

async function verlaufHolen(dev) {
  const p = new URLSearchParams();
  p.set("token", CFG.token);
  p.set("t", Date.now());
  const r = await fetch(location.origin + "/gemma-live/verlauf/" + encodeURIComponent(dev) +
    ".json?" + p.toString(), { cache: "no-store" });
  if (!r.ok) return null;
  const d = await r.json();
  const msgs = (d.messages || []).filter((m) => m && m.content);
  return { ts: d.ts || 0, msgs: msgs.slice(-8) };
}

async function verlaufPoll() {
  if (!ZEIGE_GESPRAECH || !CFG.token || !CFG.geraete.length || state.chat.length) return;
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
  /* Radar-Kachel: das bestehende Wetter-Overlay, direkt beim Radar */
  if (id === "k-radar") {
    overlayOeffnen("k-wetter");
    const radar = $("radar-bild");
    if (radar) radar.scrollIntoView({ block: "nearest" });
    return;
  }
  const el = $(id);
  if (!el || $("overlay").classList.contains("offen")) return;
  const daten = state.kachelDaten[id] || null;
  const label = el.querySelector(".kachel-label");
  $("overlay-label").textContent = label
    ? (id === "k-welt" ? label.firstChild.textContent : label.textContent)
    : "";
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
  } else if (id === "k-wetter") {
    const tage = state.wetter && state.wetter.daily;
    if (!tage || !tage.time) {
      const leer = document.createElement("div");
      leer.className = "ov-leer";
      leer.textContent = "Wetter gerade nicht erreichbar.";
      inhalt.append(leer);
    } else {
      const trend = document.createElement("div");
      trend.className = "ov-wetter";
      for (let i = 0; i < Math.min(3, tage.time.length); i++) {
        const zelle = document.createElement("div");
        zelle.className = "ov-wtag";
        const name = i === 0 ? "heute" : wochentagKurz(tage.time[i]);
        const regen = (tage.precipitation_probability_max[i] == null)
          ? "—" : Math.round(tage.precipitation_probability_max[i]) + " %";
        zelle.innerHTML =
          '<div class="wtag-name">' + name + "</div>" +
          '<div class="wtag-icon gross">' + wetterIcon(tage.weather_code[i]) + "</div>" +
          '<div class="ov-wtag-temp"><b>' + Math.round(tage.temperature_2m_max[i]) +
          "°</b> / " + Math.round(tage.temperature_2m_min[i]) + "°</div>" +
          '<div class="wtag-regen">' + regen + " Regen</div>";
        trend.append(zelle);
      }
      inhalt.append(trend);
      const radarLabel = document.createElement("div");
      radarLabel.className = "ov-label";
      radarLabel.style.marginTop = "1.6rem";
      radarLabel.textContent = "Regenradar (letzte 90 Minuten)";
      inhalt.append(radarLabel);
      const bild = document.createElement("img");
      bild.id = "radar-bild";
      bild.className = "radar-bild";
      bild.alt = "Regenradar";
      inhalt.append(bild);
      const hinweis = document.createElement("div");
      hinweis.id = "radar-hinweis";
      hinweis.className = "ov-leer";
      hinweis.hidden = true;
      inhalt.append(hinweis);
      radarStart();
    }
  } else if (id === "k-welt" && daten) {
    const v = daten.vital || {};
    /* Tabelle aller Werte */
    if (typeof v.cpu_prozent === "number") {
      zeileInOverlay(inhalt, "CPU-Last", Math.round(v.cpu_prozent) + " %");
    }
    if (typeof v.ram_prozent === "number") {
      zeileInOverlay(inhalt, "RAM belegt", Math.round(v.ram_prozent) + " %");
    }
    if (typeof v.disk_prozent === "number") {
      zeileInOverlay(inhalt, "Platte belegt", Math.round(v.disk_prozent) + " %");
    }
    if (typeof v.temp_celsius === "number") {
      zeileInOverlay(inhalt, "CPU-Temperatur", v.temp_celsius + " °C");
    }
    if (typeof v.uptime_sekunden === "number") {
      zeileInOverlay(inhalt, "Uptime", uptimeMenschlich(v.uptime_sekunden));
    } else if (v.uptime_tage != null) {
      zeileInOverlay(inhalt, "Uptime", v.uptime_tage + " Tage");
    }
    if (v.cert_tage != null) {
      zeileInOverlay(inhalt, "Nächstes Zertifikat läuft in",
                     v.cert_tage + " Tagen (" + (v.cert_host || "") + ")");
    }
    /* Dienste: nur die auffaelligen, sonst die gruene Gesamtmeldung */
    const abschnittD = document.createElement("div");
    abschnittD.className = "ov-abschnitt";
    abschnittD.textContent = "Dienste";
    inhalt.append(abschnittD);
    const dienste = v.dienste;
    const failedListe = dienste && Array.isArray(dienste.failedListe)
      ? dienste.failedListe : [];
    if (dienste && typeof dienste.gesamt === "number" && failedListe.length) {
      for (const name of failedListe) {
        const zeile = document.createElement("div");
        zeile.className = "ov-roh-zeile";
        const k = document.createElement("span");
        k.className = "ov-roh-key";
        k.textContent = name;
        const w = document.createElement("span");
        w.className = "ov-roh-wert rot";
        w.textContent = "down";
        zeile.append(k, w);
        inhalt.append(zeile);
      }
    } else if (dienste && typeof dienste.gesamt === "number") {
      zeileInOverlay(inhalt, "Status",
                     "Alle " + dienste.gesamt + " Dienste grün");
    } else {
      zeileInOverlay(inhalt, "Status", "—");
    }
    /* App-Ampel (sekundaer, unten) */
    const apps = daten.apps || [];
    const wach = apps.filter((a) => a.ok).length;
    const abschnittA = document.createElement("div");
    abschnittA.className = "ov-abschnitt";
    abschnittA.textContent = "Apps";
    inhalt.append(abschnittA);
    zeileInOverlay(inhalt, "Apps wach", wach + " von " + apps.length);
    const liste = document.createElement("div");
    liste.className = "app-liste";
    for (const a of apps) {
      const zeile = document.createElement("div");
      zeile.className = "app-zeile";
      const punkt = document.createElement("span");
      punkt.className = "punktapp " + (a.ok ? "ok" : "rot");
      const name = document.createElement("span");
      name.className = "app-name";
      name.textContent = a.host;
      const info = document.createElement("span");
      info.className = "app-ms";
      info.textContent = a.ok ? (a.ms + " ms") : "keine Antwort";
      zeile.append(punkt, name, info);
      liste.append(zeile);
    }
    inhalt.append(liste);
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
  radarStop();
  radarKachelStart();   /* Radar-Kachel auf der Wand läuft weiter */
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
    video.loop = true;
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
    /* Stillstehender Audio-Graph ueber dem Video (NoSleep-Art): einige
       Geraete-Schoner hoeren auf aktive Wiedergabe, nicht nur aufs Bild. */
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.wachen = new AC();
      const quelle = state.wachen.createMediaElementSource(video);
      const stumm = state.wachen.createGain();
      stumm.gain.value = 0;
      quelle.connect(stumm);
      stumm.connect(state.wachen.destination);
      state.wachen.resume().catch(() => {});
    } catch (e) { /* Video allein muss reichen */ }
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
    /* Wachen sofort zurueckholen (kein Suspend - Kill sichtbar zaehlen) */
    audioWacheStarten();
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
  audioWacheStarten();
});

document.addEventListener("click", () => {
  lockStarten();
  audioWacheStarten();
  if (localStorage.getItem("gemma_kiosk") && !document.fullscreenElement) {
    vollbildAnfordern();
  }
});

/* ---------------- Tasten ---------------- */

$("bilder-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  bilderSchalten();
});
$("ton").addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (state.klang === "soundbar") { klangSchalten(); return; }
  playbackCtx();
  tonAnzeige();
});
$("klang-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  klangSchalten();
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
gespraechKachelAufbauen();
$("haupt").classList.toggle("ohne-gespraech", !ZEIGE_GESPRAECH);
fotoKnopfSetzen();
tonAnzeige();
$("haupt").classList.toggle("ohne-fotos", !state.fotos);
if (state.fotos) fotoZeigen();
setInterval(uhrTicken, 1000);
setInterval(orbTakt, 1000);
setInterval(wiedergabeTakt, 250);
setInterval(wachenTakt, 2000);
setInterval(statusHolen, Math.max(15, CFG.statusSek) * 1000);
setInterval(wetterHolen, 600000);
if (ZEIGE_GESPRAECH) setInterval(verlaufPoll, 30000);
startupPruefen();
lockStarten();
kachelnKlickbarMachen();
statusHolen();
wetterHolen();
if (ZEIGE_GESPRAECH) verlaufPoll();
radarKachelStart();
let radarGroesseTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(radarGroesseTimer);
  radarGroesseTimer = setTimeout(() => {
    if (state.bilder) radarKarteBauen();
  }, 250);
});

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
    klang: state.klang, tonWeg: tonWegAktiv(),
    tonZustand: state.aCtx ? state.aCtx.state : "keiner",
    kacheln: Object.keys(state.kachelDaten)
  })
};
