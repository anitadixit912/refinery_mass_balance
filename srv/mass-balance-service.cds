/*
 * Refinery Mass Balance Reconciliation Agent — CDS Service Definition
 *
 * Exposes the full 10-step agentic process as a RESTful OData service.
 * Human-in-the-loop: no automatic corrections — all adjustments require
 * explicit user approval before any SAP document is created or modified.
 */

using refinery.massbalance as db from '../db/schema';

// ─────────────────────────────────────────────────────────────────────
//  MAIN SERVICE
// ─────────────────────────────────────────────────────────────────────

service MassBalanceService @(path: '/api/mass-balance') {

    // ── Master Data (read-only for operators; managed by SAP S/4HANA) ──

    @readonly
    entity Plants      as projection on db.Plants;

    @readonly
    entity Tanks       as projection on db.Tanks;

    @readonly
    entity Materials   as projection on db.Materials;

    @readonly
    entity UomConversions as projection on db.UomConversion;

    // ── Tolerance Configuration (operator-defined per slide 21) ────────

    @(restrict: [{ grant: ['READ','WRITE'], to: 'OperationsManager' }])
    entity ToleranceConfigs as projection on db.ToleranceConfig;

    // ── Mass Balance Runs ───────────────────────────────────────────────

    @cds.redirection.target: true
    entity MassBalanceRuns as projection on db.MassBalanceRun;

    // ── Balance Lines ───────────────────────────────────────────────────

    @cds.redirection.target: true
    entity MassBalanceLines as projection on db.MassBalanceLine;

    // ── Validation Issues ───────────────────────────────────────────────

    entity ValidationIssues as projection on db.ValidationIssue;

    // ── Physical Inventory Documents (PHYS domain — MI01/MI07) ─────────

    entity PhysicalInventories as projection on db.PhysicalInventory;

    // ── Material Movements (MOV domain — MSEG/MKPF) ────────────────────

    entity MaterialMovements as projection on db.MaterialMovement;

    // ── Book Stock Snapshots (BOOK domain — MARD) ──────────────────────

    entity BookStockSnapshots as projection on db.BookStockSnapshot;

    // ── Exceptions (Steps 8 & 9 — Evidence-based findings) ─────────────

    @cds.redirection.target: true
    entity Exceptions as projection on db.Exception;

    // ── Approval Requests (Human-in-the-Loop — slides 6 & 23) ──────────

    entity ApprovalRequests as projection on db.ApprovalRequest;

    // ── Audit Log (Full Audit Trail — slide 6) ──────────────────────────

    @readonly
    entity AuditLogs as projection on db.AuditLog;

    // ── Analytics Views (for Executive Summary dashboard — slide 24) ────

    @readonly
    entity ExceptionsBySeverity as select from db.Exception {
        severity,
        count(*) as exceptionCount : Integer,
        status
    } group by severity, status;

    @readonly
    entity VarianceTrend as select from db.MassBalanceLine {
        run.period,
        run.periodType,
        plant.plantCode,
        sum(variance) as totalVarianceMT : Decimal(15,3),
        avg(variancePct) as avgVariancePct : Decimal(8,4),
        severity
    } group by run.period, run.periodType, plant.plantCode, severity;

    @readonly
    entity RunSummary as select from db.MassBalanceRun {
        ID, runId, period, periodType, runStatus,
        dataCompleteness, tanksReconciled,
        refineryVariancePct, balanceStatus,
        correctionsPosted, pendingApprovals,
        plant.plantCode, plant.plantName
    };

    // ── Pipeline actions (unbound — called at service level) ────────────

    action triggerRun(
        periodType : String enum { DAILY; MONTHLY; },
        period     : String,
        plantId    : UUID,
        triggerType: String enum { SCHEDULED; ON_DEMAND; MANUAL; }
    ) returns MassBalanceRun;

    action validateData            (runId: UUID) returns ValidationResult;
    action calculateBalance        (runId: UUID) returns CalculationResult;
    action reconcileAndCompare     (runId: UUID) returns ReconciliationResult;
    action checkTolerances         (runId: UUID) returns ToleranceCheckResult;
    action investigateAndClassify  (runId: UUID) returns InvestigationResult;
    action generateExceptionReport (runId: UUID) returns ExceptionReportResult;
    action generateExecutiveSummary(runId: UUID) returns ExecutiveSummaryResult;

    action runFullPipeline(
        periodType : String enum { DAILY; MONTHLY; },
        period     : String,
        plantId    : UUID
    ) returns PipelineResult;

    action classifyRootCause(
        exceptionId      : UUID,
        rootCauseCategory: String enum { MC; TX; MD; TF; PL; SY; },
        narrative        : String
    ) returns ExceptionResult;

    action submitForApproval(
        exceptionId   : UUID,
        proposedAction: String,
        priority      : String enum { LOW; MEDIUM; HIGH; URGENT; }
    ) returns ApprovalRequestResult;

    action closeException (exceptionId: UUID, comments: String) returns ExceptionResult;
    action approve        (approvalId:  UUID, comments: String) returns ApprovalRequestResult;
    action rejectApproval (approvalId:  UUID, comments: String) returns ApprovalRequestResult;
}

