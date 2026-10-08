'use strict';

const { v4: uuidv4 } = require('uuid');
const llm = require('./llm-client');

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
    //  STEP 8 — Classify Root Causes  (LLM-powered, heuristic fallback)
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

            const material = line?.material_ID
                ? await this.db.run(SELECT.one.from('refinery.massbalance.Materials').where({ ID: line.material_ID }))
                : null;

            const tank = line?.tank_ID
                ? await this.db.run(SELECT.one.from('refinery.massbalance.Tanks').where({ ID: line.tank_ID }))
                : null;

            // Try LLM first, fall back to heuristics
            let result = await this._classifyRootCauseWithLLM(exc, line, material, tank);
            if (!result) result = this._classifyRootCauseHeuristic(exc, line);

            await this.db.run(
                UPDATE('refinery.massbalance.Exception').where({ ID: exc.ID }).set({
                    rootCauseCategory : result.category,
                    rootCauseNarrative: result.narrative,
                    recommendation    : result.recommendation,
                    status            : 'UNDER_REVIEW',
                })
            );

            categoryCounts[result.category] = (categoryCounts[result.category] || 0) + 1;
            classified++;
        }

        const rootCauseSummary = Object.entries(categoryCounts)
            .map(([category, count]) => ({ category, count }));

        await this._log(run, 'STEP_08_CLASSIFY',
            `Root cause classification (${llm.provider} AI): ${classified} exceptions. ` +
            `Summary: ${JSON.stringify(categoryCounts)}`,
            'SUCCESS');

        return {
            classified,
            pendingClassification: openExceptions.length - classified,
            rootCauseSummary,
            message: `${classified} root causes classified by ${llm.provider === 'none' ? 'heuristic rules' : llm.provider + ' AI'}`,
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  LLM ROOT CAUSE CLASSIFICATION
    // ─────────────────────────────────────────────────────────────────
    async _classifyRootCauseWithLLM(exc, line, material, tank) {
        const systemPrompt =
`You are a senior refinery operations engineer and SAP mass balance specialist.
Analyse the variance exception and classify its root cause.

Return ONLY valid JSON — no markdown, no explanation outside the JSON:
{
  "category": "<MC|TX|MD|TF|PL|SY>",
  "narrative": "<2–3 sentences explaining the most likely root cause>",
  "recommendation": "<1–2 sentences on the corrective action required>"
}

Categories:
MC = Measurement/Calibration Error (gauge drift, dip errors, temperature correction omitted)
TX = Transaction Error (wrong posting, duplicate document, UoM mismatch in SAP)
MD = Master Data Issue (density wrong, tank capacity outdated, conversion factor error)
TF = Transfer/Routing (goods in transit, pipeline lag, intercompany timing)
PL = Physical Loss/Gain (evaporation, water bottom, line fill, legitimate process variance)
SY = System/Interface (IDoc failure, batch job error, integration gap, timing issue)`;

        const userPrompt =
`Exception:
  Material : ${material?.materialDesc || 'Unknown'} (${material?.materialCode || '?'}, group=${material?.productGroup || '?'})
  Tank     : ${tank?.tankId || '?'} type=${tank?.tankType || '?'}
  Period   : ${exc.period}
  Variance : ${exc.varianceMT} MT  (${exc.variancePct}%)
  Direction: ${exc.varianceSign}   (${exc.varianceSign === 'EXCESS' ? 'Physical > Book stock' : 'Physical < Book stock'})
  Severity : ${exc.severity}

Balance figures (MT):
  Opening          : ${line?.openingStock   ?? 'N/A'}
  Receipts (GR)    : ${line?.receipts       ?? 0}
  Issues (GI)      : ${line?.issues         ?? 0}
  Transfers        : ${line?.transfers      ?? 0}
  Production yield : ${line?.production     ?? 0}
  Consumption      : ${line?.consumption    ?? 0}
  Closing Book     : ${line?.closingBook    ?? 'N/A'}
  Closing Physical : ${line?.closingPhysical ?? 'N/A'}

Investigation log:
${exc.investigationLog || 'Not available'}

Classify the root cause.`;

        const text = await llm.complete(systemPrompt, userPrompt, 600);
        return llm.parseJSON(text);
    }

    // ─────────────────────────────────────────────────────────────────
    //  LLM-ENHANCED INVESTIGATION DRILL-DOWN
    // ─────────────────────────────────────────────────────────────────
    async _drillDown(run, line) {
        const docs = [];

        // Gather raw facts first
        const movements = await this.db.run(
            SELECT.from('refinery.massbalance.MaterialMovement')
                .where({ run_ID: run.ID, tank_ID: line.tank_ID, material_ID: line.material_ID })
        );
        movements.forEach(m => { if (m.docNumber) docs.push(m.docNumber); });

        const physInv = await this.db.run(
            SELECT.one.from('refinery.massbalance.PhysicalInventory')
                .where({ run_ID: run.ID, tank_ID: line.tank_ID })
        );
        if (physInv?.docNumber) docs.push(physInv.docNumber);

        const material = line.material_ID
            ? await this.db.run(SELECT.one.from('refinery.massbalance.Materials').where({ ID: line.material_ID }))
            : null;

        const pipelineMovements = movements.filter(m => m.movementCategory === 'PIPELINE');

        // Try LLM for a rich investigation narrative
        const systemPrompt =
`You are a refinery mass balance investigator. Write a concise 5-step investigation log.
Format each step on its own line starting with [1], [2], [3], [4], [5].
Be specific and technical. Reference the actual numbers provided.`;

        const userPrompt =
`Investigate this variance:
  Period   : ${run.period}  (${run.periodType})
  Variance : ${line.variance} MT  (${line.variancePct}%)  ${line.variance >= 0 ? 'EXCESS' : 'SHORTAGE'}
  Opening  : ${line.openingStock} MT
  Receipts : ${line.receipts ?? 0} MT  Issues: ${line.issues ?? 0} MT
  Transfers: ${line.transfers ?? 0} MT  Production: ${line.production ?? 0} MT
  Closing Book: ${line.closingBook} MT  Closing Physical: ${line.closingPhysical} MT
  Movement docs found : ${movements.length}
  Physical inventory  : ${physInv ? `dip=${physInv.dipReading}, temp=${physInv.temperature}°C, density=${physInv.density} kg/L` : 'none'}
  Pipeline movements  : ${pipelineMovements.length} (${pipelineMovements.reduce((s, m) => s + (m.quantityMT || 0), 0).toFixed(3)} MT)
  Material density    : ${material?.density ?? 'N/A'} kg/L   UoM: ${material?.baseUom ?? 'N/A'}

Write the 5-step investigation log.`;

        let logText = await llm.complete(systemPrompt, userPrompt, 600);

        if (!logText) {
            // Heuristic fallback
            logText = [
                `[1] Variance period isolated: ${run.period}, variance=${line.variance} MT (${line.variancePct}%)`,
                `[2] Reviewed ${movements.length} movement docs (MSEG/MKPF): ${docs.join(', ') || 'none found'}`,
                physInv
                    ? `[3] Physical reading: dip=${physInv.dipReading}, temp=${physInv.temperature}°C, density=${physInv.density} kg/L, waterBottom=${physInv.waterBottom} MT`
                    : `[3] No physical inventory reading found for this tank/period — completeness gap`,
                `[4] Pipeline meter check: ${pipelineMovements.length} movements, total metered=${pipelineMovements.reduce((s, m) => s + (m.quantityMT || 0), 0).toFixed(3)} MT`,
                `[5] Master data: density=${material?.density ?? 'N/A'} kg/L, UoM=${material?.baseUom ?? 'N/A'}, group=${material?.productGroup ?? 'N/A'}`,
            ].join('\n');
        }

        return {
            log             : logText,
            supportingDocs  : docs.join(', '),
            relatedMovements: movements.map(m => m.docNumber).filter(Boolean).join(', '),
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  HEURISTIC FALLBACK (used when LLM is unavailable)
    // ─────────────────────────────────────────────────────────────────
    _classifyRootCauseHeuristic(exception, line) {
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
