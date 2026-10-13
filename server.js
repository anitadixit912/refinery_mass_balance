'use strict';
// Custom CAP server — cds-serve picks this up automatically.
// Registers startup hooks before CDS begins serving.

const cds = require('@sap/cds');

// Sync master data from S/4 HANA once the server is ready.
// Runs only when the local tables are empty (first boot or fresh DB).
cds.on('served', async () => {
    try {
        const db = await cds.connect.to('db');
        const DataCollectionAgent = require('./srv/agents/data-collection-agent');
        const agent = new DataCollectionAgent(db);
        await agent.syncMasterData();
    } catch (err) {
        console.warn('[Startup] Master data sync failed:', err.message);
    }

    // Expose app config to the frontend (non-sensitive values only).
    // S4H_WEBGUI_URL: base URL of the S/4 system reachable from the user's browser,
    // e.g. https://s4h-server:44300  (set via: cf set-env refinery-mass-balance S4H_WEBGUI_URL "https://...")
    // S4H_CLIENT: SAP client number, default 650.
    cds.app.get('/config', (_req, res) => {
        res.json({
            s4WebGuiUrl: process.env.S4H_WEBGUI_URL || '',
            s4Client   : process.env.S4H_CLIENT || '650',
        });
    });
});

module.exports = cds.server;
