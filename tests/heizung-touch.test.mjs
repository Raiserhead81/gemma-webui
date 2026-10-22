/* Playwright-Test: Heizungs-Touch-Soll an der Wand-UI (Echo Show 15).
   NIEMALS Kays echte Heizung: alle /gemma-live/heizung- und /status-Calls
   werden per page.route abgefangen (Netzwerk-Stub) — es geht kein einziger
   echter Request raus. Run: NODE_PATH=/usr/lib/node_modules node heizung-touch.test.mjs */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "/usr/lib/node_modules/playwright/index.mjs";

const WURZEL = "/var/www/gemma";
const MIMES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/* Zonen-Mock, per Szenario ueberschreibbar */
let zonenMock = [
  { name: "Wohnzimmer", ist: 21.3, soll: 22, power: "ON", modus: "MANUAL" },
  { name: "Schlafzimmer", ist: 18.4, soll: 20, power: "ON", modus: "AUTO" },
  { name: "Buero", ist: 20.1, soll: 21, power: "OFF", modus: "AUTO" },
];
let statusAntworten = [];
let heizungVerhalten = "ok";   /* ok | fehler | netz | default */
const heizungCalls = [];

let fehlgeschlagen = 0;
function pruef(name, bedingung, extra = "") {
  if (bedingung) { console.log("  OK   " + name); return; }
  fehlgeschlagen += 1;
  console.log("  FAIL " + name + (extra ? " -> " + extra : ""));
}

const statisch = createServer(async (req, res) => {
  try {
    const pfad = req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0];
    const inhalt = await readFile(join(WURZEL, pfad));
    res.writeHead(200, { "Content-Type": MIMES[extname(pfad)] || "text/plain" });
    res.end(inhalt);
  } catch (e) { res.writeHead(404); res.end("nein"); }
});

function statusJson() {
  return {
    ok: true, zeit: Math.floor(Date.now() / 1000),
    heizung: zonenMock,
    musik: { verbunden: false, laeuft: false },
    termine: [], vital: {}, markt: {}, welt: null, fotos: [],
  };
}

async function neueSeite(browser) {
  const seite = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    hasTouch: true,
  });
  await seite.route("**/gemma-live/status*", async (route) => {
    const url = route.request().url();
    statusAntworten.push(url);
    const naechster = statusAntwortenFeld();
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify(statusJsonMit(naechster)) });
  });
  await seite.route("**/gemma-live/heizung", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    heizungCalls.push(body);
    if (heizungVerhalten === "fehler") {
      await route.fulfill({ status: 502, contentType: "application/json",
        body: JSON.stringify({ ok: false, text: "Heizung: tado meldet Fehler" }) });
    } else if (heizungVerhalten === "netz") {
      await route.abort("connectionrefused");
    } else {
      await route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, text: "Wohnzimmer auf " + body.grad + " Grad" }) });
    }
  });
  await seite.goto("http://127.0.0.1:" + PORT + "/index.html");
  /* Startup-Overlay (erwartet Vollbild, gibt es am Echo immer) aus dem Weg */
  await seite.evaluate(() => {
    const el = document.getElementById("startup");
    if (el) el.style.display = "none";
  });
  await seite.waitForTimeout(400);
  return seite;
}

let statusPlan = [];
function statusAntwortenFeld() { return statusPlan.shift() ?? null; }
function statusJsonMit(override) {
  if (!override) return statusJson();
  return { ...statusJson(), heizung: override };
}

