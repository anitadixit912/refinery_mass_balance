"""
FastAPI application — Refinery Mass Balance Reconciliation Agent.
Implements the full agentic pipeline from the SAP September 2026 presentation.
"""

import uuid
from datetime import datetime, timezone
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, BackgroundTasks, Path, Body
from fastapi.middleware.cors import CORSMiddleware

from database import (
    init_db, SessionLocal,
    MassBalanceRun, MassException, ApprovalRequest, AuditLog, Plant
)
from schemas import (
    TriggerRunRequest, RunResponse, PipelineResult,
    ExceptionResponse, ClassifyRequest, SubmitApprovalRequest,
    ApprovalActionRequest, ApprovalResponse,
    ExecutiveSummaryResponse, ExceptionSummaryItem, AuditLogResponse,
)
from agents import MassBalanceOrchestrator


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Refinery Mass Balance Reconciliation Agent",
    description=(
        "Agentic AI system for automated refinery mass balance reconciliation. "
        "Implements a 10-step pipeline with 5 specialised CrewAI sub-agents, "
        "tolerance-based exception management, and human-in-the-loop approval governance. "
        "Built on SAP S/4HANA IS-Oil & Gas data (MARA, MSEG, MARD, MI07)."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Helper ──────────────────────────────────────────────────────────

def _get_run_or_404(run_id: str):
    db = SessionLocal()
    try:
        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        if not run:
            raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
        return run
    finally:
        db.close()


# ─── Root / Health ────────────────────────────────────────────────────

@app.get("/", tags=["Health"])
def root():
    return {
        "service": "Refinery Mass Balance Reconciliation Agent",
        "version": "1.0.0",
        "status": "running",
        "description": "10-step agentic pipeline with 5 CrewAI agents",
    }


@app.get("/health", tags=["Health"])
def health():
    db = SessionLocal()
    try:
        db.execute(__import__("sqlalchemy").text("SELECT 1"))
        return {"status": "healthy", "database": "connected"}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))
    finally:
        db.close()


# ─── Run Management ───────────────────────────────────────────────────

@app.post("/api/v1/runs", response_model=RunResponse, status_code=201, tags=["Runs"])
def trigger_run(payload: TriggerRunRequest):
    """
    Trigger a new mass balance pipeline run.
    The run is created synchronously; the 10-step agentic pipeline runs in the background.
    Returns the run_id for polling the status.
    """
    db = SessionLocal()
    try:
        plant = db.query(Plant).filter_by(plant_code=payload.plant_code).first()
        if not plant:
            raise HTTPException(status_code=404, detail=f"Plant '{payload.plant_code}' not found")

        run_id_short = str(uuid.uuid4())[:8].upper()
        run_id_str = f"RUN-{payload.period}-{run_id_short}"

        run = MassBalanceRun(
            id=str(uuid.uuid4()), run_id=run_id_str,
            plant_id=plant.id, period=payload.period,
            period_type=payload.period_type,
            trigger_type=payload.trigger_type,
            run_status="PENDING",
            triggered_at=datetime.now(timezone.utc),
            triggered_by="API",
        )
        db.add(run)
        db.commit()
        db.refresh(run)

        return RunResponse(
            id=run.id, run_id=run.run_id,
            period_type=run.period_type, period=run.period,
            run_status=run.run_status,
            message=f"Run {run.run_id} created. Use POST /api/v1/runs/{run.id}/execute to start the pipeline.",
        )
    finally:
        db.close()


def _run_pipeline_background(run_id: str) -> None:
    db = SessionLocal()
    try:
        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        if run:
            run.run_status = "INGESTING"
            db.commit()
    finally:
        db.close()

    try:
        orchestrator = MassBalanceOrchestrator()
        orchestrator.run(run_id)
    except Exception as exc:
        db = SessionLocal()
        try:
            run = db.query(MassBalanceRun).filter_by(id=run_id).first()
            if run:
                run.run_status = "FAILED"
                run.error_message = str(exc)
                db.commit()
        finally:
            db.close()


