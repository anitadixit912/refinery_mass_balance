'use strict';

/**
 * Report Generation Agent  (Sub-agent 5 of 5)
 *
 * Implements Steps 9 & 10 of the agentic process:
 *
 * Step 9 — Exception Report (slide 23):
 *   Evidence-based findings with approval-gated correction governance.
 *   Structure:
 *     Exception ID  — auto-generated unique ID (EXC-YYYY-MM-NNNN)
 *     Period        — YYYY-MM-DD (daily) or YYYY-MM (monthly)
 *     Plant/Tank/Material — affected location and material hierarchy
 *     Variance (MT/%)     — absolute and relative variance with sign
 *     Severity            — INFO / ADVISORY / WARNING / CRITICAL
 *     Root Cause          — category code + narrative description
 *     Supporting Docs     — linked MSEG / MKPF / MI07 document numbers
 *     Recommendation      — proposed corrective action with priority
 *     Status              — Open / Under Review / Approved / Closed
 *
 *   Approval governance (slide 23):
 *     No auto-correction: agent NEVER automatically posts adjustments
 *     User review required: all ADVISORY+ exceptions reviewed by named approver
 *     Approval-gated: each correction must be explicitly approved before SAP doc creation
 *     Audit log: every action recorded with timestamp and user ID
 *
 * Step 10 — Executive Summary (slide 24):
 *   Management KPI dashboard:
 *     Data Completeness  — % of inputs validated
 *     Active Exceptions  — WARNING or CRITICAL count
 *     Refinery Variance  — overall variance %
 *     Tanks Reconciled   — count of balanced tanks
 *     Pending Approvals  — awaiting user sign-off
 *   Daily Variance Trend (last 7 days)
 *   Exception Summary by severity with status
 *   Period balance status: WITHIN TOLERANCE / OUTSIDE TOLERANCE
 *   Corrections posted | Awaiting approval
 */

const { v4: uuidv4 } = require('uuid');
const llm = require('./llm-client');

class ReportGenerationAgent {

