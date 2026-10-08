/*
 * Refinery Mass Balance Reconciliation Agent — CDS Data Model
 * Based on SAP Agentic AI for Refinery Mass Balance Report (September 2026)
 *
 * Five core data domains (slide 14): TANK | MAT | MOV | PHYS | BOOK
 * Sources: SAP S/4HANA via MARA, MARC, MSEG, MARD, MKPF, MI01/MI07
 */

namespace refinery.massbalance;

using { cuid, managed } from '@sap/cds/common';

// ─────────────────────────────────────────────────────────────────────
//  MASTER DATA
// ─────────────────────────────────────────────────────────────────────

/** Plants / refineries */
entity Plants : cuid, managed {
    plantCode   : String(4)  not null;  // SAP plant code
    plantName   : String(80);
    country     : String(3);
    region      : String(50);
    isActive    : Boolean default true;
    tanks       : Composition of many Tanks       on tanks.plant = $self;
    tolerances  : Composition of many ToleranceConfig on tolerances.plant = $self;
}

/** TANK domain — Tank Master Data (slide 14) */
entity Tanks : cuid, managed {
    tankId          : String(20) not null;   // e.g. T-1001
    tankName        : String(80);
    plant           : Association to Plants;
    material        : Association to Materials;  // primary material
    storageLocation : String(4);                 // SAP storage location
    capacity        : Decimal(15,3);             // max capacity in MT
    densityFactor   : Decimal(10,6);             // kg/L at reference temp
    tempCorrFactor  : Decimal(10,6);             // volumetric temp correction
    tankType        : String(20) enum {
        CRUDE      = 'CRUDE';
        PRODUCT    = 'PRODUCT';
        BLEND      = 'BLEND';
        SLOPS      = 'SLOPS';
        INTERMEDIATE = 'INTERMEDIATE';
    };
    isActive        : Boolean default true;
}

/** MAT domain — Material Data from MARA (slide 14) */
entity Materials : cuid, managed {
    materialCode    : String(18) not null;    // SAP MARA-MATNR
    materialDesc    : String(100);
    baseUom         : String(3)  not null;    // MT / BBL / KL
    productGroup    : String(20);             // SAP product group
    materialGroup   : String(2) enum {
        CR = 'CR';   // Crude / Residual
        LD = 'LD';   // Light Distillates
        FP = 'FP';   // Finished Products
        SB = 'SB';   // Specialty / Blends
        RS = 'RS';   // Residual
        GP = 'GP';   // General Products
    };
    density         : Decimal(10,6);          // kg/L at 15°C (reference)
    apiGravity      : Decimal(6,2);           // API gravity
    flashPoint      : Decimal(6,2);           // °C
    isActive        : Boolean default true;
}

/** Unit of Measure Conversion (MAT domain) */
entity UomConversion : cuid, managed {
    material        : Association to Materials;
    fromUom         : String(3);
    toUom           : String(3);
    convFactor      : Decimal(15,8);   // multiply fromUom qty by this → toUom qty
}

// ─────────────────────────────────────────────────────────────────────
//  TOLERANCE CONFIGURATION (slide 21 — Configurable Tolerance Matrix)
// ─────────────────────────────────────────────────────────────────────

entity ToleranceConfig : cuid, managed {
    level              : String(10) enum {
        REFINERY = 'REFINERY';
        PLANT    = 'PLANT';
        TANK     = 'TANK';
        MATERIAL = 'MATERIAL';
    };
    plant              : Association to Plants;
    materialGroup      : String(2);              // links to Materials.materialGroup
    dailyTolerance     : Decimal(7,4);           // e.g. 0.0020 = 0.20%
    monthlyTolerance   : Decimal(7,4);           // e.g. 0.0010 = 0.10%
    escalationAction   : String(100);            // e.g. 'Executive escalation'
    escalationRole     : String(50);             // role to notify
    isActive           : Boolean default true;
}

// ─────────────────────────────────────────────────────────────────────
//  MASS BALANCE RUN  (Steps 1–10 of the Agentic Process)
// ─────────────────────────────────────────────────────────────────────

/**
 * Represents one execution of the 10-step agentic process (slides 16–24).
 * Each run can be DAILY (YYYY-MM-DD) or MONTHLY (YYYY-MM).
 */
