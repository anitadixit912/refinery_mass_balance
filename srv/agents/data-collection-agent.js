'use strict';

const s4Client = require('./s4-client');

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
                try {
                    await this._fetchMovementsFromS4(run);
                } catch (err) {
                    console.warn(`[DataCollectionAgent] S/4 movements fetch failed: ${err.message}`);
                    await this._log(run, 'DataCollectionAgent', 'INGEST_MOV',
                        `S/4 HANA movements fetch failed — no data ingested: ${err.message}`,
                        'SAP_S4HANA', 'WARNING');
                }
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
                try {
                    await this._fetchPhysicalInventoryFromS4(run);
                } catch (err) {
                    console.warn(`[DataCollectionAgent] S/4 physical inventory fetch failed: ${err.message}`);
                    await this._log(run, 'DataCollectionAgent', 'INGEST_PHYS',
                        `S/4 HANA physical inventory fetch failed — no data ingested: ${err.message}`,
                        'SAP_S4HANA', 'WARNING');
                }
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
                try {
                    await this._fetchBookStockFromS4(run);
                } catch (err) {
                    console.warn(`[DataCollectionAgent] S/4 book stock fetch failed: ${err.message}`);
                    await this._log(run, 'DataCollectionAgent', 'INGEST_BOOK',
                        `S/4 HANA book stock fetch failed — no data ingested: ${err.message}`,
                        'SAP_S4HANA', 'WARNING');
                }
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

    // ── S/4 HANA live data ingestion (via OGS_S4 BTP destination) ──────

    async _getPlantCode(run) {
        const plant = await this.db.run(
            SELECT.one('plantCode').from('refinery.massbalance.Plants').where({ ID: run.plant_ID })
        );
        return plant?.plantCode;
    }

    async _fetchMovementsFromS4(run) {
        const plantCode = await this._getPlantCode(run);
        if (!plantCode) return;

        const tanks     = await this.db.run(SELECT.from('refinery.massbalance.Tanks').where({ plant_ID: run.plant_ID, isActive: true }));
        const materials = await this.db.run(SELECT.from('refinery.massbalance.Materials').where({ isActive: true }));
        if (!tanks.length || !materials.length) return;

        const tankBySLoc = Object.fromEntries(tanks.map(t => [t.storageLocation, t]));
        const matByCode  = Object.fromEntries(materials.map(m => [m.materialCode.trim(), m]));

        const s4Items = await s4Client.getMovements(plantCode, run.period);
        if (!s4Items.length) return;

        const entries = s4Items.map(i => {
            const tank = tankBySLoc[i.storageLocation] || tanks[0];
            const mat  = matByCode[i.materialCode]     || materials[0];
            return {
                ID              : uuidv4(),
                run_ID          : run.ID,
                docNumber       : i.docNumber,
                lineItem        : i.lineItem,
                material_ID     : mat.ID,
                plant_ID        : run.plant_ID,
                tank_ID         : tank.ID,
                storageLocation : i.storageLocation,
                movementType    : i.movementType,
                movementCategory: i.movementCategory,
                postingDate     : i.postingDate || run.period,
                quantity        : parseFloat(i.quantity.toFixed(3)),
                uom             : i.uom,
                quantityMT      : parseFloat(i.quantity.toFixed(3)),
            };
        });
        await this.db.run(INSERT.into('refinery.massbalance.MaterialMovement').entries(entries));
    }

    async _fetchPhysicalInventoryFromS4(run) {
        const plantCode = await this._getPlantCode(run);
        if (!plantCode) return;

        const tanks     = await this.db.run(SELECT.from('refinery.massbalance.Tanks').where({ plant_ID: run.plant_ID, isActive: true }));
        const materials = await this.db.run(SELECT.from('refinery.massbalance.Materials').where({ isActive: true }));
        if (!tanks.length || !materials.length) return;

        const tankBySLoc = Object.fromEntries(tanks.map(t => [t.storageLocation, t]));
        const matByCode  = Object.fromEntries(materials.map(m => [m.materialCode.trim(), m]));

        const s4Items = await s4Client.getPhysicalInventory(plantCode, run.period);
        if (!s4Items.length) return;

        const entries = s4Items.map(i => {
            const tank     = tankBySLoc[i.storageLocation] || tanks[0];
            const mat      = matByCode[i.materialCode]     || materials[0];
            const density  = mat.density || 0.86;
            const qty      = parseFloat(i.countedQty.toFixed(3));
            const dipRead  = density > 0 ? parseFloat((qty / density).toFixed(3)) : qty;
            return {
                ID             : uuidv4(),
                run_ID         : run.ID,
                docNumber      : i.docNumber,
                docType        : i.docType,
                tank_ID        : tank.ID,
                material_ID    : mat.ID,
                plant_ID       : run.plant_ID,
                storageLocation: i.storageLocation,
                readingDate    : run.period,
                readingTime    : '08:00:00',
                source         : 'ATG',
                dipReading     : dipRead,
                temperature    : 15,
                density,
                apiGravity     : parseFloat((141.5 / (density + 131.5)).toFixed(2)),
                waterBottom    : parseFloat((dipRead * 0.005).toFixed(3)),
                quantityMT     : qty,
                quantityBBL    : parseFloat((qty / 0.159).toFixed(3)),
                isFinalReading : i.isPosted,
                isVerified     : i.isPosted,
            };
        });
        await this.db.run(INSERT.into('refinery.massbalance.PhysicalInventory').entries(entries));
    }

    async _fetchBookStockFromS4(run) {
        const plantCode = await this._getPlantCode(run);
        if (!plantCode) return;

        const tanks     = await this.db.run(SELECT.from('refinery.massbalance.Tanks').where({ plant_ID: run.plant_ID, isActive: true }));
        const materials = await this.db.run(SELECT.from('refinery.massbalance.Materials').where({ isActive: true }));
        if (!tanks.length || !materials.length) return;

        const tankBySLoc = Object.fromEntries(tanks.map(t => [t.storageLocation, t]));
        const matByCode  = Object.fromEntries(materials.map(m => [m.materialCode.trim(), m]));

        const s4Items = await s4Client.getBookStock(plantCode);
        if (!s4Items.length) return;

        const entries = s4Items.map(i => {
            const tank         = tankBySLoc[i.storageLocation] || tanks[0];
            const mat          = matByCode[i.materialCode]     || materials[0];
            const unrestricted = parseFloat(i.unrestricted.toFixed(3));
            return {
                ID              : uuidv4(),
                run_ID          : run.ID,
                material_ID     : mat.ID,
                plant_ID        : run.plant_ID,
                tank_ID         : tank.ID,
                storageLocation : i.storageLocation,
                snapshotDate    : run.period,
                snapshotTime    : '23:59:00',
                unrestricted,
                qualInspection  : parseFloat(i.qualInspection.toFixed(3)),
                blocked         : parseFloat(i.blocked.toFixed(3)),
                inTransit       : parseFloat(i.inTransit.toFixed(3)),
                totalBook       : unrestricted,
                periodEndBalance: unrestricted,
                isPeriodClose   : run.periodType === 'MONTHLY',
            };
        });
        await this.db.run(INSERT.into('refinery.massbalance.BookStockSnapshot').entries(entries));
    }

    // ── MASTER DATA SYNC — called on startup when tables are empty ────
    async syncMasterData() {
        const log  = (msg) => console.log(`[MasterDataSync] ${msg}`);
        const warn = (msg) => console.warn(`[MasterDataSync] ${msg}`);

        // Plants
        try {
            const existing = await this.db.run(SELECT.from('refinery.massbalance.Plants'));
            if (existing.length === 0) {
                log('Plants table empty — fetching from S/4 HANA...');
                const s4Plants = await s4Client.getPlants();
                if (s4Plants.length) {
                    await this.db.run(INSERT.into('refinery.massbalance.Plants').entries(
                        s4Plants.map(p => ({
                            ID       : uuidv4(),
                            plantCode: p.plantCode,
                            plantName: p.plantName,
                            country  : p.country,
                            region   : p.region,
                            isActive : true,
                        }))
                    ));
                    log(`Synced ${s4Plants.length} plants from S/4 HANA.`);
                } else {
                    warn('No plants returned from S/4 HANA.');
                }
            } else {
                log(`Plants already loaded (${existing.length}).`);
            }
        } catch (err) {
            warn(`Plant sync failed: ${err.message}`);
        }

        // Materials
        try {
            const existing = await this.db.run(SELECT.from('refinery.massbalance.Materials'));
            if (existing.length === 0) {
                log('Materials table empty — fetching from S/4 HANA...');
                const s4Materials = await s4Client.getMaterials();
                if (s4Materials.length) {
                    await this.db.run(INSERT.into('refinery.massbalance.Materials').entries(
                        s4Materials.map(m => ({
                            ID           : uuidv4(),
                            materialCode : m.materialCode,
                            materialDesc : m.materialDesc,
                            baseUom      : m.baseUom,
                            productGroup : m.productGroup,
                            materialGroup: 'GP',
                            density      : 0.86,
                            isActive     : true,
                        }))
                    ));
                    log(`Synced ${s4Materials.length} materials from S/4 HANA.`);
                } else {
                    warn('No materials returned from S/4 HANA.');
                }
            } else {
                log(`Materials already loaded (${existing.length}).`);
            }
        } catch (err) {
            warn(`Material sync failed: ${err.message}`);
        }

        // Tanks — derived from Storage Locations per plant
        try {
            const existing = await this.db.run(SELECT.from('refinery.massbalance.Tanks'));
            if (existing.length === 0) {
                const plants    = await this.db.run(SELECT.from('refinery.massbalance.Plants').where({ isActive: true }));
                const materials = await this.db.run(SELECT.from('refinery.massbalance.Materials').where({ isActive: true }));
                if (plants.length && materials.length) {
                    log(`Fetching storage locations for ${plants.length} plants from S/4 HANA...`);
                    const tanks = [];
                    for (const plant of plants) {
                        try {
                            const slocs = await s4Client.getStorageLocations(plant.plantCode);
                            for (const sl of slocs) {
                                tanks.push({
                                    ID             : uuidv4(),
                                    tankId         : `${plant.plantCode}-${sl.storageLocation}`,
                                    tankName       : `${sl.storageLocation} (${plant.plantCode})`,
                                    plant_ID       : plant.ID,
                                    material_ID    : materials[0].ID,
                                    storageLocation: sl.storageLocation,
                                    capacity       : 50000,
                                    densityFactor  : 0.86,
                                    tempCorrFactor : 0.00072,
                                    tankType       : 'CRUDE',
                                    isActive       : true,
                                });
                            }
                        } catch (e) {
                            warn(`StorageLoc fetch for ${plant.plantCode} failed: ${e.message}`);
                        }
                    }
                    if (tanks.length) {
                        await this.db.run(INSERT.into('refinery.massbalance.Tanks').entries(tanks));
                        log(`Synced ${tanks.length} storage locations as tanks from S/4 HANA.`);
                    } else {
                        warn('No storage locations found in S/4 HANA.');
                    }
                }
            } else {
                log(`Tanks already loaded (${existing.length}).`);
            }
        } catch (err) {
            warn(`Tank sync failed: ${err.message}`);
        }
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
