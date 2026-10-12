'use strict';

/**
 * S4Client — live data from SAP S/4 HANA via BTP destination.
 *
 * Destination name defaults to the OGS_S4 BTP destination (system OGS / client 650).
 * Override with env var S4H_DESTINATION_NAME.
 *
 * Three OData v2 standard APIs consumed:
 *   API_MATERIAL_DOCUMENT_SRV  — MOV domain  (MSEG/MKPF)
 *   API_MATERIAL_STOCK_SRV     — BOOK domain (MARD)
 *   API_PHYSICAL_INVENTORY_DOC_SRV — PHYS domain (MI01/MI07)
 */

const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DEST = process.env.S4H_DESTINATION_NAME || 'OGS_S4';

// SAP movement type → local movementCategory
const MOV_TYPE_TO_CAT = {
    '101': 'GR',  '102': 'GR',  '122': 'GR',   // Goods Receipts
    '201': 'GI',  '261': 'GI',  '262': 'GI',    // Goods Issues
    '601': 'GI',  '602': 'GI',                   // Delivery-based GI
    '311': 'TRANSFER',  '312': 'TRANSFER',
    '313': 'TRANSFER',  '314': 'TRANSFER',
    '301': 'TRANSFER',  '303': 'TRANSFER',
    '131': 'PRODUCTION',  '132': 'PRODUCTION',
    '551': 'CONSUMPTION', '552': 'CONSUMPTION',
    '281': 'CONSUMPTION', '282': 'CONSUMPTION',
};

function _periodDates(period) {
    if (period.length === 7) {  // YYYY-MM
        const [yr, mo] = period.split('-').map(Number);
        const lastDay  = new Date(yr, mo, 0).getDate();
        return {
            startDate : `${period}-01`,
            endDate   : `${period}-${String(lastDay).padStart(2, '0')}`,
            fiscalYear: String(yr),
        };
    }
    return {
        startDate : period,
        endDate   : period,
        fiscalYear: period.split('-')[0],
    };
}

// Cloud SDK v4 paramsSerializer doesn't URL-encode values; pre-encode OData filters.
const _f = (filter) => encodeURIComponent(filter);

class S4Client {