// ─────────────────────────────────────────────────────────────────────
//  ADMIN SERVICE  — Configuration management
// ─────────────────────────────────────────────────────────────────────

service AdminService @(path: '/api/admin') {

    @(restrict: [{ grant: '*', to: 'Administrator' }])
    entity Plants          as projection on db.Plants;

    @(restrict: [{ grant: '*', to: 'Administrator' }])
    entity Tanks           as projection on db.Tanks;

    @(restrict: [{ grant: '*', to: 'Administrator' }])
    entity Materials       as projection on db.Materials;

    @(restrict: [{ grant: '*', to: 'Administrator' }])
    entity UomConversions  as projection on db.UomConversion;

    @(restrict: [{ grant: '*', to: 'Administrator' }])
    entity ToleranceConfigs as projection on db.ToleranceConfig;
}

// ─────────────────────────────────────────────────────────────────────
//  RETURN TYPES
// ─────────────────────────────────────────────────────────────────────

type MassBalanceRun {
    ID     : UUID;
    runId  : String;
    status : String;
}

type ValidationResult {
    success       : Boolean;
    checksPassed  : Integer;
    checksFailed  : Integer;
    blockerCount  : Integer;
    issues        : array of {
        checkCategory : String;
        checkName     : String;
        entityId      : String;
        issueDesc     : String;
        severity      : String;
    };
}

type CalculationResult {
    linesProcessed  : Integer;
    totalVarianceMT : Decimal;
    balanceStatus   : String;
    message         : String;
}

type ReconciliationResult {
    plantLines    : Integer;
    tankLines     : Integer;
    materialLines : Integer;
    exceptionsFound: Integer;
    message       : String;
}

type ToleranceCheckResult {
    infoCount     : Integer;
    advisoryCount : Integer;
    warningCount  : Integer;
    criticalCount : Integer;
    overallStatus : String;
    message       : String;
}

type InvestigationResult {
    exceptionsInvestigated : Integer;
    classified             : Integer;
    pendingClassification  : Integer;
    rootCauseSummary       : array of {
        category : String;
        count    : Integer;
    };
    message : String;
}

type ExceptionReportResult {
    reportId       : String;
    totalExceptions: Integer;
    criticalCount  : Integer;
    warningCount   : Integer;
    advisoryCount  : Integer;
    approvalsPending: Integer;
    message        : String;
}

type ExecutiveSummaryResult {
    period              : String;
    dataCompleteness    : Decimal;
    tanksReconciled     : Integer;
    refineryVariancePct : Decimal;
    balanceStatus       : String;
    activeExceptions    : Integer;
    pendingApprovals    : Integer;
    correctionsPosted   : Integer;
    message             : String;
}

type PipelineResult {
    runId           : String;
    stepsCompleted  : Integer;
    finalStatus     : String;
    requiresHumanAction: Boolean;
    message         : String;
}

type ExceptionResult {
    ID      : UUID;
    exceptionId : String;
    status  : String;
    message : String;
}

type ApprovalRequestResult {
    ID             : UUID;
    approvalStatus : String;
    sapDocNumber   : String;
    message        : String;
}
