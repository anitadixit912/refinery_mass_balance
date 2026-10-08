"""
SQLAlchemy 2.x data models for Refinery Mass Balance Reconciliation Agent.

Mirrors all five data domains from slide 14:
  TANK  — Tank Master (IDs, capacities, density/temp factors)
  MAT   — Material Data (MARA codes, UoM, density, product hierarchy)
  MOV   — Movements (GR/GI docs, MSEG/MKPF)
  PHYS  — Physical Inventory (dip gauge, MI01/MI07)
  BOOK  — Book Stock (SAP MM ledger, MARD)
"""

import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    create_engine, Column, String, Float, Integer, Boolean,
    DateTime, Text, ForeignKey, Enum as SAEnum
)
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker, Session
from sqlalchemy.sql import func
from dotenv import load_dotenv
import os

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./refinery.db")
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


# ─────────────────────────────────────────────────────────────────────
#  MASTER DATA
# ─────────────────────────────────────────────────────────────────────

class Plant(Base):
    """Refinery / plant master. Slide 12 — data sources per plant."""
    __tablename__ = "plants"

    id         = Column(String, primary_key=True, default=new_id)
    plant_code = Column(String(4), unique=True, nullable=False)
    plant_name = Column(String(80))
    country    = Column(String(3))
    region     = Column(String(50))
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime, default=utcnow)

    tanks      = relationship("Tank", back_populates="plant")
    tolerances = relationship("ToleranceConfig", back_populates="plant")
    runs       = relationship("MassBalanceRun", back_populates="plant")


class Material(Base):
    """
    MAT domain — Material master data (MARA).
    Material codes, UoM mapping, density & conversions, product group hierarchy.
    """
    __tablename__ = "materials"

    id             = Column(String, primary_key=True, default=new_id)
    material_code  = Column(String(18), unique=True, nullable=False)  # MARA-MATNR
    material_desc  = Column(String(100))
    base_uom       = Column(String(3), nullable=False)  # MT / BBL / KL
    product_group  = Column(String(20))
    material_group = Column(String(2))  # CR / LD / FP / SB / RS / GP
    density        = Column(Float)      # kg/L at 15°C reference
    api_gravity    = Column(Float)
    flash_point    = Column(Float)      # °C
    is_active      = Column(Boolean, default=True)
    created_at     = Column(DateTime, default=utcnow)


class Tank(Base):
    """
    TANK domain — Tank Master Data.
    Tank IDs, capacities, material associations, plant/storage loc, density/temp factors.
    """
    __tablename__ = "tanks"

    id              = Column(String, primary_key=True, default=new_id)
    tank_id         = Column(String(20), nullable=False)  # e.g. T-1001
    tank_name       = Column(String(80))
    plant_id        = Column(String, ForeignKey("plants.id"))
    material_id     = Column(String, ForeignKey("materials.id"))  # primary material
    storage_loc     = Column(String(4))
    capacity        = Column(Float)        # MT
    density_factor  = Column(Float)        # kg/L at reference temp
    temp_corr_factor= Column(Float)        # volumetric temperature correction
    tank_type       = Column(String(20))   # CRUDE / PRODUCT / BLEND / SLOPS / INTERMEDIATE
    is_active       = Column(Boolean, default=True)
    created_at      = Column(DateTime, default=utcnow)

    plant    = relationship("Plant", back_populates="tanks")
    material = relationship("Material")


class ToleranceConfig(Base):
    """
    Configurable Tolerance Matrix — slide 21.
      Refinery / All Products    → Daily ±0.20%  Monthly ±0.10%
      Plant / Crude/Residual     → Daily ±0.15%  Monthly ±0.08%
      Tank / Light Distillates   → Daily ±0.10%  Monthly ±0.05%
      Tank / Finished Products   → Daily ±0.12%  Monthly ±0.06%
      Material / Specialty/Blends→ Daily ±0.08%  Monthly ±0.04%
    """
    __tablename__ = "tolerance_config"

    id                 = Column(String, primary_key=True, default=new_id)
    level              = Column(String(10))   # REFINERY / PLANT / TANK / MATERIAL
    plant_id           = Column(String, ForeignKey("plants.id"), nullable=True)
    material_group     = Column(String(2), nullable=True)
    daily_tolerance    = Column(Float)        # fraction e.g. 0.002 = 0.20%
    monthly_tolerance  = Column(Float)
    escalation_action  = Column(String(100))
    escalation_role    = Column(String(50))
    is_active          = Column(Boolean, default=True)

    plant = relationship("Plant", back_populates="tolerances")


