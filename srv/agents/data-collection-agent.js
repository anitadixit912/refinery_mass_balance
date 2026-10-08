'use strict';

/**
 * Data Collection Agent  (Sub-agent 1 of 5)
 *
 * Role (slide 10 — Criteria 5: Role-orchestrated Coordination):
 *   "Pulls readings from SCADA, tank gauges, and LIMS at configured intervals"
 *
 * Data sources integrated (slide 9 — Criteria 3: Cross-Process Integration):
 *   • SAP IS-Oil & Gas     — nomination and scheduling data
 *   • SAP S/4HANA          — inventory movements and financial postings
 *   • LIMS                 — product quality and density (Lab Information Mgmt)
 *   • SCADA                — real-time meter readings and flow rates
 *   • Tank Gauge Systems   — volumetric measurements
 *   • EH&S / Regulatory    — compliance thresholds and reporting
 *
 * Five core data domains consumed (slide 14):
 *   TANK — Tank Master (IDs, capacities, material associations, density factors)
 *   MAT  — Material Data (MARA codes, UoM mapping, density, product hierarchy)
 *   MOV  — Movements (GR/GI documents, transfers, production confirmations)
 *   PHYS — Physical Inventory (dip gauge readings, temp, volume→MT conversion)
 *   BOOK — Book Stock (SAP MM ledger, batch-level, valuation class, period-end)
 *
 * SAP tables: MARA, MARC, MSEG, MARD, MKPF, MI01/MI07 (slide 14 footer)
 */

const { v4: uuidv4 } = require('uuid');

class DataCollectionAgent {

    constructor(db) {
        this.db = db;
    }

    /**
     * Main entry point — ingest all five data domains for the run period.
     * In production this calls SAP S/4HANA OData/RFC APIs, SCADA REST feeds,
     * and LIMS APIs. Here we simulate realistic refinery data.
     */
    async ingestData(run) {
        const results = await Promise.all([
            this._ingestTankReadings(run),
            this._ingestMaterialData(run),
            this._ingestMovements(run),
            this._ingestPhysicalInventory(run),
            this._ingestBookStock(run),
        ]);

        await this._auditIngest(run, results);
        return { domainsIngested: results.filter(r => r.success).length };
    }

    // ── TANK domain ────────────────────────────────────────────────────
    async _ingestTankReadings(run) {
        try {
            // Real implementation: query SCADA via OPC-UA or REST API
            // Simulated: verify tank master data is present for plant
            const tanks = await this.db.run(
                SELECT.from('refinery.massbalance.Tanks')
                    .where({ plant_ID: run.plant_ID, isActive: true })
            );
            await this._log(run, 'DataCollectionAgent', 'INGEST_TANK',
                `Tank master data loaded: ${tanks.length} active tanks`,
                'SCADA_TANK_GAUGE', 'SUCCESS');
            return { domain: 'TANK', count: tanks.length, success: true };
        } catch (err) {
            await this._log(run, 'DataCollectionAgent', 'INGEST_TANK',
                `Tank ingestion failed: ${err.message}`, 'SCADA_TANK_GAUGE', 'FAILURE');
            return { domain: 'TANK', count: 0, success: false, error: err.message };
        }
    }

    // ── MAT domain ─────────────────────────────────────────────────────
    async _ingestMaterialData(run) {
        try {
            // Real implementation: read MARA, MARC via SAP OData Material API
            const materials = await this.db.run(
                SELECT.from('refinery.massbalance.Materials').where({ isActive: true })
            );
            await this._log(run, 'DataCollectionAgent', 'INGEST_MAT',
                `Material master loaded: ${materials.length} active materials (MARA)`,
                'SAP_S4HANA', 'SUCCESS');
            return { domain: 'MAT', count: materials.length, success: true };
        } catch (err) {
            return { domain: 'MAT', count: 0, success: false, error: err.message };
        }
    }