entity MassBalanceRun : cuid, managed {
    runId               : String(30);
    periodType          : String(7) enum {
        DAILY   = 'DAILY';
        MONTHLY = 'MONTHLY';
    };
    period              : String(10);    // YYYY-MM-DD or YYYY-MM
    plant               : Association to Plants;

    // Agent process status (maps to 10 flowchart steps)
    runStatus           : String(15) enum {
        INITIATED    = 'INITIATED';     // step 0  — triggered
        INGESTING    = 'INGESTING';     // step 01 — Ingest SAP Data
        VALIDATING   = 'VALIDATING';    // step 02 — Validate Data
        CALCULATING  = 'CALCULATING';   // step 03 — Mass Balance
        RECONCILING  = 'RECONCILING';   // step 04 — Reconcile
        COMPARING    = 'COMPARING';     // step 05 — Compare Stock
        CHECKING_TOL = 'CHECKING_TOL';  // step 06 — Check Tolerance
        INVESTIGATING= 'INVESTIGATING'; // step 07 — Investigate
        CLASSIFYING  = 'CLASSIFYING';   // step 08 — Classify Cause
        REPORTING    = 'REPORTING';     // step 09 — Exception Report
        SUMMARISING  = 'SUMMARISING';   // step 10 — Executive Summary
        PENDING_APPR = 'PENDING_APPR';  // awaiting human sign-off
        COMPLETED    = 'COMPLETED';
        FAILED       = 'FAILED';
    } default 'INITIATED';

    // Data quality metrics (Executive Summary KPIs — slide 24)
    dataCompleteness    : Decimal(5,2);    // %
    tanksReconciled     : Integer default 0;
    refineryVariancePct : Decimal(8,4);    // overall refinery-level variance %
    balanceStatus       : String(20) enum {
        WITHIN_TOLERANCE = 'WITHIN_TOLERANCE';
        OUTSIDE_TOLERANCE = 'OUTSIDE_TOLERANCE';
        PENDING = 'PENDING';
    } default 'PENDING';
    correctionsPosted   : Integer default 0;
    pendingApprovals    : Integer default 0;

    // Triggered by
    triggerType         : String(20) enum {
        SCHEDULED  = 'SCHEDULED';
        ON_DEMAND  = 'ON_DEMAND';
        MANUAL     = 'MANUAL';
    } default 'MANUAL';
    triggeredBy         : String(50);

    // Compositions
    balanceLines        : Composition of many MassBalanceLine  on balanceLines.run = $self;
    exceptions          : Composition of many Exception        on exceptions.run = $self;
    auditLogs           : Composition of many AuditLog         on auditLogs.run = $self;
    approvalRequests    : Composition of many ApprovalRequest  on approvalRequests.run = $self;
    validationIssues    : Composition of many ValidationIssue  on validationIssues.run = $self;
}

// ─────────────────────────────────────────────────────────────────────
//  DATA VALIDATION ISSUES  (Step 1 — Data Validation & Completeness, slide 18)
// ─────────────────────────────────────────────────────────────────────

entity ValidationIssue : cuid, managed {
    run             : Association to MassBalanceRun;
    checkCategory   : String(20) enum {
        COMPLETENESS  = 'COMPLETENESS';
        CONSISTENCY   = 'CONSISTENCY';
        REFERENTIAL   = 'REFERENTIAL';
    };
    checkName       : String(100);   // e.g. 'All tank readings present'
    entity_         : String(50);    // affected entity (tank/material/doc)
    entityId        : String(50);
    issueDesc       : String(500);
    severity        : String(10) enum {
        INFO    = 'INFO';
        WARNING = 'WARNING';
        BLOCKER = 'BLOCKER';        // agent stops if BLOCKER present
    };
    isResolved      : Boolean default false;
}

// ─────────────────────────────────────────────────────────────────────
//  MASS BALANCE LINE  (Steps 2–5 Calculation & Reconciliation, slides 19–20)
//
//  Formula (slide 19):
//  Closing Stock = Opening Stock + Receipts − Issues − Consumption
//                  ± Transfers ± Adjustments
// ─────────────────────────────────────────────────────────────────────