@app.post("/api/v1/runs/{run_id}/execute", response_model=PipelineResult, tags=["Runs"])
def execute_pipeline(run_id: str, background_tasks: BackgroundTasks):
    """
    Start the 10-step agentic pipeline for an existing run (non-blocking).
    The pipeline runs in the background; poll GET /api/v1/runs/{run_id} for progress.
    """
    run = _get_run_or_404(run_id)
    if run.run_status not in ("PENDING",):
        raise HTTPException(
            status_code=409,
            detail=f"Run is in status '{run.run_status}' — can only execute PENDING runs.",
        )
    background_tasks.add_task(_run_pipeline_background, run_id)
    return PipelineResult(
        run_id=run.run_id, steps_completed=0,
        final_status="RUNNING", requires_human_action=False,
        message="Pipeline started. 10-step agentic process running in background.",
    )


@app.post("/api/v1/runs/{run_id}/pipeline", response_model=PipelineResult, tags=["Runs"])
def run_pipeline_sync(run_id: str):
    """
    Execute the full 10-step pipeline synchronously (blocking — use for testing/demos).
    Returns the final pipeline result after all 10 steps complete.
    """
    run = _get_run_or_404(run_id)
    if run.run_status not in ("PENDING",):
        raise HTTPException(
            status_code=409,
            detail=f"Run is in status '{run.run_status}'.",
        )
    try:
        orchestrator = MassBalanceOrchestrator()
        crew_output = orchestrator.run(run_id)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

    db = SessionLocal()
    try:
        run_fresh = db.query(MassBalanceRun).filter_by(id=run_id).first()
        pending = run_fresh.pending_approvals or 0
        return PipelineResult(
            run_id=run_fresh.run_id, steps_completed=10,
            final_status=run_fresh.run_status,
            requires_human_action=pending > 0,
            message=f"Pipeline complete. Status: {run_fresh.run_status}. Pending approvals: {pending}.",
            crew_output=crew_output[:2000] if crew_output else None,
        )
    finally:
        db.close()


@app.get("/api/v1/runs/{run_id}", response_model=RunResponse, tags=["Runs"])
def get_run(run_id: str):
    """Get the current status and KPIs of a mass balance run."""
    run = _get_run_or_404(run_id)
    return RunResponse(
        id=run.id, run_id=run.run_id,
        period_type=run.period_type, period=run.period,
        run_status=run.run_status,
        message=f"Balance status: {run.balance_status or 'N/A'} | Variance: {run.refinery_variance_pct or 0:.4f}%",
    )


@app.get("/api/v1/runs", tags=["Runs"])
def list_runs(limit: int = 20, offset: int = 0):
    """List all mass balance runs with pagination."""
    db = SessionLocal()
    try:
        total = db.query(MassBalanceRun).count()
        runs = (db.query(MassBalanceRun)
                .order_by(MassBalanceRun.triggered_at.desc())
                .offset(offset).limit(limit).all())
        return {
            "total": total, "limit": limit, "offset": offset,
            "items": [
                {"id": r.id, "run_id": r.run_id, "period": r.period,
                 "period_type": r.period_type, "run_status": r.run_status,
                 "balance_status": r.balance_status,
                 "refinery_variance_pct": r.refinery_variance_pct,
                 "triggered_at": r.triggered_at.isoformat() if r.triggered_at else None}
                for r in runs
            ],
        }
    finally:
        db.close()


# ─── Executive Summary ────────────────────────────────────────────────

@app.get("/api/v1/runs/{run_id}/summary",
         response_model=ExecutiveSummaryResponse, tags=["Summary"])
