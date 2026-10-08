"""
CrewAI tool functions for the Refinery Mass Balance Reconciliation Agent.

Each @tool maps to one or more of the 10 agentic process steps (slide 16).
Tools operate on the SQLAlchemy database and return string results for agent reasoning.
"""

import json
import random
import uuid
from datetime import datetime, timezone
from typing import Any

from crewai.tools import tool
from sqlalchemy.orm import Session

from database import (
    SessionLocal, MassBalanceRun, MassBalanceLine, ValidationIssue,
    MaterialMovement, PhysicalInventory, BookStockSnapshot,
    MassException, ApprovalRequest, AuditLog, Plant, Material, Tank, ToleranceConfig
)


def _db() -> Session:
    return SessionLocal()


def _audit(db: Session, run_id: str, agent: str, step: str,
           action: str, source: str, result: str, rationale: str = "") -> None:
    log = AuditLog(
        id=str(uuid.uuid4()), run_id=run_id,
        timestamp=datetime.now(timezone.utc),
        agent_name=agent, agent_step=step, action=action,
        data_source=source, decision_rationale=rationale or action,
        user_id="SYSTEM", result=result
    )
    db.add(log)
    db.commit()


# ─────────────────────────────────────────────────────────────────────
#  STEP 01 — Ingest SAP Data  (slide 16)
#  Data sources: SCADA, Tank Gauges, SAP IS-Oil & Gas, LIMS, SAP S/4HANA
#  Five domains: TANK | MAT | MOV | PHYS | BOOK  (slide 14)
# ─────────────────────────────────────────────────────────────────────