    constructor(db) {
        this.db = db;
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 9 — Exception Report
    // ─────────────────────────────────────────────────────────────────
    async generateExceptionReport(run) {
        const exceptions = await this.db.run(
            SELECT.from('refinery.massbalance.Exception').where({ run_ID: run.ID })
        );

        const severityCounts = { INFO: 0, ADVISORY: 0, WARNING: 0, CRITICAL: 0 };
        let approvalsPending = 0;

        for (const exc of exceptions) {
            severityCounts[exc.severity] = (severityCounts[exc.severity] || 0) + 1;

            // Submit ADVISORY+ exceptions for approval (approval-gated governance — slide 23)
            if (['ADVISORY', 'WARNING', 'CRITICAL'].includes(exc.severity)
                && exc.rootCauseCategory
                && exc.status === 'UNDER_REVIEW') {

                const priority = exc.severity === 'CRITICAL' ? 'URGENT' :
                                 exc.severity === 'WARNING'  ? 'HIGH'   : 'MEDIUM';

                const existing = await this.db.run(
                    SELECT.from('refinery.massbalance.ApprovalRequest')
                        .where({ exception_ID: exc.ID, approvalStatus: 'PENDING' })
                );

                if (existing.length === 0) {
                    await this.db.run(
                        INSERT.into('refinery.massbalance.ApprovalRequest').entries({
                            ID             : uuidv4(),
                            run_ID         : run.ID,
                            exception_ID   : exc.ID,
                            requestType    : 'CORRECTION_POSTING',
                            proposedAction : exc.recommendation ||
                                'Review exception details and apply corrective action as appropriate.',
                            evidenceSummary: `Variance: ${exc.varianceMT} MT (${exc.variancePct}%) ` +
                                `| Root cause: ${exc.rootCauseCategory} — ${exc.rootCauseNarrative} ` +
                                `| Supporting docs: ${exc.supportingDocs || 'see investigation log'}`,
                            priority,
                            requestedBy    : 'AGENT',
                            requestedAt    : new Date().toISOString(),
                            approvalStatus : 'PENDING',
                        })
                    );
                    approvalsPending++;
                }
            }
        }

        const reportId = `RPT-${run.period}-${run.runId?.split('-').pop() || uuidv4().split('-')[0]}`;

        await this._log(run, 'STEP_09_EXCEPTION_REPORT',
            `Exception report ${reportId} generated: ` +
            `CRITICAL=${severityCounts.CRITICAL} WARNING=${severityCounts.WARNING} ` +
            `ADVISORY=${severityCounts.ADVISORY} INFO=${severityCounts.INFO}, ` +
            `${approvalsPending} approval requests created`,
            'SUCCESS');

        return {
            reportId,
            totalExceptions: exceptions.length,
            criticalCount  : severityCounts.CRITICAL,
            warningCount   : severityCounts.WARNING,
            advisoryCount  : severityCounts.ADVISORY,
            infoCount      : severityCounts.INFO,
            approvalsPending,
            message        : `Exception report ${reportId} ready for human review`,
        };
    }

    // ─────────────────────────────────────────────────────────────────
    //  STEP 10 — Executive Summary  (slide 24 KPI Dashboard)
    // ─────────────────────────────────────────────────────────────────
    async generateExecutiveSummary(run) {
        const [exceptions, lines, approvals, validationIssues] = await Promise.all([
            this.db.run(SELECT.from('refinery.massbalance.Exception').where({ run_ID: run.ID })),
            this.db.run(SELECT.from('refinery.massbalance.MassBalanceLine').where({ run_ID: run.ID })),
            this.db.run(SELECT.from('refinery.massbalance.ApprovalRequest').where({ run_ID: run.ID })),
            this.db.run(SELECT.from('refinery.massbalance.ValidationIssue').where({ run_ID: run.ID })),
        ]);

        // KPI: Data Completeness (100% = all inputs validated with no blockers)
        const blockers = validationIssues.filter(i => i.severity === 'BLOCKER').length;
        const dataCompleteness = blockers > 0
            ? parseFloat((100 - blockers * 10).toFixed(2))
            : 100;

        // KPI: Tanks Reconciled (lines with severity INFO = balanced)
        const tanksReconciled = lines.filter(l => l.severity === 'INFO').length;

        // KPI: Refinery Variance (%) — weighted average across all lines
        const totalClosingBook = lines.reduce((s, l) => s + (l.closingBook || 0), 0);
        const totalVariance    = lines.reduce((s, l) => s + (l.variance    || 0), 0);
        const refineryVariancePct = totalClosingBook > 0
            ? parseFloat((totalVariance / totalClosingBook * 100).toFixed(4))
            : 0;

        // KPI: Active Exceptions (WARNING or CRITICAL — slide 24)
        const activeExceptions = exceptions.filter(e =>
            ['WARNING', 'CRITICAL'].includes(e.severity) &&
            ['OPEN', 'UNDER_REVIEW'].includes(e.status)
        ).length;

        // KPI: Pending Approvals
        const pendingApprovals = approvals.filter(a => a.approvalStatus === 'PENDING').length;

        // KPI: Corrections Posted
        const correctionsPosted = approvals.filter(a =>
            a.approvalStatus === 'APPROVED' && a.sapDocNumber
        ).length;

        // Balance Status (slide 24)
        const absVariancePct = Math.abs(refineryVariancePct);
        const balanceStatus  = absVariancePct <= 0.10 ? 'WITHIN_TOLERANCE' : 'OUTSIDE_TOLERANCE';

        // Exception Summary Table (slide 24)
        const exceptionSummary = {
            CRITICAL: {
                count : exceptions.filter(e => e.severity === 'CRITICAL').length,
                status: 'Pending approval',
            },
            WARNING: {
                count : exceptions.filter(e => e.severity === 'WARNING').length,
                status: 'Under review',
            },
            ADVISORY: {
                count : exceptions.filter(e => e.severity === 'ADVISORY').length,
                status: 'Monitoring',
            },
            INFO: {
                count : exceptions.filter(e => e.severity === 'INFO').length,
                status: 'Logged',
            },
        };

        // LLM-generated management narrative
        const aiNarrative = await this._generateManagementNarrative({
            period: run.period, periodType: run.periodType,
            dataCompleteness, tanksReconciled, totalTanks: lines.length,
            refineryVariancePct, balanceStatus,
            activeExceptions, pendingApprovals, correctionsPosted,
            exceptionSummary,
        });

        await this._log(run, 'STEP_10_EXECUTIVE_SUMMARY',
            `Executive Summary (${llm.provider} AI): period=${run.period}, ` +
            `dataCompleteness=${dataCompleteness}%, tanksReconciled=${tanksReconciled}, ` +
            `variance=${refineryVariancePct}%, status=${balanceStatus}, ` +
            `exceptions=${activeExceptions}, pendingApprovals=${pendingApprovals}`,
            'SUCCESS');

        return {
            period              : run.period,
            periodType          : run.periodType,
            dataCompleteness,
            tanksReconciled,
            refineryVariancePct,
            balanceStatus,
            activeExceptions,
            pendingApprovals,
            correctionsPosted,
            exceptionSummary,
            message: aiNarrative ||
                `Period: ${run.period} | Balance Status: ${balanceStatus} | ` +
                `Corrections posted: ${correctionsPosted} | Awaiting approval: ${pendingApprovals}`,
        };
    }

    async _generateManagementNarrative(kpis) {
        const systemPrompt =
`You are a refinery operations director writing a concise executive summary for the daily mass balance report.
Write 2–3 sentences only. Be specific, use the numbers provided, and highlight any actions required.`;

        const userPrompt =
`Period: ${kpis.period} (${kpis.periodType})
Data Completeness: ${kpis.dataCompleteness}%
Tanks Reconciled: ${kpis.tanksReconciled} of ${kpis.totalTanks}
Refinery Variance: ${kpis.refineryVariancePct}%
Balance Status: ${kpis.balanceStatus}
Active Exceptions: ${kpis.activeExceptions}  (CRITICAL: ${kpis.exceptionSummary?.CRITICAL?.count || 0}, WARNING: ${kpis.exceptionSummary?.WARNING?.count || 0})
Pending Approvals: ${kpis.pendingApprovals}
Corrections Posted: ${kpis.correctionsPosted}

Write the executive summary.`;

        return llm.complete(systemPrompt, userPrompt, 300);
    }

    async _log(run, agentStep, action, result) {
        try {
            await this.db.run(
                INSERT.into('refinery.massbalance.AuditLog').entries({
                    ID: uuidv4(), run_ID: run.ID,
                    timestamp: new Date().toISOString(),
                    agentName: 'ReportGenerationAgent',
                    agentStep, action, dataSource: 'INTERNAL',
                    decisionRationale: action, userId: 'SYSTEM', result,
                })
            );
        } catch { /* non-blocking */ }
    }
}

module.exports = ReportGenerationAgent;