    // ── MOV domain ─────────────────────────────────────────────────────
    async _ingestMovements(run) {
        try {
            // Real implementation: read MSEG/MKPF for the period via SAP BAPI or OData
            // Movement types: GR (101), GI (201/261), Transfer (311/312), Production (131)
            const existingMovements = await this.db.run(
                SELECT.from('refinery.massbalance.MaterialMovement')
                    .where({ run_ID: run.ID })
            );

            if (existingMovements.length === 0) {
                // Simulate movement ingestion for the period
                await this._simulateMovements(run);
            }

            const count = await this.db.run(
                SELECT.from('refinery.massbalance.MaterialMovement')
                    .where({ run_ID: run.ID })
                    .columns('count(*) as cnt')
            );

            await this._log(run, 'DataCollectionAgent', 'INGEST_MOV',
                `Movement documents ingested for period ${run.period}: ` +
                `${count[0]?.cnt || 0} records (MSEG/MKPF)`,
                'SAP_S4HANA', 'SUCCESS');
            return { domain: 'MOV', count: count[0]?.cnt || 0, success: true };
        } catch (err) {
            return { domain: 'MOV', count: 0, success: false, error: err.message };
        }
    }

    // ── PHYS domain ────────────────────────────────────────────────────
    async _ingestPhysicalInventory(run) {
        try {
            // Real implementation: read MI01/MI07 documents from SAP S/4HANA
            // and ATG (Automatic Tank Gauge) system feeds
            const existing = await this.db.run(
                SELECT.from('refinery.massbalance.PhysicalInventory')
                    .where({ run_ID: run.ID })
            );

            if (existing.length === 0) {
                await this._simulatePhysicalInventory(run);
            }

            await this._log(run, 'DataCollectionAgent', 'INGEST_PHYS',
                `Physical inventory readings ingested for period ${run.period} (MI01/MI07, ATG)`,
                'TANK_GAUGE_ATG', 'SUCCESS');
            return { domain: 'PHYS', success: true };
        } catch (err) {
            return { domain: 'PHYS', success: false, error: err.message };
        }
    }

    // ── BOOK domain ────────────────────────────────────────────────────
    async _ingestBookStock(run) {
        try {
            // Real implementation: read MARD (stock per storage location) and
            // MCHB (batch stocks) for the plant and period
            const existing = await this.db.run(
                SELECT.from('refinery.massbalance.BookStockSnapshot')
                    .where({ run_ID: run.ID })
            );

            if (existing.length === 0) {
                await this._simulateBookStock(run);
            }

            await this._log(run, 'DataCollectionAgent', 'INGEST_BOOK',
                `Book stock snapshots loaded: SAP MM ledger (MARD), ` +
                `batch quantities (MCHB), period-end balances`,
                'SAP_S4HANA', 'SUCCESS');
            return { domain: 'BOOK', success: true };
        } catch (err) {
            return { domain: 'BOOK', success: false, error: err.message };
        }
    }

    // ── Simulation helpers (replace with real API calls in production) ──

    async _simulateMovements(run) {
        const tanks = await this.db.run(
            SELECT.from('refinery.massbalance.Tanks')
                .where({ plant_ID: run.plant_ID, isActive: true })
        );
        const materials = await this.db.run(
            SELECT.from('refinery.massbalance.Materials').where({ isActive: true })
        );
        if (!tanks.length || !materials.length) return;

        const movCategories = ['GR','GI','TRANSFER','PRODUCTION','CONSUMPTION'];
        const entries = tanks.slice(0, 5).map((tank, i) => ({
            ID             : uuidv4(),
            run_ID         : run.ID,
            docNumber      : `49${String(i).padStart(7,'0')}`,
            lineItem       : '0001',
            material_ID    : materials[i % materials.length].ID,
            plant_ID       : run.plant_ID,
            tank_ID        : tank.ID,
            storageLocation: '0001',
            movementType   : ['101','201','311','131','261'][i % 5],
            movementCategory: movCategories[i % movCategories.length],
            postingDate    : run.period,
            quantity       : parseFloat((Math.random() * 5000 + 500).toFixed(3)),
            uom            : 'MT',
            quantityMT     : parseFloat((Math.random() * 5000 + 500).toFixed(3)),
        }));
        await this.db.run(INSERT.into('refinery.massbalance.MaterialMovement').entries(entries));
    }