# ─────────────────────────────────────────────────────────────────────
#  MASS BALANCE RUN  (10-step agentic process — slide 16)
# ─────────────────────────────────────────────────────────────────────

class MassBalanceRun(Base):
    """
    Header record for one execution of the 10-step agentic pipeline.
    DAILY (YYYY-MM-DD) or MONTHLY (YYYY-MM).
    """
    __tablename__ = "mass_balance_runs"

    id                  = Column(String, primary_key=True, default=new_id)
    run_id              = Column(String(30), unique=True)
    period_type         = Column(String(7))   # DAILY / MONTHLY
    period              = Column(String(10))  # YYYY-MM-DD or YYYY-MM
    plant_id            = Column(String, ForeignKey("plants.id"))

    run_status          = Column(String(15), default="INITIATED")
    # INITIATED→INGESTING→VALIDATING→CALCULATING→RECONCILING→COMPARING
    # →CHECKING_TOL→INVESTIGATING→CLASSIFYING→REPORTING→SUMMARISING
    # →PENDING_APPR→COMPLETED / FAILED

    # Executive Summary KPIs — slide 24
    data_completeness    = Column(Float, default=0.0)   # %
    tanks_reconciled     = Column(Integer, default=0)
    refinery_variance_pct= Column(Float, default=0.0)
    balance_status       = Column(String(20), default="PENDING")
    corrections_posted   = Column(Integer, default=0)
    pending_approvals    = Column(Integer, default=0)

    trigger_type        = Column(String(20), default="MANUAL")
    triggered_by        = Column(String(50))
    created_at          = Column(DateTime, default=utcnow)
    updated_at          = Column(DateTime, default=utcnow, onupdate=utcnow)

    plant               = relationship("Plant", back_populates="runs")
    balance_lines       = relationship("MassBalanceLine", back_populates="run", cascade="all, delete-orphan")
    exceptions          = relationship("MassException", back_populates="run", cascade="all, delete-orphan")
    audit_logs          = relationship("AuditLog", back_populates="run", cascade="all, delete-orphan")
    approval_requests   = relationship("ApprovalRequest", back_populates="run", cascade="all, delete-orphan")
    validation_issues   = relationship("ValidationIssue", back_populates="run", cascade="all, delete-orphan")
    movements           = relationship("MaterialMovement", back_populates="run", cascade="all, delete-orphan")
    physical_inventories= relationship("PhysicalInventory", back_populates="run", cascade="all, delete-orphan")
    book_stocks         = relationship("BookStockSnapshot", back_populates="run", cascade="all, delete-orphan")


# ─────────────────────────────────────────────────────────────────────
#  STEP 02 — Validation Issues  (slide 18)
# ─────────────────────────────────────────────────────────────────────

class ValidationIssue(Base):
    """
    Validation check results (Step 02).
    Three categories: COMPLETENESS | CONSISTENCY | REFERENTIAL.
    Agent does NOT proceed to calculation if BLOCKER issues exist (slide 18).
    """
    __tablename__ = "validation_issues"

    id             = Column(String, primary_key=True, default=new_id)
    run_id         = Column(String, ForeignKey("mass_balance_runs.id"))
    check_category = Column(String(20))   # COMPLETENESS / CONSISTENCY / REFERENTIAL
    check_name     = Column(String(100))
    entity_type    = Column(String(50))
    entity_ref     = Column(String(50))
    issue_desc     = Column(Text)
    severity       = Column(String(10))   # INFO / WARNING / BLOCKER
    is_resolved    = Column(Boolean, default=False)
    created_at     = Column(DateTime, default=utcnow)

    run = relationship("MassBalanceRun", back_populates="validation_issues")


# ─────────────────────────────────────────────────────────────────────
#  MOV domain — Material Movements  (slide 14: MSEG/MKPF)
# ─────────────────────────────────────────────────────────────────────

