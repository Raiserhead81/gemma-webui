# gemma-webui

Display-Weboberfläche für gemma.gemivo.de, gebaut für Kays Amazon Echo Show 15
(Fire OS, 1920x1080, nur Browser). Zeigt Uhr, Datum, Gemma-Orb, den Zustand der
Gemma-Live-Brücke und die letzte Gemma-Antwort.

Kein Framework, keine CDN-Abhängigkeiten. Ton läuft absichtlich nicht hier
(Tablet spielt über Bluetooth auf der Soundbar ab).

## Dateien

- index.html, style.css, app.js: die Oberfläche
- config.example.js: Vorlage, auf dem Server als config.js anlegen
- config.js: enthält den App-Token, liegt aus gutem Grund nur auf dem Server
  und ist per .gitignore ausgeschlossen

## WebSocket-Format (Gemma-Live-Brücke, Port 8797)

Verbindung: wss://gemma.gemivo.de/gemma-live/ws?token=APP_TOKEN&device=NAME&version=X

Server sendet JSON-Objekte mit "typ": bereit, du, gemma, unterbrochen,
zug_ende, geraet, denkt, werkzeug, werkzeug_fertig, fehler, ende.
Die UI zeigt "gemma"-Texte als letzte Antwort und "denkt"/"werkzeug" als
Orb-Aktivität. Details: /opt/gemma-live/PROTOKOLL.md auf dem gemivo-Server.

Die UI verbindet sich absichtlich sparsam (Kurzzyklus mit Backoff), weil jede
Verbindung in der Brücke eine echte Gemini-Session öffnet.

## Letzte Antwort aus dem Verlauf

Zusätzlich pollt die UI /gemma-live/verlauf/<geraet>.json (read-only Alias auf
die Sitzungsdateien der Brücke, token-geschützt) und zeigt die letzte
assistant-Antwort des frischesten Geräts.

## Server-Setup (gemivo)

nginx vhost: /etc/nginx/sites-enabled/gemma.gemivo.de.conf
Webroot: /var/www/gemma
Zertifikat: certbot, /etc/letsencrypt/live/gemma.gemivo.de/