    async _simulatePhysicalInventory(run) {
        const tanks = await this.db.run(
            SELECT.from('refinery.massbalance.Tanks')
                .where({ plant_ID: run.plant_ID, isActive: true })
        );
        const materials = await this.db.run(
            SELECT.from('refinery.massbalance.Materials').where({ isActive: true })
        );
        if (!tanks.length || !materials.length) return;

        const entries = tanks.slice(0, 5).map((tank, i) => {
            const dipReading = parseFloat((Math.random() * 3000 + 1000).toFixed(3));
            const density    = parseFloat((0.85 + Math.random() * 0.1).toFixed(6));
            const temp       = parseFloat((15 + Math.random() * 20).toFixed(2));
            return {
                ID             : uuidv4(),
                run_ID         : run.ID,
                docNumber      : `MI${String(i).padStart(8,'0')}`,
                docType        : 'MI07',
                tank_ID        : tank.ID,
                material_ID    : materials[i % materials.length].ID,
                plant_ID       : run.plant_ID,
                storageLocation: '0001',
                readingDate    : run.period,
                readingTime    : '08:00:00',
                source         : i % 2 === 0 ? 'ATG' : 'MANUAL',
                dipReading,
                temperature    : temp,
                density,
                apiGravity     : parseFloat((141.5 / (density + 131.5)).toFixed(2)),
                waterBottom    : parseFloat((dipReading * 0.005).toFixed(3)),
                quantityMT     : parseFloat(((dipReading - dipReading * 0.005) * density).toFixed(3)),
                quantityBBL    : parseFloat(((dipReading * density / 0.159).toFixed(3))),
                isFinalReading : true,
                isVerified     : false,
            };
        });
        await this.db.run(INSERT.into('refinery.massbalance.PhysicalInventory').entries(entries));
    }

    async _simulateBookStock(run) {
        const tanks = await this.db.run(
            SELECT.from('refinery.massbalance.Tanks')
                .where({ plant_ID: run.plant_ID, isActive: true })
        );
        const materials = await this.db.run(
            SELECT.from('refinery.massbalance.Materials').where({ isActive: true })
        );
        if (!tanks.length || !materials.length) return;

        const entries = tanks.slice(0, 5).map((tank, i) => {
            const unrestricted = parseFloat((Math.random() * 4000 + 800).toFixed(3));
            return {
                ID             : uuidv4(),
                run_ID         : run.ID,
                material_ID    : materials[i % materials.length].ID,
                plant_ID       : run.plant_ID,
                tank_ID        : tank.ID,
                storageLocation: '0001',
                snapshotDate   : run.period,
                snapshotTime   : '23:59:00',
                unrestricted,
                qualInspection : 0,
                blocked        : 0,
                inTransit      : parseFloat((Math.random() * 50).toFixed(3)),
                totalBook      : unrestricted,
                periodEndBalance: unrestricted,
                isPeriodClose  : run.periodType === 'MONTHLY',
            };
        });
        await this.db.run(INSERT.into('refinery.massbalance.BookStockSnapshot').entries(entries));
    }

    async _auditIngest(run, results) {
        const successful = results.filter(r => r.success).map(r => r.domain).join(', ');
        const failed     = results.filter(r => !r.success).map(r => r.domain).join(', ');
        await this._log(run, 'DataCollectionAgent', 'INGEST_COMPLETE',
            `Data ingestion complete. Domains OK: [${successful}]` +
            (failed ? ` | FAILED: [${failed}]` : ''),
            'MULTI_SOURCE', failed ? 'WARNING' : 'SUCCESS');
    }

    async _log(run, agentName, agentStep, action, dataSource, result) {
        try {
            await this.db.run(
                INSERT.into('refinery.massbalance.AuditLog').entries({
                    ID               : uuidv4(),
                    run_ID           : run.ID,
                    timestamp        : new Date().toISOString(),
                    agentName, agentStep, action, dataSource,
                    decisionRationale: action,
                    userId           : 'SYSTEM',
                    result,
                })
            );
        } catch { /* non-blocking */ }
    }
}

module.exports = DataCollectionAgent;