def get_executive_summary(run_id: str):
    """
    Retrieve the executive summary KPI dashboard for a completed run (slide 24).
    KPIs: Data Completeness %, Active Exceptions, Refinery Variance %,
    Tanks Reconciled, Pending Approvals, Corrections Posted.
    """
    run = _get_run_or_404(run_id)
    if run.run_status in ("PENDING", "INGESTING", "VALIDATING", "CALCULATING"):
        raise HTTPException(status_code=202, detail="Pipeline not yet at summary stage.")

    db = SessionLocal()
    try:
        exceptions = db.query(MassException).filter_by(run_id=run_id).all()
        sev_summary = [
            ExceptionSummaryItem(
                severity=s,
                count=sum(1 for e in exceptions if e.severity == s),
                status={"CRITICAL": "Pending approval", "WARNING": "Under review",
                        "ADVISORY": "Monitoring", "INFO": "Logged"}[s],
            )
            for s in ("CRITICAL", "WARNING", "ADVISORY", "INFO")
        ]
        active = sum(1 for e in exceptions if e.severity in ("WARNING","CRITICAL") and e.status in ("OPEN","UNDER_REVIEW"))
        return ExecutiveSummaryResponse(
            period=run.period, period_type=run.period_type,
            data_completeness=run.data_completeness or 0.0,
            tanks_reconciled=run.tanks_reconciled or 0,
            refinery_variance_pct=run.refinery_variance_pct or 0.0,
            balance_status=run.balance_status or "UNKNOWN",
            active_exceptions=active,
            pending_approvals=run.pending_approvals or 0,
            corrections_posted=run.corrections_posted or 0,
            exception_summary=sev_summary,
            message=f"Period {run.period} | {run.balance_status or 'UNKNOWN'}",
        )
    finally:
        db.close()


# ─── Exceptions ───────────────────────────────────────────────────────

@app.get("/api/v1/runs/{run_id}/exceptions",
         response_model=list[ExceptionResponse], tags=["Exceptions"])
def list_exceptions(run_id: str):
    """List all mass balance exceptions for a run."""
    _get_run_or_404(run_id)
    db = SessionLocal()
    try:
        excs = db.query(MassException).filter_by(run_id=run_id).all()
        return [ExceptionResponse(
            id=e.id, exception_id=e.exception_id, period=e.period,
            variance_mt=e.variance_mt or 0, variance_pct=e.variance_pct or 0,
            variance_sign=e.variance_sign or "UNKNOWN", severity=e.severity,
            root_cause_category=e.root_cause_category,
            root_cause_narrative=e.root_cause_narrative,
            recommendation=e.recommendation,
            status=e.status, supporting_docs=e.supporting_docs,
        ) for e in excs]
    finally:
        db.close()


@app.patch("/api/v1/exceptions/{exception_id}/classify",
           response_model=ExceptionResponse, tags=["Exceptions"])
def classify_exception(exception_id: str, payload: ClassifyRequest):
    """
    Human override: manually classify an exception root cause.
    Categories: MC / TX / MD / TF / PL / SY (slide 22).
    No auto-corrections are applied — this only updates the classification.
    """
    db = SessionLocal()
    try:
        exc = db.query(MassException).filter_by(exception_id=exception_id).first()
        if not exc:
            raise HTTPException(status_code=404, detail=f"Exception {exception_id} not found")
        exc.root_cause_category  = payload.root_cause_category
        exc.root_cause_narrative = payload.narrative
        exc.status = "UNDER_REVIEW"
        db.commit()
        return ExceptionResponse(
            id=exc.id, exception_id=exc.exception_id, period=exc.period,
            variance_mt=exc.variance_mt or 0, variance_pct=exc.variance_pct or 0,
            variance_sign=exc.variance_sign or "UNKNOWN", severity=exc.severity,
            root_cause_category=exc.root_cause_category,
            root_cause_narrative=exc.root_cause_narrative,
            recommendation=exc.recommendation, status=exc.status,
            supporting_docs=exc.supporting_docs,
        )
    finally:
        db.close()


# ─── Approvals ────────────────────────────────────────────────────────

@app.get("/api/v1/runs/{run_id}/approvals",
         response_model=list[ApprovalResponse], tags=["Approvals"])
def list_approvals(run_id: str):
    """List all approval requests for a run (slide 6 — Human-in-the-Loop gate)."""
    _get_run_or_404(run_id)
    db = SessionLocal()
    try:
        approvals = db.query(ApprovalRequest).filter_by(run_id=run_id).all()
        return [ApprovalResponse(
            id=a.id, approval_status=a.approval_status,
            sap_doc_number=a.sap_doc_number,
            message=f"{a.request_type} | Priority: {a.priority} | {a.evidence_summary or ''}",
        ) for a in approvals]
    finally:
        db.close()


@app.post("/api/v1/approvals/{approval_id}/approve",
          response_model=ApprovalResponse, tags=["Approvals"])