class MaterialMovement(Base):
    """
    MOV domain: GR/GI documents, internal transfers, production confirmations,
    consumption bookings. SAP tables MSEG/MKPF.
    """
    __tablename__ = "material_movements"

    id               = Column(String, primary_key=True, default=new_id)
    run_id           = Column(String, ForeignKey("mass_balance_runs.id"))
    doc_number       = Column(String(10))   # MKPF
    line_item        = Column(String(4))    # MSEG
    material_id      = Column(String, ForeignKey("materials.id"))
    plant_id         = Column(String, ForeignKey("plants.id"))
    tank_id          = Column(String, ForeignKey("tanks.id"))
    storage_loc      = Column(String(4))
    movement_type    = Column(String(3))    # SAP movement type (101, 201, 261…)
    movement_category= Column(String(15))   # GR/GI/TRANSFER/PRODUCTION/CONSUMPTION/BLENDING/PIPELINE
    posting_date     = Column(String(10))
    quantity         = Column(Float)
    uom              = Column(String(3))
    quantity_mt      = Column(Float)        # normalised to MT
    batch_number     = Column(String(10))
    sending_tank_id  = Column(String, ForeignKey("tanks.id"), nullable=True)
    receiving_tank_id= Column(String, ForeignKey("tanks.id"), nullable=True)
    reference_doc    = Column(String(10))
    is_reversed      = Column(Boolean, default=False)
    is_duplicate     = Column(Boolean, default=False)
    created_at       = Column(DateTime, default=utcnow)

    run      = relationship("MassBalanceRun", back_populates="movements")
    material = relationship("Material")
    plant    = relationship("Plant")
    tank     = relationship("Tank", foreign_keys=[tank_id])


# ─────────────────────────────────────────────────────────────────────
#  PHYS domain — Physical Inventory Documents  (slide 14: MI01/MI07)
# ─────────────────────────────────────────────────────────────────────

class PhysicalInventory(Base):
    """
    PHYS domain: dip gauge readings, temperature, volume→MT conversion.
    SAP documents MI01/MI07. Source: ATG / manual / SCADA.
    """
    __tablename__ = "physical_inventories"

    id             = Column(String, primary_key=True, default=new_id)
    run_id         = Column(String, ForeignKey("mass_balance_runs.id"))
    doc_number     = Column(String(10))   # MI01/MI07
    doc_type       = Column(String(6))    # MI01 / MI07 / MANUAL
    tank_id        = Column(String, ForeignKey("tanks.id"))
    material_id    = Column(String, ForeignKey("materials.id"))
    plant_id       = Column(String, ForeignKey("plants.id"))
    storage_loc    = Column(String(4))
    reading_date   = Column(String(10))
    reading_time   = Column(String(8))
    source         = Column(String(10))   # ATG / MANUAL / SCADA
    dip_reading    = Column(Float)        # raw volume
    temperature    = Column(Float)        # °C
    density        = Column(Float)        # kg/L at observed temp
    api_gravity    = Column(Float)
    water_bottom   = Column(Float)        # MT to deduct
    quantity_mt    = Column(Float)        # after density + temp correction
    quantity_bbl   = Column(Float)
    is_final       = Column(Boolean, default=False)
    is_verified    = Column(Boolean, default=False)
    created_at     = Column(DateTime, default=utcnow)

    run      = relationship("MassBalanceRun", back_populates="physical_inventories")
    tank     = relationship("Tank")
    material = relationship("Material")
    plant    = relationship("Plant")


# ─────────────────────────────────────────────────────────────────────
#  BOOK domain — Book Stock Snapshots  (slide 14: MARD)
# ─────────────────────────────────────────────────────────────────────

class BookStockSnapshot(Base):
    """
    BOOK domain: SAP MM stock ledger (MARD), batch quantities, valuation class,
    period-end balances.
    """
    __tablename__ = "book_stock_snapshots"

    id               = Column(String, primary_key=True, default=new_id)
    run_id           = Column(String, ForeignKey("mass_balance_runs.id"))
    material_id      = Column(String, ForeignKey("materials.id"))
    plant_id         = Column(String, ForeignKey("plants.id"))
    tank_id          = Column(String, ForeignKey("tanks.id"))
    storage_loc      = Column(String(4))
    snapshot_date    = Column(String(10))
    snapshot_time    = Column(String(8))
    unrestricted     = Column(Float, default=0.0)   # MT
    qual_inspection  = Column(Float, default=0.0)
    blocked          = Column(Float, default=0.0)
    in_transit       = Column(Float, default=0.0)
    total_book       = Column(Float, default=0.0)
    batch_number     = Column(String(10))
    valuation_class  = Column(String(4))
    period_end_balance= Column(Float, default=0.0)
    is_period_close  = Column(Boolean, default=False)
    created_at       = Column(DateTime, default=utcnow)

    run      = relationship("MassBalanceRun", back_populates="book_stocks")
    material = relationship("Material")
    plant    = relationship("Plant")
    tank     = relationship("Tank")


