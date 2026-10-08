"""
CrewAI 1.x orchestrator: 5 agents, 10 sequential tasks — Refinery Mass Balance Pipeline.

Agent ↔ Task mapping (slide 10 / slide 16):
  DataCollectionAgent             → Task 01 (ingest)
  ValidationAnomalyAgent          → Task 02 (validate)
  CalculationReconciliationAgent  → Tasks 03–06 (calculate, reconcile, compare, tolerance)
  ExceptionManagementAgent        → Tasks 07–08 (investigate, classify)
  ReportGenerationAgent           → Tasks 09–10 (exception report, executive summary)
"""

import os
from crewai import Agent, Crew, Process, Task, LLM

from .prompts import (
    DATA_COLLECTION_ROLE, DATA_COLLECTION_GOAL, DATA_COLLECTION_BACKSTORY,
    VALIDATION_ROLE, VALIDATION_GOAL, VALIDATION_BACKSTORY,
    CALCULATION_ROLE, CALCULATION_GOAL, CALCULATION_BACKSTORY,
    EXCEPTION_ROLE, EXCEPTION_GOAL, EXCEPTION_BACKSTORY,
    REPORT_ROLE, REPORT_GOAL, REPORT_BACKSTORY,
)
from .tools import (
    ingest_sap_data,
    validate_data,
    calculate_mass_balance,
    reconcile_levels,
    compare_physical_vs_book,
    check_tolerances,
    investigate_variances,
    classify_root_causes,
    generate_exception_report,
    generate_executive_summary,
    get_run_status,
)


def _llm() -> LLM:
    return LLM(
        model="anthropic/claude-sonnet-5-5",
        api_key=os.getenv("ANTHROPIC_API_KEY"),
        temperature=0.0,
    )


