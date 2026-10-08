'use strict';

/**
 * Mass Balance Orchestrator Agent
 *
 * Implements Criterion 5 — Role-orchestrated Coordination (slide 10):
 *   Top-level agent that decomposes the goal into sub-agent tasks,
 *   performs dynamic replanning on failure, manages human-in-the-loop
 *   escalation gates, and maintains the full audit trail.
 *
 * Sub-agents managed:
 *   1. DataCollectionAgent    — pulls readings from SCADA, tank gauges, LIMS
 *   2. ValidationAnomalyAgent — detects sensor faults, missing readings, outliers
 *   3. CalculationReconciliationAgent — performs unit-level balances iteratively
 *   4. ExceptionManagementAgent — investigates flagged variances, escalates
 *   5. ReportGenerationAgent  — exception report + executive summary
 *
 * Platform: SAP BTP | SAP AI Core | SAP Business AI (slide 12)
 */

const DataCollectionAgent           = require('./data-collection-agent');
const ValidationAnomalyAgent        = require('./validation-agent');
const CalculationReconciliationAgent = require('./calculation-agent');
const ExceptionManagementAgent      = require('./exception-agent');
const ReportGenerationAgent         = require('./report-agent');

class MassBalanceOrchestratorAgent {

    constructor(db) {
        this.db = db;
        // Instantiate the five sub-agents (slide 12)
        this.dataCollectionAgent  = new DataCollectionAgent(db);
        this.validationAgent      = new ValidationAnomalyAgent(db);
        this.calculationAgent     = new CalculationReconciliationAgent(db);
        this.exceptionAgent       = new ExceptionManagementAgent(db);
        this.reportAgent          = new ReportGenerationAgent(db);
    }

