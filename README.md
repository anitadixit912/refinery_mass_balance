# Refinery Mass Balance Reconciliation Agent

Agentic AI system for automated refinery mass balance reconciliation, built for SAP S/4HANA IS-Oil & Gas environments.

## Architecture

- **5 CrewAI Sub-Agents** with Anthropic Claude (claude-sonnet-5-5)
- **10-Step Agentic Pipeline**: Ingest → Validate → Calculate → Reconcile → Compare → Tolerance → Investigate → Classify → Report → Summary
- **5 Data Domains**: TANK, MAT (MARA), MOV (MSEG/MKPF), PHYS (MI07), BOOK (MARD)
- **FastAPI** REST API
- **SQLAlchemy 2.x** with SQLite (dev) / PostgreSQL (prod)
- **Human-in-the-Loop** approval gates before SAP corrections

## Projects

| Folder | Stack |
|--------|-------|
| `refinery-mass-balance-py/` | Python · FastAPI · CrewAI 1.x · Anthropic Claude |
| `refinery-mass-balance/` | Node.js · SAP CAP · @sap-ai-sdk |

## Quick Start (Python — Docker)

```bash
cd refinery-mass-balance-py
cp .env.example .env
# Edit .env: add your ANTHROPIC_API_KEY
docker compose up --build
```

API available at `http://localhost:8000`  
Docs at `http://localhost:8000/docs`

## Quick Start (Python — local)

```bash
cd refinery-mass-balance-py
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python seed.py
uvicorn main:app --reload
```

## Example: Run the full pipeline

```bash
# 1. Create a run
curl -X POST http://localhost:8000/api/v1/runs \
  -H "Content-Type: application/json" \
  -d '{"period_type":"DAILY","period":"2026-10-08","plant_code":"R001"}'

# 2. Execute pipeline (sync, for demo)
curl -X POST http://localhost:8000/api/v1/runs/{run_id}/pipeline

# 3. Get executive summary
curl http://localhost:8000/api/v1/runs/{run_id}/summary

# 4. Approve an exception
curl -X POST http://localhost:8000/api/v1/approvals/{approval_id}/approve \
  -H "Content-Type: application/json" \
  -d '{"comments":"Reviewed and approved"}'
```

## ngrok (share with colleagues)

```bash
# After docker compose up
ngrok http 8000
# Share the https://xxxx.ngrok-free.app URL
```

## Tolerance Bands (slide 21)

| Severity | Daily Threshold | Monthly Threshold |
|----------|----------------|-------------------|
| INFO     | ≤ 0.1%         | ≤ 0.02%           |
| ADVISORY | 0.1–0.15%      | 0.02–0.04%        |
| WARNING  | 0.15–0.2%      | 0.04–0.05%        |
| CRITICAL | > 0.2%         | > 0.05%           |

## Root Cause Categories (slide 22)

| Code | Category | Description |
|------|----------|-------------|
| MC | Measurement Error | Gauge calibration, dip error, temperature correction |
| TX | Transaction Error | Wrong quantity/UoM/date in SAP |
| MD | Master Data | Density factor, tank capacity, UoM mismatch |
| TF | Transfer/Routing | Goods in transit, pipeline lag |
| PL | Physical Loss/Gain | Evaporation, water bottom, line fill |
| SY | System/Interface | IDoc failure, batch job, integration gap |