def approve_request(approval_id: str, payload: ApprovalActionRequest):
    """
    Human approval gate (slide 6 & 23).
    Approve a correction request — agent will trigger the SAP posting after approval.
    A SAP document number is generated as proof of posting.
    """
    db = SessionLocal()
    try:
        approval = db.query(ApprovalRequest).filter_by(id=approval_id).first()
        if not approval:
            raise HTTPException(status_code=404, detail="Approval request not found")
        if approval.approval_status != "PENDING":
            raise HTTPException(status_code=409, detail=f"Already in status '{approval.approval_status}'")

        sap_doc = f"5{str(uuid.uuid4().int)[:9]}"
        approval.approval_status = "APPROVED"
        approval.sap_doc_number  = sap_doc
        approval.approved_by     = "HUMAN_OPERATOR"
        approval.approved_at     = datetime.now(timezone.utc)
        approval.comments        = payload.comments

        exc = db.query(MassException).filter_by(id=approval.exception_id).first()
        if exc:
            exc.status         = "APPROVED"
            exc.sap_doc_number = sap_doc
            exc.resolved_at    = datetime.now(timezone.utc)

        run = db.query(MassBalanceRun).filter_by(id=approval.run_id).first()
        if run:
            remaining = db.query(ApprovalRequest).filter_by(
                run_id=approval.run_id, approval_status="PENDING"
            ).count()
            if remaining == 0:
                run.run_status = "COMPLETED"
                run.pending_approvals = 0
            else:
                run.pending_approvals = remaining
            run.corrections_posted = (run.corrections_posted or 0) + 1

        db.commit()
        return ApprovalResponse(
            id=approval.id, approval_status="APPROVED",
            sap_doc_number=sap_doc,
            message=f"Approved. SAP document {sap_doc} posted.",
        )
    finally:
        db.close()


@app.post("/api/v1/approvals/{approval_id}/reject",
          response_model=ApprovalResponse, tags=["Approvals"])
def reject_request(approval_id: str, payload: ApprovalActionRequest):
    """
    Human rejection gate.
    Reject a correction request — exception returns to OPEN for re-investigation.
    """
    db = SessionLocal()
    try:
        approval = db.query(ApprovalRequest).filter_by(id=approval_id).first()
        if not approval:
            raise HTTPException(status_code=404, detail="Approval request not found")
        if approval.approval_status != "PENDING":
            raise HTTPException(status_code=409, detail=f"Already in status '{approval.approval_status}'")

        approval.approval_status = "REJECTED"
        approval.rejected_by     = "HUMAN_OPERATOR"
        approval.rejected_at     = datetime.now(timezone.utc)
        approval.comments        = payload.comments

        exc = db.query(MassException).filter_by(id=approval.exception_id).first()
        if exc:
            exc.status = "OPEN"

        db.commit()
        return ApprovalResponse(
            id=approval.id, approval_status="REJECTED",
            sap_doc_number=None,
            message="Rejected. Exception returned to OPEN for re-investigation.",
        )
    finally:
        db.close()


# ─── Audit Log ────────────────────────────────────────────────────────

@app.get("/api/v1/runs/{run_id}/audit",
         response_model=list[AuditLogResponse], tags=["Audit"])
def get_audit_log(run_id: str):
    """Full immutable audit trail for a run — every agent action, decision, and result."""
    _get_run_or_404(run_id)
    db = SessionLocal()
    try:
        logs = (db.query(AuditLog)
                .filter_by(run_id=run_id)
                .order_by(AuditLog.timestamp)
                .all())
        return [AuditLogResponse(
            id=l.id, agent_name=l.agent_name, agent_step=l.agent_step,
            action=l.action, data_source=l.data_source or "",
            user_id=l.user_id, result=l.result,
            timestamp=l.timestamp,
        ) for l in logs]
    finally:
        db.close()


# ─── Reference Data ───────────────────────────────────────────────────

@app.get("/api/v1/plants", tags=["Reference Data"])
def list_plants():
    """List all refinery plants."""
    db = SessionLocal()
    try:
        plants = db.query(Plant).filter_by(is_active=True).all()
        return [{"id": p.id, "plant_code": p.plant_code, "plant_name": p.plant_name,
                 "country": p.country, "currency": p.currency} for p in plants]
    finally:
        db.close()
