'use strict';

/**
 * Exception Management Agent  (Sub-agent 4 of 5)
 *
 * Role (slide 10):
 *   "Investigates flagged variances and escalates to humans when needed"
 *
 * Implements Steps 7 & 8 of the agentic process (slides 16 & 22):
 *
 * Step 7 — Investigation Approach (slide 22):
 *   1. Isolate variance period — identify exact date/time window of imbalance
 *   2. Drill into movements    — review all MSEG/MKPF docs for flagged material+plant
 *   3. Cross-check physical    — validate dip readings against gauge charts & temp logs
 *   4. Verify meter data       — compare pipeline meter totals vs booked transfer quantities
 *   5. Check master data       — confirm density, conversion factors, UoM settings are current
 *
 * Step 8 — Root Cause Categories (slide 22):
 *   MC — Measurement Error   : gauge calibration, dip error, temperature correction omitted
 *   TX — Transaction Error   : wrong quantity, UoM, date, or document type posted in SAP
 *   MD — Master Data Issue   : density factor wrong, tank capacity outdated, UoM mismatch
 *   TF — Transfer/Routing    : goods in transit, pipeline lag, inter-company delay
 *   PL — Physical Loss/Gain  : evaporation, water bottom, line fill, legitimate process variance
 *   SY — System/Interface    : IDoc failure, batch job error, integration gap, timing issue
 *
 * Exception Report structure (slide 23):
 *   exceptionId, period, plant/tank/material, variance (MT/%), severity,
 *   root cause category + narrative, supporting docs, recommendation, status
 *
 * Typical exceptions requiring judgment (Criterion 4 — slide 9):
 *   • UAL exceeding regulatory thresholds — cause vs measurement error
 *   • Conflicting volumetric vs mass readings — which source to trust
 *   • Missing meter data during maintenance windows — substitution/interpolation
 *   • Off-spec product events — flag, quarantine, adjust balances
 *   • Multi-unit reconciliation failures — trace root cause across process units
 */

const { v4: uuidv4 } = require('uuid');

// Root cause classification heuristics mapped to the 6 categories (slide 22)
const ROOT_CAUSE_HEURISTICS = [
    {
        category : 'MC',
        label    : 'Measurement Error',
        conditions: [
            { signal: 'temperature', desc: 'Temperature deviation >5°C from baseline — possible dip error or temperature correction omitted' },
            { signal: 'density_mismatch', desc: 'Density value deviates >2% from material master — gauge calibration suspect' },
        ],
        recommendation: 'Verify gauge calibration records. Re-measure with calibrated equipment. Apply API MPMS correction factors.',
    },
    {
        category : 'TX',
        label    : 'Transaction Error',
        conditions: [
            { signal: 'duplicate_doc', desc: 'Duplicate movement document detected — possible double-posting in SAP' },
            { signal: 'uom_mismatch', desc: 'UoM inconsistency between movement type and material master — wrong document type posted' },
        ],
        recommendation: 'Review MSEG/MKPF documents for the period. Reverse incorrect postings and re-post with correct data after approval.',
    },
    {
        category : 'MD',
        label    : 'Master Data Issue',
        conditions: [
            { signal: 'no_density', desc: 'Material density factor missing or outdated in MARA — volume→MT conversion unreliable' },
            { signal: 'tank_capacity', desc: 'Physical reading exceeds recorded tank capacity — tank capacity master data may be outdated' },
        ],
        recommendation: 'Update material master density (MARA), tank capacity and correction factors. Re-run balance after master data correction.',
    },
    {
        category : 'TF',
        label    : 'Transfer / Routing',
        conditions: [
            { signal: 'pipeline_lag', desc: 'Transfer quantity booked but physical not yet received — goods in transit or pipeline lag' },
            { signal: 'intercompany', desc: 'Intercompany movement not confirmed on receiving plant — timing difference' },
        ],
        recommendation: 'Confirm in-transit quantities with logistics team. Apply goods-in-transit adjustment. Re-reconcile after pipeline confirmation.',
    },
    {
        category : 'PL',
        label    : 'Physical Loss / Gain',
        conditions: [
            { signal: 'small_negative', desc: 'Small consistent negative variance — likely evaporation loss, line fill or water bottom' },
            { signal: 'small_positive', desc: 'Small positive variance — possible thermal expansion or measurement rounding' },
        ],
        recommendation: 'Validate against allowable evaporation/breathing loss tables. If within API standards, classify as legitimate process variance and close with note.',
    },
    {
        category : 'SY',
        label    : 'System / Interface',
        conditions: [
            { signal: 'idoc_failure', desc: 'IDoc or batch job failure detected — SAP interface did not complete successfully' },
            { signal: 'timing_gap', desc: 'Timestamp gap in movement stream — batch job or interface timing issue' },
        ],
        recommendation: 'Check IDoc monitor (BD87), batch job logs, and integration middleware. Re-trigger failed messages. Verify data completeness after re-processing.',
    },
];