    // ── MASTER DATA — Plants (derived from movement doc plant field) ──
    async getPlants() {
        // Use A_MaterialDocumentItem which the MM user is authorized for
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url   : '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentItem',
                params: { '$select': 'Plant', '$format': 'json', '$top': '5000' },
            }
        );
        const codes = [...new Set((res.data?.d?.results || []).map(r => r.Plant).filter(Boolean))];
        return codes.map(c => ({ plantCode: c, plantName: c, country: '', region: '' }));
    }

    // ── MASTER DATA — Materials (derived from movement docs) ──────────
    async getMaterials() {
        // Use A_MaterialDocumentItem (same API as plants — MM user authorized)
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url   : '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentItem',
                params: { '$select': 'Material,EntryUnit', '$format': 'json', '$top': '5000' },
            }
        );
        const seen = new Set();
        return (res.data?.d?.results || [])
            .filter(r => r.Material && !seen.has(r.Material) && seen.add(r.Material))
            .map(r => ({
                materialCode: (r.Material || '').trim(),
                materialDesc: (r.Material || '').trim(),
                baseUom     : r.EntryUnit || 'MT',
                productGroup: 'GP',
            }));
    }

    // ── MASTER DATA — Storage Locations (from stock table per plant) ──
    async getStorageLocations(plantCode) {
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url   : '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod',
                params: {
                    '$filter': _f(`Plant eq '${plantCode}'`),
                    '$select': 'StorageLocation,Plant',
                    '$format': 'json',
                    '$top'   : '500',
                },
            }
        );
        const slocs = [...new Set((res.data?.d?.results || []).map(r => r.StorageLocation).filter(Boolean))];
        return slocs.map(sl => ({ storageLocation: sl, plantCode }));
    }

    // ── MOV domain — API_MATERIAL_DOCUMENT_SRV ─────────────────────────
    async getMovements(plantCode, period) {
        const { startDate, endDate } = _periodDates(period);
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method : 'GET',
                url    : '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentItem',
                params : {
                    '$filter': _f(`Plant eq '${plantCode}' and PostingDate ge datetime'${startDate}T00:00:00' and PostingDate le datetime'${endDate}T23:59:59'`),
                    '$select': 'MaterialDocument,MaterialDocumentItem,Material,Plant,StorageLocation,GoodsMovementType,QuantityInEntryUnit,EntryUnit,PostingDate',
                    '$format': 'json',
                    '$top'   : '5000',
                },
            }
        );
        return (res.data?.d?.results || []).map(i => ({
            docNumber       : i.MaterialDocument,
            lineItem        : i.MaterialDocumentItem,
            materialCode    : (i.Material || '').trim(),
            plantCode       : i.Plant,
            storageLocation : i.StorageLocation,
            movementType    : i.GoodsMovementType,
            movementCategory: MOV_TYPE_TO_CAT[i.GoodsMovementType] || 'GR',
            postingDate     : i.PostingDate ? i.PostingDate.replace(/\/Date\((\d+)\)\//, (_, ms) =>
                                new Date(Number(ms)).toISOString().split('T')[0]) : null,
            quantity        : parseFloat(i.QuantityInEntryUnit) || 0,
            uom             : i.EntryUnit || 'MT',
        }));
    }

    // ── BOOK domain — API_MATERIAL_STOCK_SRV ───────────────────────────
    async getBookStock(plantCode) {
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method : 'GET',
                url    : '/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod',
                params : {
                    '$filter': _f(`Plant eq '${plantCode}'`),
                    '$select': 'Material,Plant,StorageLocation,MatlWrhsStkQtyInMatlBaseUnit,InQualityInspectionStockQty,BlockedStockQty,TransitStockQty,BaseUnit',
                    '$format': 'json',
                    '$top'   : '2000',
                },
            }
        );
        return (res.data?.d?.results || []).map(i => ({
            materialCode   : (i.Material || '').trim(),
            plantCode      : i.Plant,
            storageLocation: i.StorageLocation,
            unrestricted   : parseFloat(i.MatlWrhsStkQtyInMatlBaseUnit) || 0,
            qualInspection : parseFloat(i.InQualityInspectionStockQty)  || 0,
            blocked        : parseFloat(i.BlockedStockQty)              || 0,
            inTransit      : parseFloat(i.TransitStockQty)              || 0,
            uom            : i.BaseUnit || 'MT',
        }));
    }

    // ── PHYS domain — API_PHYSICAL_INVENTORY_DOC_SRV ───────────────────
    async getPhysicalInventory(plantCode, period) {
        const { fiscalYear } = _periodDates(period);
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method : 'GET',
                url    : '/sap/opu/odata/sap/API_PHYSICAL_INVENTORY_DOC_SRV/A_PhysInventoryDocHeader',
                params : {
                    '$filter': _f(`PlantOfPhysInvtryDoc eq '${plantCode}' and FiscalYear eq '${fiscalYear}'`),
                    '$expand': 'to_PhysInventoryDocItem',
                    '$format': 'json',
                    '$top'   : '1000',
                },
            }
        );
        const headers = res.data?.d?.results || [];
        const items   = [];
        for (const hdr of headers) {
            for (const item of (hdr.to_PhysInventoryDocItem?.results || [])) {
                items.push({
                    docNumber      : hdr.PhysicalInventoryDocument,
                    docType        : 'MI07',
                    plantCode      : hdr.PlantOfPhysInvtryDoc,
                    storageLocation: item.StorageLocation,
                    materialCode   : (item.Material || '').trim(),
                    countedQty     : parseFloat(item.CountedQtyInEntryUnit)   || 0,
                    bookQty        : parseFloat(item.BookQuantityInEntryUnit)  || 0,
                    uom            : item.UnitOfEntry || 'MT',
                    isPosted       : item.IsPhysInvtryItemHasPosting === true ||
                                     item.IsPhysInvtryItemHasPosting === 'true',
                });
            }
        }
        return items;
    }
}

module.exports = new S4Client();
