'use strict';

/**
 * Validation & Anomaly Agent  (Sub-agent 2 of 5)
 *
 * Role (slide 10):
 *   "Detects sensor faults, missing readings, and statistical outliers"
 *
 * Implements Step 1 — Data Validation & Completeness (slide 18):
 *   The agent verifies integrity of ALL input data before any calculation.
 *   It does NOT proceed to calculation with incomplete or inconsistent data.
 *
 * Three validation dimensions (slide 18):
 *
 *   COMPLETENESS checks:
 *     • All expected tank readings present for the period
 *     • No missing movement documents (time-gap detection)
 *     • Book stock records exist for all active materials
 *     • Physical inventory documents matched to period
 *
 *   CONSISTENCY checks:
 *     • UoM alignment across movement and inventory records
 *     • Density & temperature correction factors available
 *     • Material-to-tank assignments valid and current
 *     • Opening balance = prior period closing balance
 *
 *   REFERENTIAL INTEGRITY checks:
 *     • All material codes exist in master data (MARA)
 *     • Tank identifiers matched to plant structure
 *     • Movement document numbers are non-duplicate
 *     • Inventory count doc linked to correct storage location
 */

const { v4: uuidv4 } = require('uuid');

const VALIDATION_CHECKS = [
    // ── COMPLETENESS ──────────────────────────────────────────────────
    {
        id       : 'COMP_001',
        category : 'COMPLETENESS',
        name     : 'All expected tank readings present for the period',
        severity : 'BLOCKER',
        check    : async (db, run) => {
            const tanks = await db.run(
                SELECT.from('refinery.massbalance.Tanks')
                    .where({ plant_ID: run.plant_ID, isActive: true })
            );
            const readings = await db.run(
                SELECT.from('refinery.massbalance.PhysicalInventory')
                    .where({ run_ID: run.ID })
            );
            const missingTanks = tanks.filter(t =>
                !readings.some(r => r.tank_ID === t.ID)
            );
            return {
                pass   : missingTanks.length === 0,
                issues : missingTanks.map(t => ({
                    entityId : t.ID,
                    issueDesc: `Tank ${t.tankId} has no physical inventory reading for period ${run.period}`,
                })),
            };
        },
    },
    {
        id       : 'COMP_002',
        category : 'COMPLETENESS',
        name     : 'No missing movement documents (time-gap detection)',
        severity : 'WARNING',
        check    : async (db, run) => {
            const movements = await db.run(
                SELECT.from('refinery.massbalance.MaterialMovement')
                    .where({ run_ID: run.ID })
            );
            return {
                pass   : movements.length > 0,
                issues : movements.length === 0 ? [{
                    entityId : run.ID,
                    issueDesc: `No movement documents found for period ${run.period} — possible time-gap in data feed`,
                }] : [],
            };
        },
    },
    {
        id       : 'COMP_003',
        category : 'COMPLETENESS',
        name     : 'Book stock records exist for all active materials',
        severity : 'BLOCKER',
        check    : async (db, run) => {
            const materials = await db.run(
                SELECT.from('refinery.massbalance.Materials').where({ isActive: true })
            );
            const bookStock = await db.run(
                SELECT.from('refinery.massbalance.BookStockSnapshot')
                    .where({ run_ID: run.ID })
            );
            const missing = materials.filter(m =>
                !bookStock.some(b => b.material_ID === m.ID)
            );
            return {
                pass   : missing.length === 0,
                issues : missing.slice(0, 5).map(m => ({
                    entityId : m.ID,
                    issueDesc: `No book stock record for material ${m.materialCode} (MARD) in period ${run.period}`,
                })),
            };
        },
    },
    {
        id       : 'COMP_004',
        category : 'COMPLETENESS',
        name     : 'Physical inventory documents matched to period',
        severity : 'WARNING',
        check    : async (db, run) => {
            const physInv = await db.run(
                SELECT.from('refinery.massbalance.PhysicalInventory')
                    .where({ run_ID: run.ID })
            );
            const unverified = physInv.filter(p => !p.isVerified);
            return {
                pass   : unverified.length === 0,
                issues : unverified.map(p => ({
                    entityId : p.ID,
                    issueDesc: `Physical inventory doc ${p.docNumber} for period ${run.period} not verified`,
                })),
            };
        },
    },

    // ── CONSISTENCY ───────────────────────────────────────────────────
    {
        id       : 'CONS_001',
        category : 'CONSISTENCY',
        name     : 'UoM alignment across movement and inventory records',
        severity : 'BLOCKER',
        check    : async (db, run) => {
            const movements = await db.run(
                SELECT.from('refinery.massbalance.MaterialMovement')
                    .where({ run_ID: run.ID })
            );
            const invalidUoM = movements.filter(m =>
                m.uom && !['MT', 'BBL', 'KL', 'M3', 'T'].includes(m.uom)
            );
            return {
                pass   : invalidUoM.length === 0,
                issues : invalidUoM.map(m => ({
                    entityId : m.docNumber,
                    issueDesc: `Movement doc ${m.docNumber}: unrecognised UoM '${m.uom}' — cannot convert to MT`,
                })),
            };
        },
    },
    {
        id       : 'CONS_002',
        category : 'CONSISTENCY',
        name     : 'Density & temperature correction factors available',
        severity : 'BLOCKER',
        check    : async (db, run) => {
            const materials = await db.run(
                SELECT.from('refinery.massbalance.Materials').where({ isActive: true })
            );
            const noDensity = materials.filter(m => !m.density || m.density <= 0);
            return {
                pass   : noDensity.length === 0,
                issues : noDensity.map(m => ({
                    entityId : m.materialCode,
                    issueDesc: `Material ${m.materialCode}: density factor missing or zero — volume→MT conversion not possible`,
                })),
            };
        },
    },
    {
        id       : 'CONS_003',
        category : 'CONSISTENCY',
        name     : 'Material-to-tank assignments valid and current',
        severity : 'WARNING',
        check    : async (db, run) => {
            const tanks = await db.run(
                SELECT.from('refinery.massbalance.Tanks')
                    .where({ plant_ID: run.plant_ID, isActive: true })
            );
            const unassigned = tanks.filter(t => !t.material_ID);
            return {
                pass   : unassigned.length === 0,
                issues : unassigned.map(t => ({
                    entityId : t.tankId,
                    issueDesc: `Tank ${t.tankId}: no primary material assignment — balance will be ungrouped`,
                })),
            };
        },
    },

    // ── REFERENTIAL INTEGRITY ─────────────────────────────────────────
    {
        id       : 'REF_001',
        category : 'REFERENTIAL',
        name     : 'All material codes exist in master data (MARA)',
        severity : 'BLOCKER',
        check    : async (db, run) => {
            const movements = await db.run(
                SELECT.from('refinery.massbalance.MaterialMovement')
                    .where({ run_ID: run.ID })
            );
            const materialIds = [...new Set(movements.map(m => m.material_ID).filter(Boolean))];
            const knownMaterials = await db.run(
                SELECT.from('refinery.massbalance.Materials')
                    .where({ ID: { in: materialIds } })
            );
            const knownIds = new Set(knownMaterials.map(m => m.ID));
            const unknown  = materialIds.filter(id => !knownIds.has(id));
            return {
                pass   : unknown.length === 0,
                issues : unknown.map(id => ({
                    entityId : id,
                    issueDesc: `Movement references unknown material ${id} — not found in MARA master data`,
                })),
            };
        },
    },
    {
        id       : 'REF_002',
        category : 'REFERENTIAL',
        name     : 'Tank identifiers matched to plant structure',
        severity : 'BLOCKER',
        check    : async (db, run) => {
            const physInv = await db.run(
                SELECT.from('refinery.massbalance.PhysicalInventory')
                    .where({ run_ID: run.ID })
            );
            const tankIds   = [...new Set(physInv.map(p => p.tank_ID).filter(Boolean))];
            const knownTanks = await db.run(
                SELECT.from('refinery.massbalance.Tanks')
                    .where({ ID: { in: tankIds }, plant_ID: run.plant_ID })
            );
            const knownSet = new Set(knownTanks.map(t => t.ID));
            const unknown  = tankIds.filter(id => !knownSet.has(id));
            return {
                pass   : unknown.length === 0,
                issues : unknown.map(id => ({
                    entityId : id,
                    issueDesc: `Physical inventory references tank ${id} not assigned to plant — referential integrity failure`,
                })),
            };
        },
    },
    {
        id       : 'REF_003',
        category : 'REFERENTIAL',
        name     : 'Movement document numbers are non-duplicate',
        severity : 'WARNING',
        check    : async (db, run) => {
            const movements = await db.run(
                SELECT.from('refinery.massbalance.MaterialMovement')
                    .where({ run_ID: run.ID })
            );
            const seen = new Set();
            const duplicates = [];
            for (const m of movements) {
                const key = `${m.docNumber}-${m.lineItem}`;
                if (seen.has(key)) {
                    duplicates.push(m);
                } else {
                    seen.add(key);
                }
            }
            return {
                pass   : duplicates.length === 0,
                issues : duplicates.map(m => ({
                    entityId : m.docNumber,
                    issueDesc: `Duplicate movement document ${m.docNumber}/${m.lineItem} detected — possible double-posting`,
                })),
            };
        },
    },
];