entity MassBalanceLine : cuid, managed {
    run             : Association to MassBalanceRun;
    plant           : Association to Plants;
    tank            : Association to Tanks;
    material        : Association to Materials;

    // Opening Balance (prior period closing stock — locked after period close)
    openingStock    : Decimal(15,3);    // MT

    // Receipts & Issues (GR/GI documents, MSEG/MKPF)
    receipts        : Decimal(15,3);    // MT — GR postings
    issues          : Decimal(15,3);    // MT — GI postings
    transfers       : Decimal(15,3);    // MT — signed (+ in / - out)

    // Production Data (yield confirmations, process orders)
    production      : Decimal(15,3);    // MT — refinery yield confirmations
    consumption     : Decimal(15,3);    // MT — process order actual consumption
    byProducts      : Decimal(15,3);    // MT — by-product/co-product credits (signed)
    blendingInputs  : Decimal(15,3);    // MT — blending order inputs
    blendingOutputs : Decimal(15,3);    // MT — blending order outputs

    // Manual adjustments (require approval before posting)
    adjustments     : Decimal(15,3);    // MT — signed

    // Closing Balance (calculated)
    closingBook     : Decimal(15,3);    // MT — calculated book stock end of period

    // BOOK domain — Physical vs Book Stock comparison (slide 20)
    closingPhysical : Decimal(15,3);    // MT — from dip gauge / ATG converted to MT
    dipReading      : Decimal(15,3);    // raw volume reading (m³ or BBL)
    temperature     : Decimal(8,2);     // °C at time of reading
    density         : Decimal(10,6);    // kg/L at observed temperature
    apiGravity      : Decimal(6,2);
    waterBottom     : Decimal(15,3);    // MT deducted before comparison

    // Variance = Physical − Book (positive = excess, negative = shortage)
    variance        : Decimal(15,3);    // MT
    variancePct     : Decimal(8,4);     // %

    // Tolerance check result (slide 21)
    toleranceRef    : Association to ToleranceConfig;
    severity        : String(10) enum {
        INFO     = 'INFO';      // within tolerance
        ADVISORY = 'ADVISORY';  // 50–100% of threshold
        WARNING  = 'WARNING';   // 100–150% of threshold
        CRITICAL = 'CRITICAL';  // > 150% of threshold
    } default 'INFO';

    // Reconciliation level (slide 20 — Plant/Tank/Material)
    reconcLevel     : String(10) enum {
        PLANT    = 'PLANT';
        TANK     = 'TANK';
        MATERIAL = 'MATERIAL';
    };
}

// ─────────────────────────────────────────────────────────────────────
//  PHYS domain — Physical Inventory Documents  (slide 14: MI01 / MI07)
// ─────────────────────────────────────────────────────────────────────

entity PhysicalInventory : cuid, managed {
    docNumber       : String(10);       // MI01/MI07 document number
    docType         : String(6) enum {
        MI01 = 'MI01';
        MI07 = 'MI07';
        MANUAL = 'MANUAL';
    };
    run             : Association to MassBalanceRun;
    tank            : Association to Tanks;
    material        : Association to Materials;
    plant           : Association to Plants;
    storageLocation : String(4);

    readingDate     : Date;
    readingTime     : Time;
    source          : String(10) enum {
        ATG    = 'ATG';     // Automatic Tank Gauge
        MANUAL = 'MANUAL';  // Manual dip reading
        SCADA  = 'SCADA';   // SCADA feed
    };

    // Raw measurements
    dipReading      : Decimal(15,3);    // volume in base UoM (m³/BBL)
    temperature     : Decimal(8,2);     // °C
    density         : Decimal(10,6);    // kg/L at observed temp
    apiGravity      : Decimal(6,2);
    waterBottom     : Decimal(15,3);    // volume to deduct

    // Converted values
    quantityMT      : Decimal(15,3);    // after density + temp correction
    quantityBBL     : Decimal(15,3);

    isFinalReading  : Boolean default false;
    isVerified      : Boolean default false;
}

// ─────────────────────────────────────────────────────────────────────
//  MOV domain — Material Movements  (slide 14: GR/GI/MSEG/MKPF)
// ─────────────────────────────────────────────────────────────────────