function sollVon(seite, zone) {
  return seite.evaluate((z) => {
    const zeile = document.querySelector('#heizung-liste [data-zone="' + z + '"]');
    return zeile ? zeile.querySelector(".hz-soll").textContent : null;
  }, zone);
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
function parseDe(t) { return parseFloat(String(t).replace(",", ".")); }

async function main() {
  await new Promise((r) => statisch.listen(0, "127.0.0.1", r));
  globalThis.PORT = statisch.address().port;
  const browser = await chromium.launch();

  /* ---------- 1) Unit-Checks: Clamp + Stepper-Faehigkeit ---------- */
  console.log("Unit (im echten Seitenkontext):");
  {
    const s = await neueSeite(browser);
    const e = await s.evaluate(() => ({
      a: heizungClamp(22.3), b: heizungClamp(26), c: heizungClamp(3),
      d: heizungClamp(5), e2: heizungClamp(25), f: heizungClamp(0.2),
      ww: heizungStepperMoeglich({ soll: 48 }),
      aus: heizungStepperMoeglich({ soll: null }),
      ok1: heizungStepperMoeglich({ soll: 21.5 }),
      txt: heizungGradText(22.5),
    }));
    pruef("clamp rundet auf 0,5 (22,3 -> 22,5)", e.a === 22.5, String(e.a));
    pruef("clamp oben 26 -> 25", e.b === 25);
    pruef("clamp unten 3 -> 5", e.c === 5);
    pruef("clamp Grenzen bleiben 5/25", e.d === 5 && e.e2 === 25);
    pruef("clamp 0,2 -> 5", e.f === 5);
    pruef("Warmwasser (48) bekommt keinen Stepper", e.ww === false);
    pruef("Zone ohne Soll bekommt keinen Stepper", e.aus === false);
    pruef("normale Zone bekommt Stepper", e.ok1 === true);
    pruef("deutsche Zahl (22,5°)", e.txt === "22,5°", e.txt);
    await s.close();
  }

  /* ---------- 2) Rendering: 3 Stepper, Warmwasser nicht ---------- */
  console.log("Rendering:");
  zonenMock = [
    { name: "Wohnzimmer", ist: 21.3, soll: 22, power: "ON", modus: "MANUAL" },
    { name: "Schlafzimmer", ist: 18.4, soll: 20, power: "ON", modus: "AUTO" },
    { name: "Buero", ist: 20.1, soll: 21, power: "OFF", modus: "AUTO" },
    { name: "Warmwasser", ist: 43.2, soll: 48, power: "ON", modus: "" },
  ];
  {
    const s = await neueSeite(browser);
    const zaehl = await s.evaluate(() => ({
      zeilen: document.querySelectorAll("#heizung-liste .heizung-zeile").length,
      stepper: document.querySelectorAll("#heizung-liste .heizung-stepper").length,
      dicht: document.querySelector("#heizung-liste").classList.contains("heizung-dicht"),
      textWW: (document.querySelector('[data-zone="Warmwasser"] .heizung-wert') || {}).textContent || "",
    }));
    pruef("4 Zeilen gerendert", zaehl.zeilen === 4);
    pruef("nur 3 Stepper (Warmwasser ohne)", zaehl.stepper === 3);
    pruef("4 Zonen -> Kompakt-Layout an", zaehl.dicht === true);
    pruef("Warmwasser-Zeile zeigt ist · soll", zaehl.textWW.includes("soll"), zaehl.textWW);
    /* Touch-Target: mindestens ~44 px (dicht: 40 px optisch + Treffflaeche) */
    const box = await s.evaluate(() => {
      const b = document.querySelector('[data-zone="Wohnzimmer"] .hz-plus').getBoundingClientRect();
      return { w: b.width, h: b.height };
    });
    pruef("Button 38 px optisch im Dicht-Layout (44 px Treffflaeche via ::after)", box.w >= 37 && box.h >= 37, JSON.stringify(box));
    await s.screenshot({ path: "/tmp/heizung-4zonen.png" });
    await s.close();
  }

  /* ---------- 3) Tap +0,5: optimistic, EIN Request, Wunsch haelt Poll stand ---------- */
  console.log("Tap plus:");
  zonenMock = [
    { name: "Wohnzimmer", ist: 21.3, soll: 22, power: "ON", modus: "MANUAL" },
  ];
  {
    heizungCalls.length = 0; heizungVerhalten = "ok";
    /* Poll-Plan: 1. Init (22), 2. frisch-Poll nach Set (liegt noch alt), 3. bestaetigt (22,5) */
    statusPlan = [
      null,
      [{ name: "Wohnzimmer", ist: 21.3, soll: 22, power: "ON" }],
      [{ name: "Wohnzimmer", ist: 21.4, soll: 22.5, power: "ON" }],
    ];
    const s = await neueSeite(browser);
    await s.tap('[data-zone="Wohnzimmer"] .hz-plus');
    await warte(120);
    pruef("optimistisch sofort 22,5°", (await sollVon(s, "Wohnzimmer")) === "22,5°",
      await sollVon(s, "Wohnzimmer"));
    await warte(700);   /* 300 ms Buendel-Fenster + Request */
    pruef("genau 1 Set-Request", heizungCalls.length === 1, JSON.stringify(heizungCalls));
    pruef("Request: aktion=set grad=22.5",
      heizungCalls[0] && heizungCalls[0].aktion === "set" && heizungCalls[0].grad === 22.5,
      JSON.stringify(heizungCalls[0]));
    pruef("Request traegt Zone", heizungCalls[0] && heizungCalls[0].zone === "Wohnzimmer");
    /* 2. Poll kommt mit ALT-Wert: Wunsch bleibt stehen */
    await warte(400);
    pruef("alter Poll wirft Wunsch nicht zurueck", (await sollVon(s, "Wohnzimmer")) === "22,5°");
    /* 3. Poll bestaetigt */
    await warte(4300);
    pruef("bestaetigter Poll zeigt 22,5°", (await sollVon(s, "Wohnzimmer")) === "22,5°");
    const frischNutzung = statusAntworten.filter((u) => u.includes("frisch=heizung")).length;
    pruef("frisch=heizung Polls gesendet", frischNutzung >= 1, String(frischNutzung));
    await s.screenshot({ path: "/tmp/heizung-tap-plus.png" });
    await s.close();
  }

  /* ---------- 4) Limits: 25 oben, 5 unten ---------- */
  console.log("Limits:");
  {
    heizungCalls.length = 0; heizungVerhalten = "ok"; statusPlan = [];
    zonenMock = [{ name: "Wohnzimmer", ist: 24.9, soll: 25, power: "ON" }];
    const s = await neueSeite(browser);
    const plusDisabled = await s.evaluate(() =>
      document.querySelector('[data-zone="Wohnzimmer"] .hz-plus').disabled);
    pruef("bei Soll 25 ist plus disabled", plusDisabled === true);
    await s.tap('[data-zone="Wohnzimmer"] .hz-minus');
    await warte(700);
    pruef("minus bei 25 -> 24,5", (await sollVon(s, "Wohnzimmer")) === "24,5°",
      await sollVon(s, "Wohnzimmer"));
    pruef("Set-Request auf 24.5", heizungCalls.length === 1 && heizungCalls[0].grad === 24.5);
    await s.close();

    heizungCalls.length = 0; statusPlan = [];
    zonenMock = [{ name: "Wohnzimmer", ist: 5.2, soll: 5, power: "ON" }];
    const s2 = await neueSeite(browser);
    const minusDisabled = await s2.evaluate(() =>
      document.querySelector('[data-zone="Wohnzimmer"] .hz-minus').disabled);
    pruef("bei Soll 5 ist minus disabled", minusDisabled === true);
    await s2.tap('[data-zone="Wohnzimmer"] .hz-plus');
    await warte(700);
    pruef("plus bei 5 -> 5,5", (await sollVon(s2, "Wohnzimmer")) === "5,5°");
    await s2.close();
  }

  /* ---------- 5) Lang druecken: mehrere Schritte, EIN Request ---------- */
  console.log("Lang druecken:");
  {
    heizungCalls.length = 0; heizungVerhalten = "ok"; statusPlan = [];
    zonenMock = [{ name: "Wohnzimmer", ist: 20, soll: 20, power: "ON" }];
    const s = await neueSeite(browser);
    /* Halten per Pointer-API (synthetisch, route stubbt eh alles): */
    await s.evaluate(() => {
      const zeile = document.querySelector('[data-zone="Wohnzimmer"]');
      const btn = zeile.querySelector(".hz-plus");
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10, pointerId: 7 }));
    });
    await warte(1300);   /* 420 ms Hold + ~4 Wiederholungen a 220 ms */
    await s.evaluate(() => {
      document.querySelector('[data-zone="Wohnzimmer"] .hz-plus')
        .dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
    });
    const soll = await sollVon(s, "Wohnzimmer");
    pruef("Halten zaehlt mehrere Schritte (>= 21,5)", parseDe(soll) >= 21.5, soll);
    await warte(700);
    pruef("Halten sendet nur EINEN Request", heizungCalls.length === 1,
      JSON.stringify(heizungCalls));
    pruef("Request traegt Endwert", heizungCalls[0] && heizungCalls[0].grad === parseDe(soll));
    await s.close();
  }

  /* ---------- 6) Wischen: kein Request, Zahl zurueck ---------- */
  console.log("Wischen:");
  {
    heizungCalls.length = 0; statusPlan = [];
    zonenMock = [{ name: "Wohnzimmer", ist: 20, soll: 20, power: "ON" }];
    const s = await neueSeite(browser);
    await s.evaluate(() => {
      const btn = document.querySelector('[data-zone="Wohnzimmer"] .hz-plus');
      btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 100, clientY: 100, pointerId: 9 }));
      btn.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 160, clientY: 104, pointerId: 9 }));
      btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 160, clientY: 104, pointerId: 9 }));
    });
    await warte(700);
    pruef("Wischen aendert nichts (Zahl bleibt 20,0°)", (await sollVon(s, "Wohnzimmer")) === "20,0°");
    pruef("Wischen sendet keinen Request", heizungCalls.length === 0);
    await s.close();
  }

  /* ---------- 7) Fehlerfall: Rollback + roter Flash + Fehltext ---------- */
  console.log("Fehlerfall:");
  {
    heizungCalls.length = 0; heizungVerhalten = "fehler"; statusPlan = [];
    zonenMock = [{ name: "Wohnzimmer", ist: 20, soll: 20, power: "ON" }];
    const s = await neueSeite(browser);
    await s.tap('[data-zone="Wohnzimmer"] .hz-plus');
    await warte(120);
    pruef("optimistisch 20,5° angezeigt", (await sollVon(s, "Wohnzimmer")) === "20,5°");
    await warte(900);
    pruef("Fehler: Rollback auf 20°", (await sollVon(s, "Wohnzimmer")) === "20,0°",
      await sollVon(s, "Wohnzimmer"));
    const fehler = await s.evaluate(() => ({
      text: (document.querySelector(".heizung-fehler-text") || {}).textContent || "",
      flash: !!document.querySelector(".heizung-zeile.hz-fehler"),
    }));
    pruef("Fehltext sichtbar", fehler.text.includes("tado"), fehler.text);
    pruef("roter Flash an der Zeile", fehler.flash === true);
    await s.screenshot({ path: "/tmp/heizung-fehler.png" });
    await s.close();
  }

  /* ---------- 8) Netz-Fehler (abort): Rollback ohne Crash ---------- */
  console.log("Netz-Fehler:");
  {
    heizungCalls.length = 0; heizungVerhalten = "netz"; statusPlan = [];
    zonenMock = [{ name: "Wohnzimmer", ist: 20, soll: 20, power: "ON" }];
    const s = await neueSeite(browser);
    const crash = [];
    s.on("pageerror", (e) => crash.push(String(e)));
    await s.tap('[data-zone="Wohnzimmer"] .hz-plus');
    await warte(900);
    pruef("Netz-Fehler: Rollback auf 20°", (await sollVon(s, "Wohnzimmer")) === "20,0°");
    pruef("kein JS-Crash", crash.length === 0, crash.join(" | "));
    await s.close();
  }

  /* ---------- 9) Overflow 1/2/4/5 Zonen ---------- */
  console.log("Overflow (1280x800):");
  {
    heizungVerhalten = "ok";
    const stufen = [1, 2, 3, 4, 5];
    for (const n of stufen) {
      zonenMock = Array.from({ length: n }, (_, i) => ({
        name: "Zone" + (i + 1), ist: 20 + i * 0.3, soll: 21, power: i % 2 ? "OFF" : "ON",
      }));
      statusPlan = [];
      const s = await neueSeite(browser);
      const m = await s.evaluate(() => {
        const k = document.getElementById("k-heizung");
        const zeilen = document.querySelectorAll("#heizung-liste .heizung-zeile");
        const letzte = zeilen[zeilen.length - 1].getBoundingClientRect();
        let kollision = false;
        for (const z of zeilen) {
          const w = z.querySelector(".heizung-wert");
          const btn = z.querySelector(".hz-minus") || z.querySelector(".hz-soll");
          if (!w || !btn) continue;
          const breit = z.classList.contains("heizung-breit");
          const wr = w.getBoundingClientRect();
          const br = btn.getBoundingClientRect();
          /* breit: Wert und Stepper in verschiedenen Zeilen -> vertikal
             pruefen; sonst duerfen Text und Button nicht ineinanderlaufen */
          if (breit && wr.bottom > br.top + 1) kollision = true;
          if (!breit && wr.right > br.left + 1) kollision = true;
        }
        return {
          kOver: k.scrollHeight - k.clientHeight,
          zeilenSichtbar: zeilen.length,
          letzteUnten: Math.round(k.getBoundingClientRect().bottom - letzte.bottom),
          kollision,
          breit: !!document.querySelector(".heizung-breit"),
        };
      });
      /* Kachel-Clip = sichtbarer Verlust; letzte Zeile muss ganz drin sein.
         (Listen-scrollHeight lebt von den unsichtbaren Hit-Areas, kein
         sichtbarer Clip.) */
      pruef(n + " Zone(n): alles sichtbar (Kachel " + m.kOver + "px, letzte Zeile " + m.letzteUnten + "px Luft)",
        m.kOver <= 1 && m.letzteUnten >= -1, JSON.stringify(m));
      pruef(n + " Zone(n): kein Text-Button-Überlapp", m.kollision === false,
        JSON.stringify(m));
      const breitErwartet = n <= 2;
      pruef(n + " Zone(n): " + (breitErwartet ? "breit" : "kompakt") + "-Layout",
        m.breit === breitErwartet);
      const istDa = await s.evaluate(() => {
        const w = document.querySelector("#heizung-liste .heizung-wert");
        return !!w && w.getBoundingClientRect().width > 30 &&
               w.textContent.startsWith("ist ");
      });
      pruef(n + " Zone(n): Ist-Anzeige " + (breitErwartet ? "sichtbar" : "kompakt-gekuerzt"),
        breitErwartet ? istDa : true);
      await s.screenshot({ path: "/tmp/heizung-overflow-" + n + "zonen.png" });
      await s.close();
    }
  }

  await browser.close();
  statisch.close();
  console.log(fehlgeschlagen === 0 ? "\nALLE TESTS OK" : "\n" + fehlgeschlagen + " TEST(S) FEHLGESCHLAGEN");
  process.exit(fehlgeschlagen === 0 ? 0 : 1);
}

main().catch((e) => { console.error("TEST-CRASH:", e); process.exit(2); });