# ─────────────────────────────────────────────────────────────────────
#  STEPS 03–06 — Mass Balance Line  (slides 19–21)
#
#  Formula (slide 19):
#  Closing = Opening + Receipts − Issues − Consumption ± Transfers ± Adjustments
# ─────────────────────────────────────────────────────────────────────

class MassBalanceLine(Base):
    """
    One balance calculation line per tank+material per period.
    Holds both the book calculation and physical comparison result.
    """
    __tablename__ = "mass_balance_lines"

    id              = Column(String, primary_key=True, default=new_id)
    run_id          = Column(String, ForeignKey("mass_balance_runs.id"))
    plant_id        = Column(String, ForeignKey("plants.id"))
    tank_id         = Column(String, ForeignKey("tanks.id"))
    material_id     = Column(String, ForeignKey("materials.id"))

    # Step 03 — Mass Balance Formula components (MT)
    opening_stock   = Column(Float, default=0.0)
    receipts        = Column(Float, default=0.0)
    issues          = Column(Float, default=0.0)
    transfers       = Column(Float, default=0.0)   # signed (+ in / − out)
    production      = Column(Float, default=0.0)
    consumption     = Column(Float, default=0.0)
    by_products     = Column(Float, default=0.0)
    blending_inputs = Column(Float, default=0.0)
    blending_outputs= Column(Float, default=0.0)
    adjustments     = Column(Float, default=0.0)   # approval-gated
    closing_book    = Column(Float, default=0.0)   # calculated book stock

    # Step 05 — Physical vs Book  (slide 20)
    closing_physical= Column(Float, default=0.0)   # dip reading converted to MT
    dip_reading     = Column(Float, default=0.0)   # raw volume
    temperature     = Column(Float, default=15.0)  # °C
    density         = Column(Float)
    water_bottom    = Column(Float, default=0.0)   # MT deducted

    # Variance = Physical − Book  (positive = EXCESS, negative = SHORTAGE)
    variance        = Column(Float, default=0.0)
    variance_pct    = Column(Float, default=0.0)

    # Step 06 — Tolerance check result (slide 21)
    severity        = Column(String(10), default="INFO")
    # INFO / ADVISORY (50-100%) / WARNING (100-150%) / CRITICAL (>150%)
    reconcil_level  = Column(String(10), default="TANK")  # PLANT / TANK / MATERIAL
    created_at      = Column(DateTime, default=utcnow)

    run      = relationship("MassBalanceRun", back_populates="balance_lines")
    plant    = relationship("Plant")
    tank     = relationship("Tank")
    material = relationship("Material")


# ─────────────────────────────────────────────────────────────────────
#  STEPS 07–09 — Exception  (slides 22–23)
# ─────────────────────────────────────────────────────────────────────