class ExceptionManagementAgent {

    constructor(db) {
        this.db = db;
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 7 — Investigate flagged variances
    // ─────────────────────────────────────────────────────────────────
    async investigate(run) {
        const flaggedLines = await this.db.run(
            SELECT.from('refinery.massbalance.MassBalanceLine')
                .where({ run_ID: run.ID })
                .and('severity != \'INFO\'')
        );

        let count = 0;

        for (const line of flaggedLines) {
            const investigation = await this._drillDown(run, line);

            // Create exception record (slide 23 structure)
            const excNumber = String(count + 1).padStart(4, '0');
            const period    = run.period.replace(/-/g, '');
            const exceptionId = `EXC-${period.substring(0,6)}-${excNumber}`;

            await this.db.run(
                INSERT.into('refinery.massbalance.Exception').entries({
                    ID                 : uuidv4(),
                    exceptionId,
                    run_ID             : run.ID,
                    balanceLine_ID     : line.ID,
                    plant_ID           : line.plant_ID,
                    tank_ID            : line.tank_ID,
                    material_ID        : line.material_ID,
                    period             : run.period,
                    periodType         : run.periodType,
                    varianceMT         : line.variance,
                    variancePct        : line.variancePct,
                    varianceSign       : (line.variance || 0) >= 0 ? 'EXCESS' : 'SHORTAGE',
                    severity           : line.severity,
                    rootCauseCategory  : null,   // filled in classifyRootCauses
                    rootCauseNarrative : null,
                    recommendation     : null,
                    investigationLog   : investigation.log,
                    supportingDocs     : investigation.supportingDocs,
                    relatedMovements   : investigation.relatedMovements,
                    status             : 'OPEN',
                })
            );
            count++;
        }

        await this._log(run, 'STEP_07_INVESTIGATE',
            `Investigation complete: ${count} exceptions created for flagged variances`,
            'SUCCESS');

        return { exceptionsInvestigated: count };
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 8 — Classify Root Causes
    // ─────────────────────────────────────────────────────────────────
    async classifyRootCauses(run) {
        const openExceptions = await this.db.run(
            SELECT.from('refinery.massbalance.Exception')
                .where({ run_ID: run.ID, status: 'OPEN' })
        );

        let classified = 0;
        const categoryCounts = {};

        for (const exc of openExceptions) {
            const line = exc.balanceLine_ID
                ? await this.db.run(
                    SELECT.one.from('refinery.massbalance.MassBalanceLine')
                        .where({ ID: exc.balanceLine_ID })
                  )
                : null;

            const { category, narrative, recommendation } = this._classifyRootCause(exc, line);

            await this.db.run(
                UPDATE('refinery.massbalance.Exception').where({ ID: exc.ID }).set({
                    rootCauseCategory : category,
                    rootCauseNarrative: narrative,
                    recommendation,
                    status            : 'UNDER_REVIEW',
                })
            );

            categoryCounts[category] = (categoryCounts[category] || 0) + 1;
            classified++;
        }

        const rootCauseSummary = Object.entries(categoryCounts).map(([category, count]) => ({
            category, count,
        }));

        await this._log(run, 'STEP_08_CLASSIFY',
            `Root cause classification: ${classified} exceptions classified. ` +
            `Summary: ${JSON.stringify(categoryCounts)}`,
            'SUCCESS');

        return {
            classified,
            pendingClassification: openExceptions.length - classified,
            rootCauseSummary,
            message: `${classified} root causes classified`,
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  INVESTIGATION DRILL-DOWN (5 steps from slide 22)
    // ─────────────────────────────────────────────────────────────────
    async _drillDown(run, line) {
        const log  = [];
        const docs = [];

        // Step 1: Isolate variance period
        log.push(`[1] Variance period isolated: ${run.period}, variance=${line.variance} MT (${line.variancePct}%)`);

        // Step 2: Drill into movements (MSEG/MKPF)
        const movements = await this.db.run(
            SELECT.from('refinery.massbalance.MaterialMovement')
                .where({ run_ID: run.ID, tank_ID: line.tank_ID, material_ID: line.material_ID })
        );
        movements.forEach(m => docs.push(m.docNumber));
        log.push(`[2] Reviewed ${movements.length} movement documents (MSEG/MKPF): ${docs.join(', ') || 'none'}`);

        // Step 3: Cross-check physical data
        const physInv = await this.db.run(
            SELECT.one.from('refinery.massbalance.PhysicalInventory')
                .where({ run_ID: run.ID, tank_ID: line.tank_ID })
        );
        if (physInv) {
            log.push(`[3] Physical reading validated: dip=${physInv.dipReading}, temp=${physInv.temperature}°C, ` +
                `density=${physInv.density} kg/L, waterBottom=${physInv.waterBottom} MT, ` +
                `source=${physInv.source}`);
            if (physInv.docNumber) docs.push(physInv.docNumber);
        } else {
            log.push('[3] No physical inventory reading found for this tank/period — completeness issue');
        }

        // Step 4: Verify meter data
        const pipelineMovements = movements.filter(m => m.movementCategory === 'PIPELINE');
        log.push(`[4] Pipeline meter verification: ${pipelineMovements.length} pipeline movements reviewed. ` +
            `Total metered: ${pipelineMovements.reduce((s, m) => s + (m.quantityMT || 0), 0).toFixed(3)} MT`);

        // Step 5: Check master data
        const material = line.material_ID
            ? await this.db.run(
                SELECT.one.from('refinery.massbalance.Materials').where({ ID: line.material_ID })
              )
            : null;
        log.push(`[5] Master data check: material density=${material?.density ?? 'N/A'}, ` +
            `UoM=${material?.baseUom ?? 'N/A'}, productGroup=${material?.productGroup ?? 'N/A'}`);

        return {
            log              : log.join('\n'),
            supportingDocs   : docs.join(', '),
            relatedMovements : movements.map(m => m.docNumber).join(', '),
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  ROOT CAUSE CLASSIFICATION HEURISTICS
    // ─────────────────────────────────────────────────────────────────
    _classifyRootCause(exception, line) {
        const absVariancePct = Math.abs(exception.variancePct || 0);
        const absVarianceMT  = Math.abs(exception.varianceMT  || 0);

        // Heuristic rules (ordered by specificity)
        if (line?.isDuplicate) {
            return this._buildResult('TX', 'Duplicate movement document detected — likely double-posting in SAP');
        }
        if (line && (line.density <= 0 || !line.density)) {
            return this._buildResult('MD', 'Material density factor missing — volume→MT conversion unreliable');
        }
        if (absVariancePct > 0 && absVariancePct < 0.1 && absVarianceMT < 50) {
            return this._buildResult('PL', `Small variance ${absVariancePct.toFixed(4)}% — consistent with evaporation, breathing loss or water bottom deduction`);
        }
        if (exception.varianceSign === 'EXCESS' && absVariancePct > 0.1) {
            return this._buildResult('TF', 'Physical excess detected — goods in transit not yet booked or pipeline lag');
        }
        if (exception.varianceSign === 'SHORTAGE' && absVariancePct > 0.5) {
            return this._buildResult('MC', `Significant shortage ${absVariancePct.toFixed(4)}% — measurement error or calibration drift suspected`);
        }
        if (exception.severity === 'CRITICAL') {
            return this._buildResult('SY', 'CRITICAL variance — possible IDoc failure, batch job error or interface gap causing data loss');
        }
        // Default
        return this._buildResult('PL', `Variance of ${exception.varianceMT} MT — classified as potential physical loss/gain pending further investigation`);
    }

    _buildResult(category, narrative) {
        const heuristic = ROOT_CAUSE_HEURISTICS.find(h => h.category === category);
        return {
            category,
            narrative,
            recommendation: heuristic?.recommendation ||
                'Review transaction details with operations team and submit corrective action for approval.',
        };
    }

    async _log(run, agentStep, action, result) {
        try {
            await this.db.run(
                INSERT.into('refinery.massbalance.AuditLog').entries({
                    ID: uuidv4(), run_ID: run.ID,
                    timestamp: new Date().toISOString(),
                    agentName: 'ExceptionManagementAgent',
                    agentStep, action, dataSource: 'SAP_S4HANA',
                    decisionRationale: action, userId: 'SYSTEM', result,
                })
            );
        } catch { /* non-blocking */ }
    }
}

module.exports = ExceptionManagementAgent;