entity MaterialMovement : cuid, managed {
    docNumber       : String(10);   // MKPF document number
    lineItem        : String(4);    // MSEG item
    run             : Association to MassBalanceRun;
    material        : Association to Materials;
    plant           : Association to Plants;
    tank            : Association to Tanks;
    storageLocation : String(4);

    movementType    : String(3);    // SAP movement type (101, 201, 261 etc.)
    movementCategory: String(15) enum {
        GR          = 'GR';         // Goods Receipt
        GI          = 'GI';         // Goods Issue
        TRANSFER    = 'TRANSFER';   // Inter-plant / inter-tank
        PRODUCTION  = 'PRODUCTION'; // Production confirmation
        CONSUMPTION = 'CONSUMPTION';// Process order consumption
        BLENDING    = 'BLENDING';   // Blending order
        PIPELINE    = 'PIPELINE';   // Pipeline nomination / custody transfer
        ADJUSTMENT  = 'ADJUSTMENT'; // Stock adjustment (approval-gated)
    };

    postingDate     : Date;
    postingTime     : Time;
    quantity        : Decimal(15,3);
    uom             : String(3);
    quantityMT      : Decimal(15,3);   // normalised to MT
    batchNumber     : String(10);
    vendorBatch     : String(10);

    // For transfers — source/destination
    sendingTank     : Association to Tanks;
    receivingTank   : Association to Tanks;

    referenceDoc    : String(10);       // PO / nomination / process order
    isReversed      : Boolean default false;
    isDuplicate     : Boolean default false;  // set by validation agent
}

// ─────────────────────────────────────────────────────────────────────
//  EXCEPTION  (Steps 8 & 9 — Exception Report & Recommendations, slide 23)
// ─────────────────────────────────────────────────────────────────────

entity Exception : cuid, managed {
    exceptionId     : String(20);   // EXC-YYYY-MM-NNNN (auto-generated)
    run             : Association to MassBalanceRun;
    balanceLine     : Association to MassBalanceLine;
    plant           : Association to Plants;
    tank            : Association to Tanks;
    material        : Association to Materials;

    period          : String(10);   // YYYY-MM-DD or YYYY-MM
    periodType      : String(7);

    // Variance metrics
    varianceMT      : Decimal(15,3);
    variancePct     : Decimal(8,4);
    varianceSign    : String(10) enum {
        EXCESS   = 'EXCESS';     // Physical > Book
        SHORTAGE = 'SHORTAGE';   // Physical < Book
    };

    // Severity (slide 21)
    severity        : String(10) enum {
        INFO     = 'INFO';
        ADVISORY = 'ADVISORY';
        WARNING  = 'WARNING';
        CRITICAL = 'CRITICAL';
    };

    // Root Cause Classification (slide 22)
    rootCauseCategory: String(2) enum {
        MC = 'MC';   // Measurement Error — gauge calibration, dip error, temp correction omitted
        TX = 'TX';   // Transaction Error — wrong qty, UoM, date, document type in SAP
        MD = 'MD';   // Master Data Issue — density factor wrong, tank capacity outdated, UoM mismatch
        TF = 'TF';   // Transfer/Routing — goods in transit, pipeline lag, inter-company delay
        PL = 'PL';   // Physical Loss/Gain — evaporation, water bottom, line fill, process variance
        SY = 'SY';   // System/Interface — IDoc failure, batch job error, integration gap, timing issue
    };
    rootCauseNarrative: LargeString;   // narrative description from agent
    recommendation  : LargeString;     // proposed corrective action with priority

    // Investigation evidence (slide 22)
    investigationLog: LargeString;     // drill-down findings
    supportingDocs  : String(500);     // comma-separated MSEG/MKPF/MI07 numbers
    relatedMovements: String(500);     // movement doc numbers reviewed

    // Status (slide 23)
    status          : String(15) enum {
        OPEN         = 'OPEN';
        UNDER_REVIEW = 'UNDER_REVIEW';
        APPROVED     = 'APPROVED';
        CLOSED       = 'CLOSED';
        REJECTED     = 'REJECTED';
    } default 'OPEN';

    // Human-in-the-loop governance (slide 6 & slide 23)
    assignedTo      : String(50);
    reviewedBy      : String(50);
    reviewedAt      : Timestamp;
    approvedBy      : String(50);
    approvedAt      : Timestamp;
    closingComments : String(500);

    approvals       : Composition of many ApprovalRequest on approvals.exception = $self;
}