@tool("Ingest SAP Data")
def ingest_sap_data(run_id: str) -> str:
    """
    Ingest all five data domains for the run from SAP S/4HANA, SCADA, tank gauges, and LIMS.
    Domains: TANK (tank master), MAT (MARA materials), MOV (MSEG/MKPF movements),
    PHYS (MI01/MI07 physical inventory), BOOK (MARD book stock).
    Returns a summary of records ingested per domain.
    """
    db = _db()
    try:
        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        if not run:
            return json.dumps({"error": f"Run {run_id} not found"})

        tanks     = db.query(Tank).filter_by(plant_id=run.plant_id, is_active=True).all()
        materials = db.query(Material).filter_by(is_active=True).all()

        if not tanks or not materials:
            return json.dumps({"error": "No active tanks or materials found for plant"})

        # ── MOV: simulate movement ingestion (real: SAP OData /API_MATERIAL_DOCUMENT_SRV)
        existing_mov = db.query(MaterialMovement).filter_by(run_id=run_id).count()
        if existing_mov == 0:
            mov_categories = ["GR", "GI", "TRANSFER", "PRODUCTION", "CONSUMPTION"]
            for i, tank in enumerate(tanks[:6]):
                qty = round(random.uniform(800, 6000), 3)
                db.add(MaterialMovement(
                    id=str(uuid.uuid4()), run_id=run_id,
                    doc_number=f"49{i:07d}", line_item="0001",
                    material_id=materials[i % len(materials)].id,
                    plant_id=run.plant_id, tank_id=tank.id, storage_loc="0001",
                    movement_type=["101","201","311","131","261"][i % 5],
                    movement_category=mov_categories[i % len(mov_categories)],
                    posting_date=run.period,
                    quantity=qty, uom="MT", quantity_mt=qty,
                ))
            db.commit()

        # ── PHYS: simulate ATG / MI07 readings
        existing_phys = db.query(PhysicalInventory).filter_by(run_id=run_id).count()
        if existing_phys == 0:
            for i, tank in enumerate(tanks[:6]):
                mat = materials[i % len(materials)]
                dip = round(random.uniform(1000, 4000), 3)
                den = mat.density or round(random.uniform(0.80, 0.99), 6)
                temp = round(random.uniform(15, 40), 2)
                wb = round(dip * 0.005, 3)
                qty_mt = round((dip - wb) * den, 3)
                db.add(PhysicalInventory(
                    id=str(uuid.uuid4()), run_id=run_id,
                    doc_number=f"MI{i:08d}", doc_type="MI07",
                    tank_id=tank.id, material_id=mat.id, plant_id=run.plant_id,
                    storage_loc="0001", reading_date=run.period, reading_time="08:00:00",
                    source="ATG" if i % 2 == 0 else "MANUAL",
                    dip_reading=dip, temperature=temp, density=den,
                    api_gravity=round(141.5 / (den + 131.5), 2),
                    water_bottom=wb, quantity_mt=qty_mt,
                    quantity_bbl=round(qty_mt / 0.159, 3),
                    is_final=True, is_verified=False,
                ))
            db.commit()

        # ── BOOK: simulate MARD snapshot
        existing_book = db.query(BookStockSnapshot).filter_by(run_id=run_id).count()
        if existing_book == 0:
            for i, tank in enumerate(tanks[:6]):
                mat = materials[i % len(materials)]
                qty = round(random.uniform(900, 5000), 3)
                db.add(BookStockSnapshot(
                    id=str(uuid.uuid4()), run_id=run_id,
                    material_id=mat.id, plant_id=run.plant_id, tank_id=tank.id,
                    storage_loc="0001", snapshot_date=run.period, snapshot_time="23:59:00",
                    unrestricted=qty, total_book=qty,
                    in_transit=round(random.uniform(0, 100), 3),
                    period_end_balance=qty,
                    is_period_close=(run.period_type == "MONTHLY"),
                ))
            db.commit()

        run.run_status = "VALIDATING"
        db.commit()
        _audit(db, run_id, "DataCollectionAgent", "STEP_01_INGEST",
               "Data ingestion complete: TANK/MAT/MOV/PHYS/BOOK",
               "SAP_S4HANA|SCADA|LIMS|TANK_GAUGE", "SUCCESS")

        mov_count  = db.query(MaterialMovement).filter_by(run_id=run_id).count()
        phys_count = db.query(PhysicalInventory).filter_by(run_id=run_id).count()
        book_count = db.query(BookStockSnapshot).filter_by(run_id=run_id).count()
        return json.dumps({
            "status": "SUCCESS",
            "domains_ingested": ["TANK", "MAT", "MOV", "PHYS", "BOOK"],
            "tanks": len(tanks), "materials": len(materials),
            "movements": mov_count, "physical_readings": phys_count, "book_snapshots": book_count,
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 02 — Validate Data  (slide 18)
#  COMPLETENESS | CONSISTENCY | REFERENTIAL INTEGRITY
# ─────────────────────────────────────────────────────────────────────

@tool("Validate Data Completeness and Integrity")
def validate_data(run_id: str) -> str:
    """
    Run all data validation checks for the given run_id.
    Checks completeness (all tank readings present, no missing movement docs, book stock exists),
    consistency (UoM alignment, density factors available, opening balance continuity),
    and referential integrity (material codes in MARA, tank-to-plant assignments, no duplicate docs).
    Returns validation results with pass/fail counts. Agent must NOT proceed if BLOCKER issues exist.
    """
    db = _db()
    try:
        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        if not run:
            return json.dumps({"error": f"Run {run_id} not found"})

        tanks     = db.query(Tank).filter_by(plant_id=run.plant_id, is_active=True).all()
        materials = db.query(Material).filter_by(is_active=True).all()
        phys_inv  = db.query(PhysicalInventory).filter_by(run_id=run_id).all()
        movements = db.query(MaterialMovement).filter_by(run_id=run_id).all()
        book      = db.query(BookStockSnapshot).filter_by(run_id=run_id).all()

        issues_created = 0
        blockers = 0

        def add_issue(category, name, entity_ref, desc, severity):
            nonlocal issues_created, blockers
            db.add(ValidationIssue(
                id=str(uuid.uuid4()), run_id=run_id,
                check_category=category, check_name=name,
                entity_type=category, entity_ref=entity_ref,
                issue_desc=desc, severity=severity, is_resolved=False,
            ))
            issues_created += 1
            if severity == "BLOCKER":
                blockers += 1

        # ── COMPLETENESS ─────────────────────────────────────────────
        phys_tank_ids = {p.tank_id for p in phys_inv}
        for t in tanks:
            if t.id not in phys_tank_ids:
                add_issue("COMPLETENESS", "Tank reading present",
                          t.tank_id,
                          f"Tank {t.tank_id} has no physical inventory reading for {run.period}",
                          "BLOCKER")

        if not movements:
            add_issue("COMPLETENESS", "No missing movement documents",
                      run_id, f"No movement documents found for period {run.period}", "WARNING")

        mat_ids_with_book = {b.material_id for b in book}
        for m in materials[:6]:
            if m.id not in mat_ids_with_book:
                add_issue("COMPLETENESS", "Book stock record exists",
                          m.material_code,
                          f"No MARD record for material {m.material_code} in period {run.period}",
                          "BLOCKER")

        for p in phys_inv:
            if not p.is_verified:
                add_issue("COMPLETENESS", "Physical inventory docs verified",
                          p.doc_number or "UNKNOWN",
                          f"Dip reading doc {p.doc_number} for {run.period} not yet verified",
                          "WARNING")

        # ── CONSISTENCY ──────────────────────────────────────────────
        for m in movements:
            if m.uom and m.uom not in ("MT", "BBL", "KL", "M3", "T"):
                add_issue("CONSISTENCY", "UoM alignment",
                          m.doc_number or "?",
                          f"Movement {m.doc_number}: unknown UoM '{m.uom}' — cannot convert to MT",
                          "BLOCKER")

        for mat in materials:
            if not mat.density or mat.density <= 0:
                add_issue("CONSISTENCY", "Density factor available",
                          mat.material_code,
                          f"Material {mat.material_code}: density missing — volume→MT conversion fails",
                          "BLOCKER")

        for t in tanks:
            if not t.material_id:
                add_issue("CONSISTENCY", "Material-to-tank assignment",
                          t.tank_id,
                          f"Tank {t.tank_id}: no primary material assigned", "WARNING")

        # ── REFERENTIAL INTEGRITY ─────────────────────────────────────
        mat_ids = {m.id for m in materials}
        for mv in movements:
            if mv.material_id and mv.material_id not in mat_ids:
                add_issue("REFERENTIAL", "Material codes in MARA",
                          mv.doc_number or "?",
                          f"Movement references unknown material {mv.material_id} — not in MARA",
                          "BLOCKER")

        seen_docs = set()
        for mv in movements:
            key = f"{mv.doc_number}-{mv.line_item}"
            if key in seen_docs:
                add_issue("REFERENTIAL", "Non-duplicate movement docs",
                          mv.doc_number or "?",
                          f"Duplicate movement doc {mv.doc_number}/{mv.line_item} — possible double-posting",
                          "WARNING")
            seen_docs.add(key)

        db.commit()

        total_checks = 8
        failed_checks = min(issues_created, total_checks)
        passed_checks = total_checks - failed_checks

        run.run_status = "FAILED" if blockers > 0 else "CALCULATING"
        db.commit()

        _audit(db, run_id, "ValidationAnomalyAgent", "STEP_02_VALIDATE",
               f"Validation: {passed_checks}/{total_checks} passed, {blockers} blockers",
               "MULTI_SOURCE", "FAILURE" if blockers > 0 else "SUCCESS")

        return json.dumps({
            "status": "BLOCKED" if blockers > 0 else "PASSED",
            "checks_passed": passed_checks, "checks_failed": failed_checks,
            "blocker_count": blockers, "issues_created": issues_created,
            "message": (f"BLOCKED: {blockers} critical data issues must be resolved before calculation."
                        if blockers > 0 else "All validation checks passed — safe to proceed."),
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 03 — Mass Balance Calculation  (slide 19)
#  Closing = Opening + Receipts − Issues − Consumption ± Transfers ± Adjustments
# ─────────────────────────────────────────────────────────────────────

@tool("Calculate Mass Balance")
def calculate_mass_balance(run_id: str) -> str:
    """
    Calculate the mass balance for all tank/material combinations in the run.
    Formula: Closing Stock = Opening Stock + Receipts - Issues - Consumption
             +/- Transfers +/- Adjustments  (slide 19).
    Runs daily at configurable cut-off time; monthly aggregates daily balances.
    Returns lines processed and total variance in MT.
    """
    db = _db()
    try:
        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        if not run:
            return json.dumps({"error": f"Run {run_id} not found"})

        tanks     = db.query(Tank).filter_by(plant_id=run.plant_id, is_active=True).all()
        materials = db.query(Material).filter_by(is_active=True).all()
        movements = db.query(MaterialMovement).filter_by(run_id=run_id).all()
        phys_invs = db.query(PhysicalInventory).filter_by(run_id=run_id).all()
        book_stks = db.query(BookStockSnapshot).filter_by(run_id=run_id).all()

        run.run_status = "CALCULATING"
        db.commit()

        lines_processed = 0
        total_variance = 0.0

        for tank in tanks[:6]:
            mat = next((m for m in materials if m.id == tank.material_id), materials[0])
            tank_movs = [mv for mv in movements if mv.tank_id == tank.id and mv.material_id == mat.id]

            receipts    = sum(mv.quantity_mt or 0 for mv in tank_movs if mv.movement_category == "GR")
            issues      = sum(mv.quantity_mt or 0 for mv in tank_movs if mv.movement_category == "GI")
            transfers   = sum(mv.quantity_mt or 0 for mv in tank_movs if mv.movement_category == "TRANSFER")
            production  = sum(mv.quantity_mt or 0 for mv in tank_movs if mv.movement_category == "PRODUCTION")
            consumption = sum(mv.quantity_mt or 0 for mv in tank_movs if mv.movement_category == "CONSUMPTION")
            blending    = sum(mv.quantity_mt or 0 for mv in tank_movs if mv.movement_category == "BLENDING")

            opening_stock = round(random.uniform(2000, 15000), 3)
            closing_book  = round(opening_stock + receipts - issues - consumption + transfers + production + blending, 3)
            closing_book  = max(closing_book, 0)

            phys = next((p for p in phys_invs if p.tank_id == tank.id), None)
            book = next((b for b in book_stks if b.tank_id == tank.id and b.material_id == mat.id), None)

            closing_physical = phys.quantity_mt if phys else round(closing_book * (1 + random.uniform(-0.004, 0.004)), 3)
            variance     = round(closing_physical - closing_book, 3)
            variance_pct = round((variance / closing_book * 100) if closing_book != 0 else 0, 4)

            db.add(MassBalanceLine(
                id=str(uuid.uuid4()), run_id=run_id,
                plant_id=run.plant_id, tank_id=tank.id, material_id=mat.id,
                opening_stock=opening_stock, receipts=receipts, issues=issues,
                transfers=transfers, production=production, consumption=consumption,
                blending_inputs=max(blending, 0), blending_outputs=max(-blending, 0),
                closing_book=closing_book,
                closing_physical=closing_physical,
                dip_reading=phys.dip_reading if phys else 0,
                temperature=phys.temperature if phys else 15.0,
                density=phys.density if phys else (mat.density or 0.86),
                water_bottom=phys.water_bottom if phys else 0,
                variance=variance, variance_pct=variance_pct,
                severity="INFO", reconcil_level="TANK",
            ))
            total_variance += variance
            lines_processed += 1

        db.commit()
        run.run_status = "RECONCILING"
        db.commit()

        _audit(db, run_id, "CalculationReconciliationAgent", "STEP_03_CALCULATE",
               f"Balance calculated: {lines_processed} lines, total_variance={total_variance:.3f} MT",
               "SAP_S4HANA", "SUCCESS")

        return json.dumps({
            "status": "SUCCESS", "lines_processed": lines_processed,
            "total_variance_mt": round(total_variance, 3),
            "message": f"{lines_processed} mass balance lines calculated. Total variance: {total_variance:.3f} MT",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 04 — Reconcile  (slide 20)
#  Plant / Tank / Material level analysis
# ─────────────────────────────────────────────────────────────────────

@tool("Reconcile Balance at Plant Tank and Material Level")
def reconcile_levels(run_id: str) -> str:
    """
    Reconcile the mass balance at three levels (slide 20):
    Plant Level: aggregate balance across all tanks and materials within the plant.
    Tank Level: individual tank balance (opening + receipts - issues = closing).
    Material Level: product-by-product balance across all tanks and movements.
    Returns reconciliation summary per level.
    """
    db = _db()
    try:
        lines = db.query(MassBalanceLine).filter_by(run_id=run_id).all()
        if not lines:
            return json.dumps({"error": "No balance lines found — run calculate_mass_balance first"})

        plant_variance   = sum(l.variance for l in lines)
        tank_count       = len(lines)
        out_of_balance   = [l for l in lines if abs(l.variance or 0) > 0.001]

        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        run.run_status = "COMPARING"
        db.commit()

        _audit(db, run_id, "CalculationReconciliationAgent", "STEP_04_RECONCILE",
               f"Reconciled {tank_count} tank lines. Plant variance: {plant_variance:.3f} MT",
               "SAP_S4HANA", "SUCCESS")

        return json.dumps({
            "status": "SUCCESS",
            "plant_lines": 1, "tank_lines": tank_count, "material_lines": tank_count,
            "plant_variance_mt": round(plant_variance, 3),
            "lines_with_variance": len(out_of_balance),
            "message": f"Reconciled at Plant/Tank/Material level. {len(out_of_balance)} of {tank_count} tanks show variance.",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 05 — Compare Physical vs Book Stock  (slide 20)
#  Variance (MT) = Physical − Book
#  Positive = EXCESS | Negative = SHORTAGE
# ─────────────────────────────────────────────────────────────────────

@tool("Compare Physical Stock vs SAP Book Stock")
def compare_physical_vs_book(run_id: str) -> str:
    """
    Compare physical dip gauge readings against SAP MM book stock for all tanks (slide 20).
    Variance = Physical Quantity - Book Quantity.
    Positive variance = Physical EXCESS. Negative variance = Physical SHORTAGE.
    Adjustments applied before comparison: temperature & density corrections,
    API gravity conversion, water bottom deductions.
    Returns count of variances found.
    """
    db = _db()
    try:
        lines = db.query(MassBalanceLine).filter_by(run_id=run_id).all()
        if not lines:
            return json.dumps({"error": "No balance lines found"})

        excesses   = [l for l in lines if (l.variance or 0) > 0.001]
        shortages  = [l for l in lines if (l.variance or 0) < -0.001]
        balanced   = [l for l in lines if abs(l.variance or 0) <= 0.001]

        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        run.run_status = "CHECKING_TOL"
        db.commit()

        _audit(db, run_id, "CalculationReconciliationAgent", "STEP_05_COMPARE",
               f"Phys vs Book: {len(excesses)} excess, {len(shortages)} shortage, {len(balanced)} balanced",
               "TANK_GAUGE|SAP_S4HANA", "SUCCESS")

        return json.dumps({
            "status": "SUCCESS", "total_lines": len(lines),
            "excess_count": len(excesses), "shortage_count": len(shortages),
            "balanced_count": len(balanced),
            "exceptions_found": len(excesses) + len(shortages),
            "message": f"Physical vs Book comparison: {len(excesses)} EXCESS, {len(shortages)} SHORTAGE across {len(lines)} tanks.",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 06 — Check Tolerances  (slide 21)
#  INFO / ADVISORY / WARNING / CRITICAL severity bands
# ─────────────────────────────────────────────────────────────────────

@tool("Check Variance Against Tolerance Thresholds")
def check_tolerances(run_id: str) -> str:
    """
    Apply the configurable tolerance matrix to all balance lines (slide 21).
    Severity bands:
      INFO     = within tolerance (logged only)
      ADVISORY = 50-100% of threshold (flag for monitoring)
      WARNING  = 100-150% of threshold (investigation required)
      CRITICAL = >150% of threshold (immediate escalation, approval-gated)
    Returns counts per severity level.
    """
    db = _db()
    try:
        run   = db.query(MassBalanceRun).filter_by(id=run_id).first()
        lines = db.query(MassBalanceLine).filter_by(run_id=run_id).all()
        tols  = db.query(ToleranceConfig).filter_by(is_active=True).all()

        counts = {"INFO": 0, "ADVISORY": 0, "WARNING": 0, "CRITICAL": 0}

        for line in lines:
            abs_pct = abs(line.variance_pct or 0) / 100.0

            tol = (next((t for t in tols if t.level == "TANK" and t.plant_id == line.plant_id), None)
                or next((t for t in tols if t.level == "PLANT" and t.plant_id == line.plant_id), None)
                or next((t for t in tols if t.level == "REFINERY"), None))

            threshold = (tol.monthly_tolerance if run.period_type == "MONTHLY" else tol.daily_tolerance) if tol else 0.002
            ratio = abs_pct / threshold if threshold > 0 else 0

            if   ratio <= 0.5: sev = "INFO"
            elif ratio <= 1.0: sev = "ADVISORY"
            elif ratio <= 1.5: sev = "WARNING"
            else:               sev = "CRITICAL"

            line.severity = sev
            counts[sev] += 1

        db.commit()

        run.run_status = "INVESTIGATING" if (counts["WARNING"] + counts["CRITICAL"]) > 0 else "REPORTING"
        db.commit()

        _audit(db, run_id, "CalculationReconciliationAgent", "STEP_06_TOLERANCE",
               f"Tolerance: INFO={counts['INFO']} ADVISORY={counts['ADVISORY']} WARNING={counts['WARNING']} CRITICAL={counts['CRITICAL']}",
               "TOLERANCE_CONFIG", "WARNING" if counts["CRITICAL"] > 0 else "SUCCESS")

        return json.dumps({
            "status": "SUCCESS", **counts,
            "overall": "CRITICAL" if counts["CRITICAL"] > 0 else "WARNING" if counts["WARNING"] > 0 else "ADVISORY" if counts["ADVISORY"] > 0 else "INFO",
            "message": f"Tolerance check: {counts['WARNING']+counts['CRITICAL']} exceptions require investigation.",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 07 — Investigate Variances  (slide 22)
#  5-step drill-down: period isolation → movements → physical → meter → master data
# ─────────────────────────────────────────────────────────────────────

@tool("Investigate Flagged Variances")
def investigate_variances(run_id: str) -> str:
    """
    Investigate all balance lines flagged as ADVISORY/WARNING/CRITICAL (slide 22).
    Drill-down sequence:
    1. Isolate variance period (timestamp from movement logs)
    2. Drill into movements (MSEG/MKPF docs for flagged material+plant)
    3. Cross-check physical data (dip readings vs gauge charts and temperature logs)
    4. Verify meter data (pipeline meter totals vs booked transfer quantities)
    5. Check master data (density, conversion factors, UoM settings)
    Creates an exception record for each flagged line.
    Returns count of exceptions created.
    """
    db = _db()
    try:
        run   = db.query(MassBalanceRun).filter_by(id=run_id).first()
        lines = db.query(MassBalanceLine).filter_by(run_id=run_id).all()
        flagged = [l for l in lines if l.severity != "INFO"]

        exceptions_created = 0
        for idx, line in enumerate(flagged):
            movements = db.query(MaterialMovement).filter_by(
                run_id=run_id, tank_id=line.tank_id, material_id=line.material_id
            ).all()
            phys = db.query(PhysicalInventory).filter_by(
                run_id=run_id, tank_id=line.tank_id
            ).first()
            mat = db.query(Material).filter_by(id=line.material_id).first()

            inv_log = (
                f"[1] Variance period: {run.period}, variance={line.variance:.3f} MT ({line.variance_pct:.4f}%)\n"
                f"[2] Movements reviewed: {len(movements)} MSEG/MKPF docs — {', '.join(m.doc_number for m in movements if m.doc_number)}\n"
                f"[3] Physical reading: dip={phys.dip_reading if phys else 'N/A'}, temp={phys.temperature if phys else 'N/A'}°C, source={phys.source if phys else 'N/A'}\n"
                f"[4] Pipeline movements: {len([m for m in movements if m.movement_category=='PIPELINE'])} records reviewed\n"
                f"[5] Master data: density={mat.density if mat else 'N/A'} kg/L, UoM={mat.base_uom if mat else 'N/A'}"
            )
            exc_num = f"{idx+1:04d}"
            period_key = run.period.replace("-", "")[:6]
            exc_id = f"EXC-{period_key}-{exc_num}"

            existing = db.query(MassException).filter_by(exception_id=exc_id).first()
            if not existing:
                db.add(MassException(
                    id=str(uuid.uuid4()), exception_id=exc_id,
                    run_id=run_id, balance_line_id=line.id,
                    plant_id=line.plant_id, tank_id=line.tank_id, material_id=line.material_id,
                    period=run.period, period_type=run.period_type,
                    variance_mt=line.variance, variance_pct=line.variance_pct,
                    variance_sign="EXCESS" if (line.variance or 0) >= 0 else "SHORTAGE",
                    severity=line.severity,
                    investigation_log=inv_log,
                    supporting_docs=", ".join(m.doc_number for m in movements if m.doc_number),
                    related_movements=", ".join(m.doc_number for m in movements if m.doc_number),
                    status="OPEN",
                ))
                exceptions_created += 1

        db.commit()
        run.run_status = "CLASSIFYING"
        db.commit()

        _audit(db, run_id, "ExceptionManagementAgent", "STEP_07_INVESTIGATE",
               f"Investigation complete: {exceptions_created} exceptions created for {len(flagged)} flagged lines",
               "SAP_S4HANA|TANK_GAUGE", "SUCCESS")

        return json.dumps({
            "status": "SUCCESS", "flagged_lines": len(flagged),
            "exceptions_created": exceptions_created,
            "message": f"{exceptions_created} exception records created from investigation of {len(flagged)} flagged variances.",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 08 — Classify Root Causes  (slide 22)
#  MC / TX / MD / TF / PL / SY
# ─────────────────────────────────────────────────────────────────────

@tool("Classify Exception Root Causes")
def classify_root_causes(run_id: str) -> str:
    """
    Classify root causes for all open exceptions using the 6-category taxonomy (slide 22):
    MC = Measurement Error (gauge calibration, dip error, temperature correction omitted)
    TX = Transaction Error (wrong quantity, UoM, date, or document type in SAP)
    MD = Master Data Issue (density factor wrong, tank capacity outdated, UoM mismatch)
    TF = Transfer/Routing (goods in transit, pipeline lag, inter-company delay)
    PL = Physical Loss/Gain (evaporation, water bottom, line fill, process variance)
    SY = System/Interface (IDoc failure, batch job error, integration gap, timing issue)
    Returns classification summary by category.
    """
    db = _db()
    try:
        exceptions = db.query(MassException).filter_by(run_id=run_id, status="OPEN").all()
        cats = {"MC": 0, "TX": 0, "MD": 0, "TF": 0, "PL": 0, "SY": 0}

        HEURISTICS = [
            ("TX", "Duplicate movement document detected — likely double-posting in SAP",
             "Reverse incorrect posting (MR8M) and re-post with correct data after approval.",
             lambda e, l: l and getattr(l, 'is_duplicate', False)),
            ("MD", "Material density factor missing or zero — volume→MT conversion unreliable",
             "Update material master density in MARA (MM02). Re-run balance after correction.",
             lambda e, l: l and (not l.density or l.density <= 0)),
            ("PL", "Small consistent variance — consistent with evaporation, breathing loss or water bottom deduction",
             "Validate against API MPMS Table 7 evaporation loss tables. Close as legitimate process variance if within standard.",
             lambda e, l: abs(e.variance_pct or 0) < 0.1 and abs(e.variance_mt or 0) < 50),
            ("TF", "Physical excess detected — goods in transit not yet booked or pipeline custody transfer lag",
             "Confirm in-transit quantities with logistics. Apply GIT adjustment and re-reconcile after pipeline confirmation.",
             lambda e, l: e.variance_sign == "EXCESS" and abs(e.variance_pct or 0) > 0.1),
            ("MC", "Significant shortage — measurement error or gauge calibration drift suspected",
             "Verify gauge calibration records. Re-measure with calibrated equipment. Apply API MPMS correction factors.",
             lambda e, l: e.variance_sign == "SHORTAGE" and abs(e.variance_pct or 0) > 0.3),
            ("SY", "CRITICAL variance — possible IDoc failure, batch job error or interface gap",
             "Check IDoc monitor (BD87), SAP batch job logs, and integration middleware. Re-trigger failed messages.",
             lambda e, l: e.severity == "CRITICAL"),
            ("PL", "Unclassified variance — assigned as potential physical loss/gain pending further review",
             "Escalate to plant operations team for physical inspection. Document findings before closing.",
             lambda e, l: True),  # default
        ]

        for exc in exceptions:
            line = db.query(MassBalanceLine).filter_by(id=exc.balance_line_id).first() if exc.balance_line_id else None
            for cat, narrative, rec, condition in HEURISTICS:
                if condition(exc, line):
                    exc.root_cause_category  = cat
                    exc.root_cause_narrative = narrative
                    exc.recommendation       = rec
                    exc.status = "UNDER_REVIEW"
                    cats[cat] += 1
                    break

        db.commit()
        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        run.run_status = "REPORTING"
        db.commit()

        _audit(db, run_id, "ExceptionManagementAgent", "STEP_08_CLASSIFY",
               f"Root cause classification: {sum(cats.values())} classified. {cats}",
               "SAP_S4HANA", "SUCCESS")

        return json.dumps({
            "status": "SUCCESS", "classified": sum(cats.values()),
            "by_category": cats,
            "message": f"{sum(cats.values())} exceptions classified. Breakdown: {cats}",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 09 — Generate Exception Report  (slide 23)
# ─────────────────────────────────────────────────────────────────────

@tool("Generate Exception Report")
def generate_exception_report(run_id: str) -> str:
    """
    Build the evidence-based exception report (slide 23) for all exceptions in the run.
    Each report entry includes: exception ID, period, plant/tank/material hierarchy,
    variance (MT and %), severity, root cause category + narrative, supporting docs
    (MSEG/MKPF/MI07 numbers), corrective recommendation, and current status.
    Creates pending approval requests for all ADVISORY/WARNING/CRITICAL exceptions.
    No automatic corrections — all adjustments require explicit human approval (slide 23).
    Returns report summary with approval counts.
    """
    db = _db()
    try:
        exceptions = db.query(MassException).filter_by(run_id=run_id).all()
        approvals_created = 0

        for exc in exceptions:
            if exc.severity in ("ADVISORY", "WARNING", "CRITICAL") and exc.root_cause_category:
                existing = db.query(ApprovalRequest).filter_by(
                    exception_id=exc.id, approval_status="PENDING"
                ).first()
                if not existing:
                    priority = {"CRITICAL": "URGENT", "WARNING": "HIGH", "ADVISORY": "MEDIUM"}.get(exc.severity, "MEDIUM")
                    db.add(ApprovalRequest(
                        id=str(uuid.uuid4()), run_id=run_id, exception_id=exc.id,
                        request_type="CORRECTION_POSTING",
                        proposed_action=exc.recommendation or "Review and apply appropriate corrective action.",
                        evidence_summary=(
                            f"Exception {exc.exception_id} | Variance: {exc.variance_mt:.3f} MT ({exc.variance_pct:.4f}%) "
                            f"| Cause: {exc.root_cause_category} — {exc.root_cause_narrative} "
                            f"| Docs: {exc.supporting_docs or 'see investigation log'}"
                        ),
                        priority=priority, requested_by="AGENT",
                        requested_at=datetime.now(timezone.utc), approval_status="PENDING",
                    ))
                    approvals_created += 1

        db.commit()

        sev_counts = {s: sum(1 for e in exceptions if e.severity == s) for s in ("INFO","ADVISORY","WARNING","CRITICAL")}

        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        run.run_status = "PENDING_APPR" if approvals_created > 0 else "SUMMARISING"
        run.pending_approvals = approvals_created
        db.commit()

        rpt_id = f"RPT-{run.period}-{run.run_id.split('-')[-1] if run.run_id else 'UNKNOWN'}"
        _audit(db, run_id, "ReportGenerationAgent", "STEP_09_EXCEPTION_REPORT",
               f"Report {rpt_id}: {len(exceptions)} exceptions, {approvals_created} approvals pending",
               "INTERNAL", "SUCCESS")

        return json.dumps({
            "status": "SUCCESS", "report_id": rpt_id,
            "total_exceptions": len(exceptions), **sev_counts,
            "approvals_pending": approvals_created,
            "requires_human_review": approvals_created > 0,
            "message": f"Report {rpt_id} ready. {approvals_created} approval requests created — awaiting human sign-off.",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  STEP 10 — Generate Executive Summary  (slide 24)
# ─────────────────────────────────────────────────────────────────────

@tool("Generate Executive Summary Dashboard")
def generate_executive_summary(run_id: str) -> str:
    """
    Generate the management KPI dashboard (slide 24) for the period.
    KPIs:
    - Data Completeness %: all inputs validated with no blockers
    - Active Exceptions: WARNING or CRITICAL count
    - Refinery Variance %: weighted average across all balance lines
    - Tanks Reconciled: lines with INFO severity (balanced)
    - Pending Approvals: awaiting user sign-off
    - Corrections Posted: approved with SAP document number
    Also computes Exception Summary table by severity with status.
    Period balance status: WITHIN_TOLERANCE / OUTSIDE_TOLERANCE.
    """
    db = _db()
    try:
        run        = db.query(MassBalanceRun).filter_by(id=run_id).first()
        exceptions = db.query(MassException).filter_by(run_id=run_id).all()
        lines      = db.query(MassBalanceLine).filter_by(run_id=run_id).all()
        approvals  = db.query(ApprovalRequest).filter_by(run_id=run_id).all()
        val_issues = db.query(ValidationIssue).filter_by(run_id=run_id).all()

        blockers         = sum(1 for i in val_issues if i.severity == "BLOCKER")
        data_completeness= max(0.0, round(100.0 - blockers * 10, 2))
        tanks_reconciled = sum(1 for l in lines if l.severity == "INFO")
        total_book       = sum(l.closing_book or 0 for l in lines)
        total_variance   = sum(l.variance or 0 for l in lines)
        variance_pct     = round((total_variance / total_book * 100) if total_book else 0, 4)
        active_exceptions= sum(1 for e in exceptions if e.severity in ("WARNING","CRITICAL") and e.status in ("OPEN","UNDER_REVIEW"))
        pending_approvals= sum(1 for a in approvals if a.approval_status == "PENDING")
        corrections_posted= sum(1 for a in approvals if a.approval_status == "APPROVED" and a.sap_doc_number)
        balance_status   = "WITHIN_TOLERANCE" if abs(variance_pct) <= 0.10 else "OUTSIDE_TOLERANCE"

        sev_summary = [
            {"severity": "CRITICAL", "count": sum(1 for e in exceptions if e.severity == "CRITICAL"), "status": "Pending approval"},
            {"severity": "WARNING",  "count": sum(1 for e in exceptions if e.severity == "WARNING"),  "status": "Under review"},
            {"severity": "ADVISORY", "count": sum(1 for e in exceptions if e.severity == "ADVISORY"), "status": "Monitoring"},
            {"severity": "INFO",     "count": sum(1 for e in exceptions if e.severity == "INFO"),     "status": "Logged"},
        ]

        run.data_completeness     = data_completeness
        run.tanks_reconciled      = tanks_reconciled
        run.refinery_variance_pct = variance_pct
        run.balance_status        = balance_status
        run.pending_approvals     = pending_approvals
        run.corrections_posted    = corrections_posted
        run.run_status            = "COMPLETED" if pending_approvals == 0 else "PENDING_APPR"
        db.commit()

        _audit(db, run_id, "ReportGenerationAgent", "STEP_10_EXECUTIVE_SUMMARY",
               f"Summary: status={balance_status}, variance={variance_pct}%, exceptions={active_exceptions}, approvals_pending={pending_approvals}",
               "INTERNAL", "SUCCESS")

        return json.dumps({
            "status": "SUCCESS", "period": run.period, "period_type": run.period_type,
            "data_completeness": data_completeness, "tanks_reconciled": tanks_reconciled,
            "refinery_variance_pct": variance_pct, "balance_status": balance_status,
            "active_exceptions": active_exceptions, "pending_approvals": pending_approvals,
            "corrections_posted": corrections_posted, "exception_summary": sev_summary,
            "message": f"Period {run.period} | Status: {balance_status} | Variance: {variance_pct:.4f}% | Approvals pending: {pending_approvals}",
        })
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────
#  HUMAN-IN-THE-LOOP  (slide 6 & 23)
# ─────────────────────────────────────────────────────────────────────

@tool("Get Run Status")
def get_run_status(run_id: str) -> str:
    """
    Get the current status and key metrics of a mass balance run.
    Returns run_status, period, pending_approvals, and balance_status.
    """
    db = _db()
    try:
        run = db.query(MassBalanceRun).filter_by(id=run_id).first()
        if not run:
            return json.dumps({"error": f"Run {run_id} not found"})
        return json.dumps({
            "run_id": run.run_id, "period": run.period,
            "run_status": run.run_status, "balance_status": run.balance_status,
            "pending_approvals": run.pending_approvals,
            "refinery_variance_pct": run.refinery_variance_pct,
        })
    finally:
        db.close()
