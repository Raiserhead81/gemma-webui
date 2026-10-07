/* Vorlage: auf dem Server als config.js anlegen (ist in .gitignore).
   Token = App-Token der Gemma-Live-Brücke (/opt/alexa-hermes/app-token).
   geraete = Geräte-IDs, deren Gesprächsverlauf das Display zeigt. */

window.GEMMA_CONFIG = {
  token: "APP_TOKEN_HIER",
  geraete: [
    "g-XXXXXXXXXXXXXXXXXXXXXX"
  ],
  verlaufSek: 20,
  wsZyklusSek: 60,
  wsBackoffStartSek: 45,
  wsBackoffMaxSek: 360,
  version: "webui-1.0"
};
