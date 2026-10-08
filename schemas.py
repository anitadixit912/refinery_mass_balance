"""Pydantic schemas for FastAPI request/response models."""

from __future__ import annotations
from datetime import datetime
from typing import Optional, List, Any
from pydantic import BaseModel, Field


# ── Runs ─────────────────────────────────────────────────────────────

class TriggerRunRequest(BaseModel):
    period_type : str = Field(..., examples=["DAILY", "MONTHLY"])
    period      : str = Field(..., examples=["2026-10-08", "2026-10"])
    plant_code  : str = Field(..., examples=["R001"])
    trigger_type: str = Field(default="MANUAL", examples=["MANUAL", "SCHEDULED"])


class RunResponse(BaseModel):
    id          : str
    run_id      : str
    period_type : str
    period      : str
    run_status  : str
    message     : str = ""

    class Config:
        from_attributes = True


class PipelineResult(BaseModel):
    run_id              : str
    steps_completed     : int
    final_status        : str
    requires_human_action: bool
    message             : str
    crew_output         : Optional[str] = None


# ── Exceptions ───────────────────────────────────────────────────────

class ExceptionResponse(BaseModel):
    id                  : str
    exception_id        : str
    period              : str
    variance_mt         : float
    variance_pct        : float
    variance_sign       : str
    severity            : str
    root_cause_category : Optional[str]
    root_cause_narrative: Optional[str]
    recommendation      : Optional[str]
    status              : str
    supporting_docs     : Optional[str]

    class Config:
        from_attributes = True


class ClassifyRequest(BaseModel):
    exception_id      : str
    root_cause_category: str = Field(..., examples=["MC", "TX", "MD", "TF", "PL", "SY"])
    narrative         : str


class SubmitApprovalRequest(BaseModel):
    exception_id   : str
    proposed_action: str
    priority       : str = Field(default="MEDIUM", examples=["LOW","MEDIUM","HIGH","URGENT"])


# ── Approvals ────────────────────────────────────────────────────────

class ApprovalActionRequest(BaseModel):
    comments: str


class ApprovalResponse(BaseModel):
    id             : str
    approval_status: str
    sap_doc_number : Optional[str]
    message        : str

    class Config:
        from_attributes = True


# ── Executive Summary ────────────────────────────────────────────────

class ExceptionSummaryItem(BaseModel):
    severity: str
    count   : int
    status  : str


class ExecutiveSummaryResponse(BaseModel):
    period               : str
    period_type          : str
    data_completeness    : float
    tanks_reconciled     : int
    refinery_variance_pct: float
    balance_status       : str
    active_exceptions    : int
    pending_approvals    : int
    corrections_posted   : int
    exception_summary    : List[ExceptionSummaryItem]
    message              : str


# ── Audit Log ────────────────────────────────────────────────────────

class AuditLogResponse(BaseModel):
    id                 : str
    agent_name         : str
    agent_step         : str
    action             : str
    data_source        : str
    user_id            : str
    result             : str
    timestamp          : datetime

    class Config:
        from_attributes = True