class MassBalanceOrchestrator:
    """Builds and kicks off the full 10-step mass balance Crew for a given run_id."""

    def __init__(self) -> None:
        llm = _llm()

        # ── Agents ────────────────────────────────────────────────────
        self.data_agent = Agent(
            role=DATA_COLLECTION_ROLE,
            goal=DATA_COLLECTION_GOAL,
            backstory=DATA_COLLECTION_BACKSTORY,
            tools=[ingest_sap_data, get_run_status],
            llm=llm, verbose=True, allow_delegation=False,
        )

        self.validation_agent = Agent(
            role=VALIDATION_ROLE,
            goal=VALIDATION_GOAL,
            backstory=VALIDATION_BACKSTORY,
            tools=[validate_data, get_run_status],
            llm=llm, verbose=True, allow_delegation=False,
        )

        self.calculation_agent = Agent(
            role=CALCULATION_ROLE,
            goal=CALCULATION_GOAL,
            backstory=CALCULATION_BACKSTORY,
            tools=[
                calculate_mass_balance,
                reconcile_levels,
                compare_physical_vs_book,
                check_tolerances,
                get_run_status,
            ],
            llm=llm, verbose=True, allow_delegation=False,
        )

        self.exception_agent = Agent(
            role=EXCEPTION_ROLE,
            goal=EXCEPTION_GOAL,
            backstory=EXCEPTION_BACKSTORY,
            tools=[investigate_variances, classify_root_causes, get_run_status],
            llm=llm, verbose=True, allow_delegation=False,
        )

        self.report_agent = Agent(
            role=REPORT_ROLE,
            goal=REPORT_GOAL,
            backstory=REPORT_BACKSTORY,
            tools=[generate_exception_report, generate_executive_summary, get_run_status],
            llm=llm, verbose=True, allow_delegation=False,
        )

    def build_crew(self, run_id: str) -> Crew:
        # ── Tasks (10-step pipeline) ───────────────────────────────────
        t1 = Task(
            description=(
                f"STEP 01 — INGEST DATA for run_id='{run_id}'.\n"
                "Ingest all five data domains from SAP S/4HANA, SCADA, tank gauges, and LIMS: "
                "TANK (tank master), MAT (material master), MOV (MSEG/MKPF movement documents), "
                "PHYS (MI01/MI07 dip readings), BOOK (MARD book stock snapshot). "
                "Call the 'Ingest SAP Data' tool with run_id. "
                "Report ingested record counts per domain."
            ),
            expected_output=(
                "JSON confirming all five domains ingested with record counts. "
                "Example: {status: SUCCESS, tanks: 6, materials: 10, movements: 6, "
                "physical_readings: 6, book_snapshots: 6}"
            ),
            agent=self.data_agent,
        )

        t2 = Task(
            description=(
                f"STEP 02 — VALIDATE DATA for run_id='{run_id}'.\n"
                "Run all completeness, consistency, and referential integrity checks. "
                "Call the 'Validate Data Completeness and Integrity' tool with run_id. "
                "IMPORTANT: If the tool returns status=BLOCKED (blocker_count > 0), "
                "report the blocking issues clearly and state that no further steps can proceed "
                "until the blockers are resolved. Do NOT proceed to calculation steps."
            ),
            expected_output=(
                "Validation summary with pass/fail counts and blocker count. "
                "If BLOCKED: list all blocker issues. If PASSED: confirm safe to proceed."
            ),
            agent=self.validation_agent,
            context=[t1],
        )

        t3 = Task(
            description=(
                f"STEP 03 — CALCULATE MASS BALANCE for run_id='{run_id}'.\n"
                "Apply the formula: Closing = Opening + Receipts - Issues - Consumption +/- Transfers +/- Adjustments "
                "for every tank/material combination. "
                "Call the 'Calculate Mass Balance' tool with run_id. "
                "Report lines processed and total variance."
            ),
            expected_output=(
                "JSON with lines_processed and total_variance_mt. "
                "Example: {lines_processed: 6, total_variance_mt: 12.453}"
            ),
            agent=self.calculation_agent,
            context=[t2],
        )

        t4 = Task(
            description=(
                f"STEP 04 — RECONCILE at Plant, Tank, and Material level for run_id='{run_id}'.\n"
                "Call the 'Reconcile Balance at Plant Tank and Material Level' tool with run_id. "
                "Report the plant-level variance and how many tank lines show non-zero variance."
            ),
            expected_output=(
                "Reconciliation summary by level. Example: "
                "{plant_variance_mt: 12.453, tank_lines: 6, lines_with_variance: 4}"
            ),
            agent=self.calculation_agent,
            context=[t3],
        )

        t5 = Task(
            description=(
                f"STEP 05 — COMPARE PHYSICAL vs BOOK STOCK for run_id='{run_id}'.\n"
                "Call the 'Compare Physical Stock vs SAP Book Stock' tool with run_id. "
                "Report counts of EXCESS and SHORTAGE variances."
            ),
            expected_output=(
                "Comparison results: excess_count, shortage_count, balanced_count, exceptions_found."
            ),
            agent=self.calculation_agent,
            context=[t4],
        )

        t6 = Task(
            description=(
                f"STEP 06 — CHECK TOLERANCES for run_id='{run_id}'.\n"
                "Apply the tolerance matrix: INFO / ADVISORY / WARNING / CRITICAL. "
                "Call the 'Check Variance Against Tolerance Thresholds' tool with run_id. "
                "Report counts per severity band and the overall severity status."
            ),
            expected_output=(
                "Severity band counts: {INFO, ADVISORY, WARNING, CRITICAL} and overall severity."
            ),
            agent=self.calculation_agent,
            context=[t5],
        )

        t7 = Task(
            description=(
                f"STEP 07 — INVESTIGATE VARIANCES for run_id='{run_id}'.\n"
                "Investigate all ADVISORY/WARNING/CRITICAL lines using the 5-step drill-down: "
                "(1) period isolation, (2) movement documents, (3) physical data, "
                "(4) meter data, (5) master data. "
                "Call the 'Investigate Flagged Variances' tool with run_id. "
                "Report exceptions created."
            ),
            expected_output=(
                "Investigation summary: flagged_lines, exceptions_created."
            ),
            agent=self.exception_agent,
            context=[t6],
        )

        t8 = Task(
            description=(
                f"STEP 08 — CLASSIFY ROOT CAUSES for run_id='{run_id}'.\n"
                "Apply the 6-category taxonomy (MC/TX/MD/TF/PL/SY) to all open exceptions. "
                "Call the 'Classify Exception Root Causes' tool with run_id. "
                "Report classification by category."
            ),
            expected_output=(
                "Root cause breakdown: {MC, TX, MD, TF, PL, SY} counts and total classified."
            ),
            agent=self.exception_agent,
            context=[t7],
        )

        t9 = Task(
            description=(
                f"STEP 09 — GENERATE EXCEPTION REPORT for run_id='{run_id}'.\n"
                "Build the evidence-based exception report. "
                "Call the 'Generate Exception Report' tool with run_id. "
                "Create approval requests for all ADVISORY/WARNING/CRITICAL exceptions. "
                "IMPORTANT: No corrections are auto-applied. All adjustments require human approval."
            ),
            expected_output=(
                "Report summary with total_exceptions by severity and approvals_pending count. "
                "Include requires_human_review flag."
            ),
            agent=self.report_agent,
            context=[t8],
        )

        t10 = Task(
            description=(
                f"STEP 10 — GENERATE EXECUTIVE SUMMARY for run_id='{run_id}'.\n"
                "Build the management KPI dashboard. "
                "Call the 'Generate Executive Summary Dashboard' tool with run_id. "
                "Report all KPIs: Data Completeness %, Active Exceptions, Refinery Variance %, "
                "Tanks Reconciled, Pending Approvals, Corrections Posted, and balance_status."
            ),
            expected_output=(
                "Full executive summary with all KPIs and exception_summary table. "
                "balance_status must be either WITHIN_TOLERANCE or OUTSIDE_TOLERANCE."
            ),
            agent=self.report_agent,
            context=[t9],
        )

        return Crew(
            agents=[
                self.data_agent, self.validation_agent,
                self.calculation_agent, self.exception_agent, self.report_agent,
            ],
            tasks=[t1, t2, t3, t4, t5, t6, t7, t8, t9, t10],
            process=Process.sequential,
            verbose=True,
        )

    def run(self, run_id: str) -> str:
        """Kick off the 10-step pipeline and return the final crew output string."""
        crew = self.build_crew(run_id)
        result = crew.kickoff()
        return str(result)