    /**
     * Full 10-step pipeline with automatic human-in-the-loop gates.
     *
     * The agent independently initiates the reporting cycle (Criterion 1 —
     * Autonomy, slide 8), executing an interdependent reasoning chain
     * (Criterion 2 — Multi-step Reasoning, slide 8) across all five
     * sub-agent roles.
     *
     * Human approval is required at two gates (slide 16):
     *   Gate A: User Reviews Report (after Step 09)
     *   Gate B: User Approves Corrections (before any SAP posting)
     */
    async runFullPipeline({ periodType, period, plantId, triggeredBy }) {
        const runId = `RUN-${period}-${this._shortId()}`;
        let stepsCompleted = 0;

        try {
            // ── Create run record ────────────────────────────────────
            const run = await this._createRun(runId, periodType, period, plantId, triggeredBy);
            await this._audit(run, 'MassBalanceOrchestratorAgent',
                'PIPELINE_START', 'Full pipeline initiated', 'SYSTEM', 'SUCCESS');

            // ── Step 01: Ingest SAP Data ─────────────────────────────
            await this._setStatus(run.ID, 'INGESTING');
            await this.dataCollectionAgent.ingestData(run);
            stepsCompleted = 1;
            await this._audit(run, 'DataCollectionAgent', 'STEP_01_INGEST',
                'SAP data ingested: Tanks / Materials / Movements / Inventory / Book Stock',
                'SYSTEM', 'SUCCESS');

            // ── Step 02: Validate Data ───────────────────────────────
            await this._setStatus(run.ID, 'VALIDATING');
            const validationResult = await this.validationAgent.run(run);
            stepsCompleted = 2;

            if (validationResult.blockerCount > 0) {
                await this._setStatus(run.ID, 'FAILED');
                await this._audit(run, 'ValidationAnomalyAgent', 'STEP_02_VALIDATE',
                    `BLOCKER: ${validationResult.blockerCount} validation blockers found — pipeline halted`,
                    'SYSTEM', 'FAILURE');
                return {
                    runId, stepsCompleted, finalStatus: 'FAILED',
                    requiresHumanAction: true,
                    message: `Pipeline halted: ${validationResult.blockerCount} data validation blockers require resolution`,
                };
            }
            await this._audit(run, 'ValidationAnomalyAgent', 'STEP_02_VALIDATE',
                `Validation passed: ${validationResult.checksPassed} checks OK`, 'SYSTEM', 'SUCCESS');

            // ── Step 03: Mass Balance Calculation ────────────────────
            await this._setStatus(run.ID, 'CALCULATING');
            await this.calculationAgent.calculateBalance(run);
            stepsCompleted = 3;
            await this._audit(run, 'CalculationReconciliationAgent', 'STEP_03_CALCULATE',
                'Daily/monthly balance calculated per period', 'SYSTEM', 'SUCCESS');

            // ── Step 04: Reconcile ───────────────────────────────────
            await this._setStatus(run.ID, 'RECONCILING');
            await this.calculationAgent.reconcile(run);
            stepsCompleted = 4;
            await this._audit(run, 'CalculationReconciliationAgent', 'STEP_04_RECONCILE',
                'Plant / tank / material-level reconciliation complete', 'SYSTEM', 'SUCCESS');

            // ── Step 05: Compare Stock ───────────────────────────────
            await this._setStatus(run.ID, 'COMPARING');
            const compareResult = await this.calculationAgent.compareStock(run);
            stepsCompleted = 5;
            await this._audit(run, 'CalculationReconciliationAgent', 'STEP_05_COMPARE',
                `Physical vs book comparison: ${compareResult.exceptionsFound} variances found`,
                'SYSTEM', 'SUCCESS');

            // ── Step 06: Check Tolerance ─────────────────────────────
            await this._setStatus(run.ID, 'CHECKING_TOL');
            const tolResult = await this.calculationAgent.checkTolerances(run);
            stepsCompleted = 6;
            await this._audit(run, 'CalculationReconciliationAgent', 'STEP_06_TOLERANCE',
                `Severity: INFO=${tolResult.infoCount} ADVISORY=${tolResult.advisoryCount} ` +
                `WARNING=${tolResult.warningCount} CRITICAL=${tolResult.criticalCount}`,
                'SYSTEM', tolResult.criticalCount > 0 ? 'WARNING' : 'SUCCESS');

            // ── Steps 07 & 08: Investigate & Classify ───────────────
            if (tolResult.warningCount > 0 || tolResult.criticalCount > 0) {
                await this._setStatus(run.ID, 'INVESTIGATING');
                await this.exceptionAgent.investigate(run);
                stepsCompleted = 7;

                await this._setStatus(run.ID, 'CLASSIFYING');
                await this.exceptionAgent.classifyRootCauses(run);
                stepsCompleted = 8;

                await this._audit(run, 'ExceptionManagementAgent',
                    'STEP_07_08_INVESTIGATE_CLASSIFY',
                    'Root cause classification complete for all flagged variances',
                    'SYSTEM', 'SUCCESS');
            }

            // ── Step 09: Exception Report ────────────────────────────
            await this._setStatus(run.ID, 'REPORTING');
            const reportResult = await this.reportAgent.generateExceptionReport(run);
            stepsCompleted = 9;
            await this._audit(run, 'ReportGenerationAgent', 'STEP_09_EXCEPTION_REPORT',
                `Exception report ready: ${reportResult.totalExceptions} exceptions, ` +
                `${reportResult.approvalsPending} awaiting approval`,
                'SYSTEM', 'SUCCESS');

            // ── HUMAN GATE A: User Reviews Report ───────────────────
            if (reportResult.approvalsPending > 0) {
                await this._setStatus(run.ID, 'PENDING_APPR');
                return {
                    runId, stepsCompleted, finalStatus: 'PENDING_APPR',
                    requiresHumanAction: true,
                    message: `Human review required: ${reportResult.approvalsPending} approvals pending. ` +
                        `Call generateExecutiveSummary after approvals are completed.`,
                };
            }

            // ── Step 10: Executive Summary ───────────────────────────
            await this._setStatus(run.ID, 'SUMMARISING');
            const summaryResult = await this.reportAgent.generateExecutiveSummary(run);
            stepsCompleted = 10;
            await this._setStatus(run.ID, 'COMPLETED');
            await this._audit(run, 'ReportGenerationAgent', 'STEP_10_SUMMARY',
                `Pipeline complete: balance=${summaryResult.balanceStatus}, ` +
                `variance=${summaryResult.refineryVariancePct}%`,
                'SYSTEM', 'SUCCESS');

            return {
                runId, stepsCompleted: 10, finalStatus: 'COMPLETED',
                requiresHumanAction: false,
                message: `Mass balance pipeline completed successfully. ` +
                    `Balance status: ${summaryResult.balanceStatus}`,
            };

        } catch (err) {
            return {
                runId, stepsCompleted, finalStatus: 'FAILED',
                requiresHumanAction: true,
                message: `Pipeline failed at step ${stepsCompleted + 1}: ${err.message}`,
            };
        }
    }

    async _createRun(runId, periodType, period, plantId, triggeredBy) {
        const { v4: uuidv4 } = require('uuid');
        const id = uuidv4();
        await this.db.run(
            INSERT.into('refinery.massbalance.MassBalanceRun').entries({
                ID: id, runId, periodType, period,
                plant_ID: plantId, runStatus: 'INITIATED',
                triggerType: 'MANUAL', triggeredBy,
            })
        );
        return { ID: id, runId, periodType, period, plant_ID: plantId };
    }

    async _setStatus(runID, status) {
        await this.db.run(
            UPDATE('refinery.massbalance.MassBalanceRun').where({ ID: runID }).set({ runStatus: status })
        );
    }

    async _audit(run, agentName, agentStep, action, userId, result) {
        const { v4: uuidv4 } = require('uuid');
        try {
            await this.db.run(
                INSERT.into('refinery.massbalance.AuditLog').entries({
                    ID: uuidv4(),
                    run_ID: run.ID,
                    timestamp: new Date().toISOString(),
                    agentName, agentStep, action,
                    dataSource: 'ORCHESTRATOR',
                    decisionRationale: action,
                    userId, result,
                })
            );
        } catch { /* audit failures must not block the pipeline */ }
    }

    _shortId() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }
}

module.exports = MassBalanceOrchestratorAgent;