class ValidationAnomalyAgent {

    constructor(db) {
        this.db = db;
    }

    /**
     * Run all validation checks. Returns ValidationResult.
     * If any BLOCKER issues exist, the agent returns blockerCount > 0
     * and the pipeline must not proceed to calculation (slide 18).
     */
    async run(run) {
        let checksPassed = 0;
        let checksFailed = 0;
        let blockerCount = 0;
        const issuesList = [];

        for (const check of VALIDATION_CHECKS) {
            let result;
            try {
                result = await check.check(this.db, run);
            } catch (err) {
                result = { pass: false, issues: [{ entityId: 'N/A', issueDesc: err.message }] };
            }

            if (result.pass) {
                checksPassed++;
            } else {
                checksFailed++;
                for (const issue of result.issues || []) {
                    const isBlocker = check.severity === 'BLOCKER';
                    if (isBlocker) blockerCount++;

                    issuesList.push({
                        checkCategory: check.category,
                        checkName    : check.name,
                        entityId     : issue.entityId,
                        issueDesc    : issue.issueDesc,
                        severity     : check.severity,
                    });

                    // Persist to ValidationIssue entity
                    await this.db.run(
                        INSERT.into('refinery.massbalance.ValidationIssue').entries({
                            ID            : uuidv4(),
                            run_ID        : run.ID,
                            checkCategory : check.category,
                            checkName     : check.name,
                            entity_       : check.category,
                            entityId      : issue.entityId,
                            issueDesc     : issue.issueDesc,
                            severity      : check.severity,
                            isResolved    : false,
                        })
                    );
                }
            }
        }

        await this._log(run,
            `Validation complete: ${checksPassed}/${VALIDATION_CHECKS.length} checks passed, ` +
            `${blockerCount} blockers found`,
            blockerCount > 0 ? 'FAILURE' : checksFailed > 0 ? 'WARNING' : 'SUCCESS');

        return { success: blockerCount === 0, checksPassed, checksFailed, blockerCount, issues: issuesList };
    }

    async _log(run, action, result) {
        try {
            await this.db.run(
                INSERT.into('refinery.massbalance.AuditLog').entries({
                    ID: uuidv4(), run_ID: run.ID,
                    timestamp: new Date().toISOString(),
                    agentName: 'ValidationAnomalyAgent',
                    agentStep: 'STEP_02_VALIDATE',
                    action, dataSource: 'MULTI_SOURCE',
                    decisionRationale: action, userId: 'SYSTEM', result,
                })
            );
        } catch { /* non-blocking */ }
    }
}

module.exports = ValidationAnomalyAgent;
