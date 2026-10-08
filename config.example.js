/* Vorlage: auf dem Server als config.js anlegen (ist in .gitignore).
   Token = App-Token der Gemma-Live-Brücke (/opt/alexa-hermes/app-token).
   geraete = Geräte-IDs, deren Gesprächsverlauf das Display zeigt.
   zeige_gespraech: true = Gesprächs-Kachel (Verlauf du/gemma) wieder
   sichtbar; false oder Feld weglassen = Kachel bleibt weg (Standard). */

window.GEMMA_CONFIG = {
  token: "APP_TOKEN_HIER",
  geraete: [
    "g-XXXXXXXXXXXXXXXXXXXXXX"
  ],
  zeige_gespraech: true,
  verlaufSek: 20,
  wsZyklusSek: 60,
  wsBackoffStartSek: 45,
  wsBackoffMaxSek: 360,
  version: "webui-1.0"
};
