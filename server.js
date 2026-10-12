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
});

module.exports = cds.server;