// ─────────────────────────────────────────────────────────────────────
//  APPROVAL REQUEST  (Human-in-the-Loop Governance — slides 6, 16, 23)
//  No automatic corrections. Every stock adjustment / posting requires
//  explicit user approval.
// ─────────────────────────────────────────────────────────────────────

entity ApprovalRequest : cuid, managed {
    run             : Association to MassBalanceRun;
    exception       : Association to Exception;

    requestType     : String(25) enum {
        STOCK_ADJUSTMENT   = 'STOCK_ADJUSTMENT';    // adjust book stock
        CORRECTION_POSTING = 'CORRECTION_POSTING';  // post SAP document
        EXCEPTION_CLOSURE  = 'EXCEPTION_CLOSURE';   // close exception
        ESCALATION         = 'ESCALATION';          // escalate to management
    };

    proposedAction  : LargeString;    // what the agent recommends doing
    evidenceSummary : LargeString;    // backing evidence
    priority        : String(10) enum {
        LOW    = 'LOW';
        MEDIUM = 'MEDIUM';
        HIGH   = 'HIGH';
        URGENT = 'URGENT';
    };
    requestedBy     : String(50);     // user ID or 'AGENT'
    requestedAt     : Timestamp;

    approvalStatus  : String(10) enum {
        PENDING  = 'PENDING';
        APPROVED = 'APPROVED';
        REJECTED = 'REJECTED';
    } default 'PENDING';
    approvedBy      : String(50);
    approvedAt      : Timestamp;
    comments        : String(500);

    // SAP document created after approval
    sapDocNumber    : String(10);
    sapDocType      : String(5);
}

// ─────────────────────────────────────────────────────────────────────
//  AUDIT LOG  (Full Audit Trail — slide 6)
//  Every agent action is logged with timestamps, data sources, and
//  decision rationale for traceability.
// ─────────────────────────────────────────────────────────────────────

entity AuditLog : cuid {
    run             : Association to MassBalanceRun;
    timestamp       : Timestamp;
    agentName       : String(50);   // e.g. DataCollectionAgent, ValidationAgent
    agentStep       : String(30);   // e.g. STEP_01_INGEST, STEP_02_VALIDATE
    action          : String(200);
    dataSource      : String(50);   // SCADA / LIMS / SAP_S4 / TANK_GAUGE / EHS
    decisionRationale: LargeString;
    inputSummary    : LargeString;
    outputSummary   : LargeString;
    userId          : String(50);   // SYSTEM for agent actions, user ID for human
    result          : String(10) enum {
        SUCCESS = 'SUCCESS';
        WARNING = 'WARNING';
        FAILURE = 'FAILURE';
        SKIPPED = 'SKIPPED';
    };
    durationMs      : Integer;
}

// ─────────────────────────────────────────────────────────────────────
//  BOOK STOCK SNAPSHOT  (BOOK domain — slide 14: SAP MM stock ledger)
// ─────────────────────────────────────────────────────────────────────

entity BookStockSnapshot : cuid, managed {
    run             : Association to MassBalanceRun;
    material        : Association to Materials;
    plant           : Association to Plants;
    tank            : Association to Tanks;
    storageLocation : String(4);

    snapshotDate    : Date;
    snapshotTime    : Time;

    // From SAP MM ledger (MARD)
    unrestricted    : Decimal(15,3);   // MT — unrestricted stock
    qualInspection  : Decimal(15,3);   // MT — quality inspection
    blocked         : Decimal(15,3);   // MT — blocked
    inTransit       : Decimal(15,3);   // MT — goods in transit
    totalBook       : Decimal(15,3);   // MT — total book stock

    // Batch-level (MCHB)
    batchNumber     : String(10);
    valuationClass  : String(4);

    periodEndBalance: Decimal(15,3);   // MT — period-end closing balance
    isPeriodClose   : Boolean default false;
}