class MassException(Base):
    """
    Evidence-based exception record (Step 09 — slide 23).
    Root cause categories (Step 08 — slide 22):
      MC — Measurement Error
      TX — Transaction Error
      MD — Master Data Issue
      TF — Transfer / Routing
      PL — Physical Loss / Gain
      SY — System / Interface
    """
    __tablename__ = "mass_exceptions"

    id                  = Column(String, primary_key=True, default=new_id)
    exception_id        = Column(String(20), unique=True)  # EXC-YYYYMM-NNNN
    run_id              = Column(String, ForeignKey("mass_balance_runs.id"))
    balance_line_id     = Column(String, ForeignKey("mass_balance_lines.id"), nullable=True)
    plant_id            = Column(String, ForeignKey("plants.id"))
    tank_id             = Column(String, ForeignKey("tanks.id"), nullable=True)
    material_id         = Column(String, ForeignKey("materials.id"), nullable=True)

    period              = Column(String(10))
    period_type         = Column(String(7))

    # Variance metrics (slide 23)
    variance_mt         = Column(Float)
    variance_pct        = Column(Float)
    variance_sign       = Column(String(10))   # EXCESS / SHORTAGE

    # Severity (slide 21)
    severity            = Column(String(10))   # INFO/ADVISORY/WARNING/CRITICAL

    # Root Cause (slide 22)
    root_cause_category = Column(String(2), nullable=True)  # MC/TX/MD/TF/PL/SY
    root_cause_narrative= Column(Text, nullable=True)
    recommendation      = Column(Text, nullable=True)

    # Investigation evidence (slide 22)
    investigation_log   = Column(Text, nullable=True)
    supporting_docs     = Column(String(500), nullable=True)  # MSEG/MKPF/MI07 numbers
    related_movements   = Column(String(500), nullable=True)

    # Status (slide 23)
    status              = Column(String(15), default="OPEN")
    # OPEN / UNDER_REVIEW / APPROVED / CLOSED / REJECTED
    assigned_to         = Column(String(50), nullable=True)
    reviewed_by         = Column(String(50), nullable=True)
    reviewed_at         = Column(DateTime, nullable=True)
    approved_by         = Column(String(50), nullable=True)
    approved_at         = Column(DateTime, nullable=True)
    closing_comments    = Column(String(500), nullable=True)
    created_at          = Column(DateTime, default=utcnow)

    run          = relationship("MassBalanceRun", back_populates="exceptions")
    balance_line = relationship("MassBalanceLine")
    plant        = relationship("Plant")
    approvals    = relationship("ApprovalRequest", back_populates="exception", cascade="all, delete-orphan")


# ─────────────────────────────────────────────────────────────────────
#  APPROVAL REQUEST  (Human-in-the-Loop — slides 6 & 23)
#
#  No automatic corrections. Every stock adjustment, transaction
#  correction, or posting requires explicit user approval.
# ─────────────────────────────────────────────────────────────────────

class ApprovalRequest(Base):
    """
    Approval-gated correction governance (slide 23).
    Agent NEVER automatically posts adjustments.
    """
    __tablename__ = "approval_requests"

    id              = Column(String, primary_key=True, default=new_id)
    run_id          = Column(String, ForeignKey("mass_balance_runs.id"))
    exception_id    = Column(String, ForeignKey("mass_exceptions.id"), nullable=True)
    request_type    = Column(String(25))   # STOCK_ADJUSTMENT/CORRECTION_POSTING/ESCALATION
    proposed_action = Column(Text)
    evidence_summary= Column(Text)
    priority        = Column(String(10), default="MEDIUM")  # LOW/MEDIUM/HIGH/URGENT
    requested_by    = Column(String(50))
    requested_at    = Column(DateTime, default=utcnow)
    approval_status = Column(String(10), default="PENDING")  # PENDING/APPROVED/REJECTED
    approved_by     = Column(String(50), nullable=True)
    approved_at     = Column(DateTime, nullable=True)
    comments        = Column(String(500), nullable=True)
    sap_doc_number  = Column(String(10), nullable=True)
    created_at      = Column(DateTime, default=utcnow)

    run       = relationship("MassBalanceRun", back_populates="approval_requests")
    exception = relationship("MassException", back_populates="approvals")


# ─────────────────────────────────────────────────────────────────────
#  AUDIT LOG  (Full Audit Trail — slide 6)
#  Every agent action logged with timestamp, data source, decision rationale.
# ─────────────────────────────────────────────────────────────────────

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id                  = Column(String, primary_key=True, default=new_id)
    run_id              = Column(String, ForeignKey("mass_balance_runs.id"))
    timestamp           = Column(DateTime, default=utcnow)
    agent_name          = Column(String(50))
    agent_step          = Column(String(40))
    action              = Column(String(200))
    data_source         = Column(String(50))
    decision_rationale  = Column(Text)
    input_summary       = Column(Text, nullable=True)
    output_summary      = Column(Text, nullable=True)
    user_id             = Column(String(50))
    result              = Column(String(10))  # SUCCESS / WARNING / FAILURE / SKIPPED
    duration_ms         = Column(Integer, nullable=True)

    run = relationship("MassBalanceRun", back_populates="audit_logs")


# Create all tables
def init_db():
    Base.metadata.create_all(bind=engine)
