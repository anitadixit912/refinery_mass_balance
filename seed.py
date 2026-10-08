"""
Seed script — populates the database with reference data for all three refinery plants.
Data matches the CSV seed files from the Node.js CAP project (slide 14).
"""

import uuid
from datetime import datetime, timezone, timedelta
from database import init_db, SessionLocal, Plant, Material, Tank, ToleranceConfig


def seed():
    init_db()
    db = SessionLocal()
    try:
        # ── Plants ────────────────────────────────────────────────────
        plants_data = [
            {"plant_code": "R001", "plant_name": "Saudi Arabia Refinery", "country": "SA",
             "currency": "SAR", "capacity_bpd": 500000, "timezone": "Asia/Riyadh"},
            {"plant_code": "R002", "plant_name": "Netherlands Refinery",  "country": "NL",
             "currency": "EUR", "capacity_bpd": 300000, "timezone": "Europe/Amsterdam"},
            {"plant_code": "R003", "plant_name": "Singapore Refinery",    "country": "SG",
             "currency": "SGD", "capacity_bpd": 400000, "timezone": "Asia/Singapore"},
        ]
        plants = {}
        for pd in plants_data:
            existing = db.query(Plant).filter_by(plant_code=pd["plant_code"]).first()
            if not existing:
                p = Plant(id=str(uuid.uuid4()), **pd, is_active=True)
                db.add(p)
                db.flush()
                plants[pd["plant_code"]] = p
            else:
                plants[pd["plant_code"]] = existing
        db.commit()
        print(f"Plants: {len(plants)} seeded")

        # ── Materials ─────────────────────────────────────────────────
        materials_data = [
            {"material_code": "MAT-0001", "material_desc": "Crude Oil - Arab Light",
             "material_type": "ZRAW", "base_uom": "MT", "density": 0.8590, "api_gravity": 33.4},
            {"material_code": "MAT-0002", "material_desc": "Naphtha",
             "material_type": "ZINT", "base_uom": "MT", "density": 0.7400, "api_gravity": 59.7},
            {"material_code": "MAT-0003", "material_desc": "Jet Fuel (Kerosene)",
             "material_type": "ZPRD", "base_uom": "MT", "density": 0.8000, "api_gravity": 45.4},
            {"material_code": "MAT-0004", "material_desc": "Diesel (Gas Oil)",
             "material_type": "ZPRD", "base_uom": "MT", "density": 0.8450, "api_gravity": 35.9},
            {"material_code": "MAT-0005", "material_desc": "Fuel Oil (HSFO)",
             "material_type": "ZPRD", "base_uom": "MT", "density": 0.9850, "api_gravity": 12.3},
            {"material_code": "MAT-0006", "material_desc": "Motor Gasoline (Mogas 95)",
             "material_type": "ZPRD", "base_uom": "MT", "density": 0.7500, "api_gravity": 57.7},
            {"material_code": "MAT-0007", "material_desc": "LPG Propane",
             "material_type": "ZPRD", "base_uom": "MT", "density": 0.5070, "api_gravity": 147.0},
            {"material_code": "MAT-0008", "material_desc": "Vacuum Gas Oil (VGO)",
             "material_type": "ZINT", "base_uom": "MT", "density": 0.9120, "api_gravity": 23.5},
            {"material_code": "MAT-0009", "material_desc": "Atmospheric Residue",
             "material_type": "ZINT", "base_uom": "MT", "density": 0.9600, "api_gravity": 15.5},
            {"material_code": "MAT-0010", "material_desc": "Reformate",
             "material_type": "ZINT", "base_uom": "MT", "density": 0.7900, "api_gravity": 47.1},
        ]
        mats = {}
        for md in materials_data:
            existing = db.query(Material).filter_by(material_code=md["material_code"]).first()
            if not existing:
                m = Material(id=str(uuid.uuid4()), **md, is_active=True)
                db.add(m)
                db.flush()
                mats[md["material_code"]] = m
            else:
                mats[md["material_code"]] = existing
        db.commit()
        print(f"Materials: {len(mats)} seeded")

        # ── Tanks ─────────────────────────────────────────────────────
        plant_r001 = plants["R001"]
        mat_codes = list(mats.keys())
        tanks_data = [
            {"tank_id": "TK-001", "tank_name": "Crude Oil Storage Tank 1",
             "tank_type": "FLOATING_ROOF", "capacity_m3": 100000, "material_code": "MAT-0001"},
            {"tank_id": "TK-002", "tank_name": "Crude Oil Storage Tank 2",
             "tank_type": "FLOATING_ROOF", "capacity_m3": 80000, "material_code": "MAT-0001"},
            {"tank_id": "TK-003", "tank_name": "Naphtha Tank",
             "tank_type": "FIXED_ROOF",   "capacity_m3": 20000, "material_code": "MAT-0002"},
            {"tank_id": "TK-004", "tank_name": "Jet Fuel Tank",
             "tank_type": "FIXED_ROOF",   "capacity_m3": 15000, "material_code": "MAT-0003"},
            {"tank_id": "TK-005", "tank_name": "Diesel Tank",
             "tank_type": "FIXED_ROOF",   "capacity_m3": 25000, "material_code": "MAT-0004"},
            {"tank_id": "TK-006", "tank_name": "Fuel Oil Tank",
             "tank_type": "CONE_ROOF",    "capacity_m3": 50000, "material_code": "MAT-0005"},
            {"tank_id": "TK-007", "tank_name": "Gasoline Tank",
             "tank_type": "FLOATING_ROOF","capacity_m3": 30000, "material_code": "MAT-0006"},
            {"tank_id": "TK-008", "tank_name": "LPG Sphere 1",
             "tank_type": "SPHERE",        "capacity_m3": 2000,  "material_code": "MAT-0007"},
            {"tank_id": "TK-009", "tank_name": "VGO Tank",
             "tank_type": "CONE_ROOF",    "capacity_m3": 40000, "material_code": "MAT-0008"},
            {"tank_id": "TK-010", "tank_name": "Reformate Tank",
             "tank_type": "FLOATING_ROOF","capacity_m3": 18000, "material_code": "MAT-0010"},
        ]
        for td in tanks_data:
            mc = td.pop("material_code")
            mat = mats.get(mc)
            existing = db.query(Tank).filter_by(tank_id=td["tank_id"]).first()
            if not existing:
                density_factor = mat.density if mat else 0.86
                db.add(Tank(
                    id=str(uuid.uuid4()), plant_id=plant_r001.id,
                    material_id=mat.id if mat else None,
                    density_factor=density_factor,
                    temp_corr_factor=0.00065,
                    is_active=True, **td,
                ))
        db.commit()
        tank_count = db.query(Tank).count()
        print(f"Tanks: {tank_count} seeded")

        # ── Tolerance Configuration (slide 21) ────────────────────────
        tol_data = [
            # REFINERY level
            {"tol_id": "TOL-001", "level": "REFINERY", "daily_tolerance": 0.002,
             "monthly_tolerance": 0.0005, "product_class": "CRUDE",
             "daily_info": 0.001, "daily_advisory": 0.0015, "daily_warning": 0.002, "daily_critical": 0.003,
             "monthly_info": 0.0002, "monthly_advisory": 0.0004, "monthly_warning": 0.0005, "monthly_critical": 0.001},
            {"tol_id": "TOL-002", "level": "REFINERY", "daily_tolerance": 0.003,
             "monthly_tolerance": 0.001, "product_class": "PRODUCTS",
             "daily_info": 0.002, "daily_advisory": 0.0025, "daily_warning": 0.003, "daily_critical": 0.005,
             "monthly_info": 0.0005, "monthly_advisory": 0.00075, "monthly_warning": 0.001, "monthly_critical": 0.002},
            # PLANT level
            {"tol_id": "TOL-003", "level": "PLANT", "plant_id": None, "daily_tolerance": 0.003,
             "monthly_tolerance": 0.001, "product_class": "ALL",
             "daily_info": 0.002, "daily_advisory": 0.0025, "daily_warning": 0.003, "daily_critical": 0.005,
             "monthly_info": 0.0005, "monthly_advisory": 0.00075, "monthly_warning": 0.001, "monthly_critical": 0.002},
            {"tol_id": "TOL-004", "level": "PLANT", "plant_id": None, "daily_tolerance": 0.004,
             "monthly_tolerance": 0.0015, "product_class": "CRUDE",
             "daily_info": 0.002, "daily_advisory": 0.003, "daily_warning": 0.004, "daily_critical": 0.006,
             "monthly_info": 0.0005, "monthly_advisory": 0.001, "monthly_warning": 0.0015, "monthly_critical": 0.003},
            # TANK level
            {"tol_id": "TOL-005", "level": "TANK", "daily_tolerance": 0.005,
             "monthly_tolerance": 0.002, "product_class": "CRUDE",
             "daily_info": 0.003, "daily_advisory": 0.004, "daily_warning": 0.005, "daily_critical": 0.008,
             "monthly_info": 0.001, "monthly_advisory": 0.0015, "monthly_warning": 0.002, "monthly_critical": 0.004},
            {"tol_id": "TOL-006", "level": "TANK", "daily_tolerance": 0.007,
             "monthly_tolerance": 0.003, "product_class": "PRODUCTS",
             "daily_info": 0.004, "daily_advisory": 0.005, "daily_warning": 0.007, "daily_critical": 0.01,
             "monthly_info": 0.001, "monthly_advisory": 0.002, "monthly_warning": 0.003, "monthly_critical": 0.006},
            # MATERIAL level
            {"tol_id": "TOL-007", "level": "MATERIAL", "daily_tolerance": 0.005,
             "monthly_tolerance": 0.002, "product_class": "CRUDE",
             "daily_info": 0.003, "daily_advisory": 0.004, "daily_warning": 0.005, "daily_critical": 0.008,
             "monthly_info": 0.001, "monthly_advisory": 0.0015, "monthly_warning": 0.002, "monthly_critical": 0.004},
            {"tol_id": "TOL-008", "level": "MATERIAL", "daily_tolerance": 0.008,
             "monthly_tolerance": 0.004, "product_class": "LPG",
             "daily_info": 0.005, "daily_advisory": 0.006, "daily_warning": 0.008, "daily_critical": 0.012,
             "monthly_info": 0.002, "monthly_advisory": 0.003, "monthly_warning": 0.004, "monthly_critical": 0.008},
            {"tol_id": "TOL-009", "level": "MATERIAL", "daily_tolerance": 0.006,
             "monthly_tolerance": 0.0025, "product_class": "PRODUCTS",
             "daily_info": 0.003, "daily_advisory": 0.005, "daily_warning": 0.006, "daily_critical": 0.009,
             "monthly_info": 0.001, "monthly_advisory": 0.002, "monthly_warning": 0.0025, "monthly_critical": 0.005},
            {"tol_id": "TOL-010", "level": "MATERIAL", "daily_tolerance": 0.007,
             "monthly_tolerance": 0.003, "product_class": "FUEL_OIL",
             "daily_info": 0.004, "daily_advisory": 0.006, "daily_warning": 0.007, "daily_critical": 0.010,
             "monthly_info": 0.0015, "monthly_advisory": 0.002, "monthly_warning": 0.003, "monthly_critical": 0.006},
        ]

        plant_id_r001 = plant_r001.id
        for i, td in enumerate(tol_data):
            existing = db.query(ToleranceConfig).filter_by(tol_id=td["tol_id"]).first()
            if not existing:
                plant_id = plant_id_r001 if td.get("level") in ("PLANT",) else td.pop("plant_id", None)
                db.add(ToleranceConfig(
                    id=str(uuid.uuid4()), plant_id=plant_id, is_active=True, **td
                ))
            else:
                td.pop("plant_id", None)
        db.commit()
        tol_count = db.query(ToleranceConfig).count()
        print(f"Tolerance configs: {tol_count} seeded")

        print("\nSeed complete. Database ready.")
        print(f"Plants: R001 (Saudi Arabia), R002 (Netherlands), R003 (Singapore)")
        print(f"POST http://localhost:8000/api/v1/runs  body: {{period_type:DAILY,period:2026-10-08,plant_code:R001}}")

    finally:
        db.close()


if __name__ == "__main__":
    seed()
