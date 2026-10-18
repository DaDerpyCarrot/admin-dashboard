"use strict";
require("dotenv").config();
(async () => {
  try {
    const url = new URL(process.env.LEDGER_INGEST_URL || "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
      || url.pathname !== "/api/transactions/playfab-events") throw new Error();
    const key = process.env.LEDGER_INGEST_KEY;
    if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new Error();
    const { callPlayFab } = require("../services/playfab");
    // This command must be run explicitly by the operator. Never call it on
    // server startup; it writes only these two new PRIVATE configuration keys.
    await callPlayFab("/Admin/SetTitleInternalData", { Key: "RoadLedgerIngestUrl", Value: url.href });
    await callPlayFab("/Admin/SetTitleInternalData", { Key: "RoadLedgerIngestKey", Value: key });
    console.log("Configured RoadLedgerIngestUrl and RoadLedgerIngestKey in PRIVATE Title Internal Data. No secrets were printed.");
  } catch (_) { console.error("Ledger configuration failed. Check LEDGER_INGEST_URL, the 64-hex-character LEDGER_INGEST_KEY and your backend's existing PlayFab credentials. No secret values were printed."); process.exitCode = 1; }
})();
