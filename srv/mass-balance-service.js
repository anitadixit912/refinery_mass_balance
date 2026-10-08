'use strict';

/**
 * Refinery Mass Balance Reconciliation Agent — CAP Service Handler
 *
 * Implements all 10 agentic process steps from the flowchart (slide 16):
 *   01 Ingest SAP Data
 *   02 Validate Data
 *   03 Mass Balance Calculation
 *   04 Reconcile (Plant / Tank / Material)
 *   05 Compare Stock (Physical vs Book)
 *   06 Check Tolerance (INFO / ADVISORY / WARNING / CRITICAL)
 *   07 Investigate
 *   08 Classify Cause (MC / TX / MD / TF / PL / SY)
 *   09 Exception Report
 *   10 Executive Summary
 *
 * Human-in-the-loop: no corrections posted without explicit approval.
 */

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const Orchestrator = require('./agents/orchestrator');

module.exports = cds.service.impl(async function (srv) {

    const {
        MassBalanceRuns:    MassBalanceRun,
        MassBalanceLines:   MassBalanceLine,
        ValidationIssues:   ValidationIssue,
        Exceptions:         Exception,
        ApprovalRequests:   ApprovalRequest,
        AuditLogs:          AuditLog,
        BookStockSnapshots: BookStockSnapshot,
        ToleranceConfigs:   ToleranceConfig,
    } = srv.entities;

    const orchestrator = new Orchestrator(cds.db);

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: triggerRun
    //  Step 01 — Ingest SAP Data (slide 16)
    // ─────────────────────────────────────────────────────────────────
    srv.on('triggerRun', async (req) => {
        const { periodType, period, plantId, triggerType } = req.data;
        const runId = `RUN-${period}-${uuidv4().split('-')[0].toUpperCase()}`;

        const run = await INSERT.into(MassBalanceRun).entries({
            ID          : uuidv4(),
            runId,
            periodType,
            period,
            plant_ID    : plantId,
            runStatus   : 'INITIATED',
            triggerType : triggerType || 'MANUAL',
            triggeredBy : req.user?.id || 'SYSTEM',
        });

        await _auditLog(cds.db, null, runId, 'MassBalanceOrchestratorAgent',
            'STEP_01_INGEST', 'Run initiated — beginning SAP data ingestion',
            'SYSTEM', 'SUCCESS', `periodType=${periodType}, period=${period}`);

        return { ID: run.ID, runId, status: 'INITIATED' };
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: validateData
    //  Step 02 — Data Validation & Completeness (slide 18)
    //  Checks: Completeness | Consistency | Referential Integrity
    // ─────────────────────────────────────────────────────────────────
    srv.on('validateData', async (req) => {
        const { runId } = req.data;
        const run = await _getRun(runId);

        await _setRunStatus(run.ID, 'VALIDATING');

        const result = await orchestrator.validationAgent.run(run);

        await _setRunStatus(run.ID,
            result.blockerCount > 0 ? 'FAILED' : 'CALCULATING');

        await _auditLog(cds.db, run.ID, run.runId, 'ValidationAnomalyAgent',
            'STEP_02_VALIDATE',
            `Validation complete: ${result.checksPassed} passed, ${result.checksFailed} failed`,
            'SYSTEM', result.blockerCount > 0 ? 'FAILURE' : 'SUCCESS');

        return result;
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: calculateBalance
    //  Step 03 — Mass Balance Calculation (slide 19)
    //  Formula: Closing = Opening + Receipts − Issues − Consumption
    //           ± Transfers ± Adjustments
    // ─────────────────────────────────────────────────────────────────
    srv.on('calculateBalance', async (req) => {
        const { runId } = req.data;
        const run = await _getRun(runId);

        await _setRunStatus(run.ID, 'CALCULATING');

        const result = await orchestrator.calculationAgent.calculateBalance(run);

        await _auditLog(cds.db, run.ID, run.runId, 'CalculationReconciliationAgent',
            'STEP_03_CALCULATE',
            `Balance calculated: ${result.linesProcessed} lines, variance=${result.totalVarianceMT} MT`,
            'SYSTEM', 'SUCCESS');

        return result;
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: reconcileAndCompare
    //  Step 04 — Reconcile (Plant / Tank / Material level)
    //  Step 05 — Compare Physical vs Book Stock (slide 20)
    //  Variance (MT) = Physical Quantity − Book Quantity
    //  Positive = Physical EXCESS | Negative = Physical SHORTAGE
    // ─────────────────────────────────────────────────────────────────
    srv.on('reconcileAndCompare', async (req) => {
        const { runId } = req.data;
        const run = await _getRun(runId);

        await _setRunStatus(run.ID, 'RECONCILING');

        const result = await orchestrator.calculationAgent.reconcile(run);

        await _setRunStatus(run.ID, 'COMPARING');
        const compareResult = await orchestrator.calculationAgent.compareStock(run);

        await _auditLog(cds.db, run.ID, run.runId, 'CalculationReconciliationAgent',
            'STEP_04_05_RECONCILE_COMPARE',
            `Reconciled ${result.tankLines} tanks; ${compareResult.exceptionsFound} variances detected`,
            'SYSTEM', 'SUCCESS');

        return {
            plantLines    : result.plantLines,
            tankLines     : result.tankLines,
            materialLines : result.materialLines,
            exceptionsFound: compareResult.exceptionsFound,
            message       : compareResult.message,
        };
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: checkTolerances
    //  Step 06 — Variance Detection & Tolerance Limits (slide 21)
    //  Severity bands:
    //    INFO     — within tolerance
    //    ADVISORY — 50–100% of threshold
    //    WARNING  — 100–150% of threshold
    //    CRITICAL — > 150% of threshold
    // ─────────────────────────────────────────────────────────────────
    srv.on('checkTolerances', async (req) => {
        const { runId } = req.data;
        const run = await _getRun(runId);

        await _setRunStatus(run.ID, 'CHECKING_TOL');

        const result = await orchestrator.calculationAgent.checkTolerances(run);

        const nextStatus = result.criticalCount > 0 ? 'INVESTIGATING' :
            result.warningCount > 0 ? 'INVESTIGATING' : 'REPORTING';

        await _setRunStatus(run.ID, nextStatus);

        await _auditLog(cds.db, run.ID, run.runId, 'CalculationReconciliationAgent',
            'STEP_06_TOLERANCE',
            `Tolerance check: INFO=${result.infoCount} ADVISORY=${result.advisoryCount} ` +
            `WARNING=${result.warningCount} CRITICAL=${result.criticalCount}`,
            'SYSTEM', result.criticalCount > 0 ? 'WARNING' : 'SUCCESS');

        return result;
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: investigateAndClassify
    //  Step 07 — Investigate (drill into transactions, meter data, master data)
    //  Step 08 — Classify Cause (slide 22)
    //    MC — Measurement Error
    //    TX — Transaction Error
    //    MD — Master Data Issue
    //    TF — Transfer / Routing
    //    PL — Physical Loss / Gain
    //    SY — System / Interface
    // ─────────────────────────────────────────────────────────────────
    srv.on('investigateAndClassify', async (req) => {
        const { runId } = req.data;
        const run = await _getRun(runId);

        await _setRunStatus(run.ID, 'INVESTIGATING');
        const investResult = await orchestrator.exceptionAgent.investigate(run);

        await _setRunStatus(run.ID, 'CLASSIFYING');
        const classResult = await orchestrator.exceptionAgent.classifyRootCauses(run);

        await _auditLog(cds.db, run.ID, run.runId, 'ExceptionManagementAgent',
            'STEP_07_08_INVESTIGATE_CLASSIFY',
            `Investigated ${investResult.exceptionsInvestigated} exceptions; ` +
            `classified ${classResult.classified}`,
            'SYSTEM', 'SUCCESS');

        return {
            exceptionsInvestigated: investResult.exceptionsInvestigated,
            classified            : classResult.classified,
            pendingClassification : classResult.pendingClassification,
            rootCauseSummary      : classResult.rootCauseSummary,
            message               : classResult.message,
        };
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: generateExceptionReport
    //  Step 09 — Exception Report (slide 23)
    //  Builds evidence package with:
    //    exceptionId, period, plant/tank/material, variance, severity,
    //    root cause, supporting docs, recommendations, status
    // ─────────────────────────────────────────────────────────────────
    srv.on('generateExceptionReport', async (req) => {
        const { runId } = req.data;
        const run = await _getRun(runId);

        await _setRunStatus(run.ID, 'REPORTING');

        const result = await orchestrator.reportAgent.generateExceptionReport(run);

        await _auditLog(cds.db, run.ID, run.runId, 'ReportGenerationAgent',
            'STEP_09_EXCEPTION_REPORT',
            `Exception report generated: ${result.totalExceptions} exceptions, ` +
            `${result.approvalsPending} pending approvals`,
            'SYSTEM', 'SUCCESS');

        // Pause for human review — PENDING_APPR if any approvals required
        if (result.approvalsPending > 0) {
            await _setRunStatus(run.ID, 'PENDING_APPR');
        }

        return result;
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: generateExecutiveSummary
    //  Step 10 — Executive Summary (slide 24)
    //  KPIs: Data Completeness, Active Exceptions, Refinery Variance,
    //        Tanks Reconciled, Pending Approvals, Daily Variance Trend
    // ─────────────────────────────────────────────────────────────────
    srv.on('generateExecutiveSummary', async (req) => {
        const { runId } = req.data;
        const run = await _getRun(runId);

        await _setRunStatus(run.ID, 'SUMMARISING');

        const result = await orchestrator.reportAgent.generateExecutiveSummary(run);

        // Update run KPI fields
        await UPDATE(MassBalanceRun).where({ ID: run.ID }).set({
            dataCompleteness   : result.dataCompleteness,
            tanksReconciled    : result.tanksReconciled,
            refineryVariancePct: result.refineryVariancePct,
            balanceStatus      : result.balanceStatus,
            correctionsPosted  : result.correctionsPosted,
            pendingApprovals   : result.pendingApprovals,
        });

        await _setRunStatus(run.ID,
            result.pendingApprovals > 0 ? 'PENDING_APPR' : 'COMPLETED');

        await _auditLog(cds.db, run.ID, run.runId, 'ReportGenerationAgent',
            'STEP_10_EXECUTIVE_SUMMARY',
            `Summary: balance=${result.balanceStatus}, variance=${result.refineryVariancePct}%, ` +
            `exceptions=${result.activeExceptions}`,
            'SYSTEM', 'SUCCESS');

        return result;
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: runFullPipeline
    //  End-to-end 10-step pipeline with automatic human approval gates
    // ─────────────────────────────────────────────────────────────────
    srv.on('runFullPipeline', async (req) => {
        const { periodType, period, plantId } = req.data;

        // Delegate the full pipeline to the orchestrator agent
        const result = await orchestrator.runFullPipeline({
            periodType, period, plantId,
            triggeredBy: req.user?.id || 'SYSTEM',
        });

        return result;
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: classifyRootCause  (on Exception)
    // ─────────────────────────────────────────────────────────────────
    srv.on('classifyRootCause', async (req) => {
        const { exceptionId, rootCauseCategory, narrative } = req.data;

        const exc = await SELECT.one.from('refinery.massbalance.Exception')
            .where({ ID: exceptionId });
        if (!exc) return req.error(404, `Exception ${exceptionId} not found`);

        await UPDATE('refinery.massbalance.Exception').where({ ID: exceptionId }).set({
            rootCauseCategory,
            rootCauseNarrative: narrative,
            status: 'UNDER_REVIEW',
        });

        return { ID: exceptionId, exceptionId: exc.exceptionId, status: 'UNDER_REVIEW',
            message: `Root cause classified as ${rootCauseCategory}` };
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: submitForApproval  (on Exception)
    //  Evidence-based — all variances backed by transaction-level
    //  evidence before any exception is raised or escalated (slide 6)
    // ─────────────────────────────────────────────────────────────────
    srv.on('submitForApproval', async (req) => {
        const { exceptionId, proposedAction, priority } = req.data;

        const exc = await SELECT.one.from('refinery.massbalance.Exception')
            .where({ ID: exceptionId });
        if (!exc) return req.error(404, `Exception ${exceptionId} not found`);

        const approvalId = uuidv4();
        await INSERT.into(ApprovalRequest).entries({
            ID             : approvalId,
            run_ID         : exc.run_ID,
            exception_ID   : exceptionId,
            requestType    : 'CORRECTION_POSTING',
            proposedAction,
            priority       : priority || 'MEDIUM',
            requestedBy    : req.user?.id || 'AGENT',
            requestedAt    : new Date().toISOString(),
            approvalStatus : 'PENDING',
        });

        await UPDATE('refinery.massbalance.Exception').where({ ID: exceptionId }).set({
            status: 'UNDER_REVIEW',
        });

        return { ID: approvalId, approvalStatus: 'PENDING',
            message: 'Approval request submitted — awaiting human sign-off' };
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: closeException
    // ─────────────────────────────────────────────────────────────────
    srv.on('closeException', async (req) => {
        const { exceptionId, comments } = req.data;

        await UPDATE('refinery.massbalance.Exception').where({ ID: exceptionId }).set({
            status         : 'CLOSED',
            closingComments: comments,
            approvedBy     : req.user?.id,
            approvedAt     : new Date().toISOString(),
        });

        return { ID: exceptionId, status: 'CLOSED', message: 'Exception closed successfully' };
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: approve  (on ApprovalRequest)
    //  Approval-gated: each correction must be explicitly approved
    //  before any SAP document is created or modified (slide 23)
    // ─────────────────────────────────────────────────────────────────
    srv.on('approve', async (req) => {
        const { approvalId, comments } = req.data;

        const approval = await SELECT.one.from(ApprovalRequest).where({ ID: approvalId });
        if (!approval) return req.error(404, `Approval ${approvalId} not found`);
        if (approval.approvalStatus !== 'PENDING')
            return req.error(409, 'Approval request is no longer pending');

        // Generate a simulated SAP document number (real integration would call SAP APIs)
        const sapDocNumber = `5000${Math.floor(Math.random() * 90000 + 10000)}`;

        await UPDATE(ApprovalRequest).where({ ID: approvalId }).set({
            approvalStatus: 'APPROVED',
            approvedBy    : req.user?.id || 'APPROVER',
            approvedAt    : new Date().toISOString(),
            comments,
            sapDocNumber,
        });

        // Update parent exception status
        if (approval.exception_ID) {
            await UPDATE('refinery.massbalance.Exception')
                .where({ ID: approval.exception_ID })
                .set({ status: 'APPROVED', approvedBy: req.user?.id,
                    approvedAt: new Date().toISOString() });
        }

        await _auditLog(cds.db, approval.run_ID, null, 'HUMAN',
            'APPROVAL_GATE', `Correction approved by ${req.user?.id} — SAP doc ${sapDocNumber}`,
            req.user?.id || 'APPROVER', 'SUCCESS',
            `approvalId=${approvalId}, sapDoc=${sapDocNumber}`);

        return { ID: approvalId, approvalStatus: 'APPROVED',
            sapDocNumber, message: `Correction approved. SAP document ${sapDocNumber} created.` };
    });

    // ─────────────────────────────────────────────────────────────────
    //  ACTION: reject  (on ApprovalRequest)
    // ─────────────────────────────────────────────────────────────────
    srv.on('rejectApproval', async (req) => {
        const { approvalId, comments } = req.data;

        const approval = await SELECT.one.from(ApprovalRequest).where({ ID: approvalId });
        if (!approval) return req.error(404, `Approval ${approvalId} not found`);

        await UPDATE(ApprovalRequest).where({ ID: approvalId }).set({
            approvalStatus: 'REJECTED',
            approvedBy    : req.user?.id || 'APPROVER',
            approvedAt    : new Date().toISOString(),
            comments,
        });

        if (approval.exception_ID) {
            await UPDATE('refinery.massbalance.Exception')
                .where({ ID: approval.exception_ID })
                .set({ status: 'OPEN' });
        }

        await _auditLog(cds.db, approval.run_ID, null, 'HUMAN',
            'APPROVAL_GATE', `Correction rejected by ${req.user?.id}: ${comments}`,
            req.user?.id || 'APPROVER', 'WARNING');

        return { ID: approvalId, approvalStatus: 'REJECTED',
            message: 'Correction rejected. Exception returned to OPEN status.' };
    });

    // ─────────────────────────────────────────────────────────────────
    //  HELPERS
    // ─────────────────────────────────────────────────────────────────

    async function _getRun(runIdOrUUID) {
        const run = await SELECT.one.from(MassBalanceRun)
            .where({ ID: runIdOrUUID }).or({ runId: runIdOrUUID });
        if (!run) throw new Error(`Run ${runIdOrUUID} not found`);
        return run;
    }

    async function _setRunStatus(runID, status) {
        await UPDATE(MassBalanceRun).where({ ID: runID }).set({ runStatus: status });
    }
});

// ─────────────────────────────────────────────────────────────────────
//  GLOBAL AUDIT LOG HELPER (used by agents and service handler)
// ─────────────────────────────────────────────────────────────────────
async function _auditLog(db, runID, runId, agentName, agentStep, action,
    userId, result, inputSummary = '') {
    try {
        await db.run(
            INSERT.into('refinery.massbalance.AuditLog').entries({
                ID              : require('uuid').v4(),
                run_ID          : runID,
                timestamp       : new Date().toISOString(),
                agentName,
                agentStep,
                action,
                dataSource      : 'INTERNAL',
                decisionRationale: action,
                inputSummary,
                userId,
                result,
            })
        );
    } catch { /* audit log failure must not break the main flow */ }
}

module.exports._auditLog = _auditLog;
