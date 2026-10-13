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

// Cloud SDK v4 paramsSerializer strips encoding from params values — the single quote
// in OData filter strings reaches Node.js raw, causing "Request path contains unescaped
// characters". Fix: embed the query string directly in the url field so Axios never
// touches it. Only encode the chars OData requires: spaces and single quotes.
const _qs = (pairs) => Object.entries(pairs)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

const _fEncode = (filter) => filter.replace(/ /g, '%20').replace(/'/g, '%27');

class S4Client {

    // ── MASTER DATA — Plants (derived from movement doc plant field) ──
    async getPlants() {
        // Step 1: unique plant codes from movement docs (always authorized for MM user)
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url   : '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentItem',
                params: { '$select': 'Plant', '$format': 'json', '$top': '5000' },
            }
        );
        const codes = [...new Set((res.data?.d?.results || []).map(r => (r.Plant || '').trim()).filter(Boolean))];
        const plants = codes.map(c => ({ plantCode: c, plantName: c, country: '', region: '' }));

        if (!plants.length) return plants;

        // Step 2: enrich with plant descriptions from API_PRODUCT_SRV plant entity (if activated)
        // API_PRODUCT_SRV exposes A_ProductPlant which links materials to plants with
        // country-of-origin data; for actual plant descriptions we try the purchasing org entity.
        try {
            const pRes = await executeHttpRequest(
                { destinationName: DEST },
                {
                    method: 'GET',
                    url: `/sap/opu/odata/sap/API_PRODUCT_SRV/A_ProductPlant?` +
                        _qs({
                            '$select': 'Plant,CountryOfOrigin',
                            '$format': 'json',
                            '$top'   : '500',
                        }),
                }
            );
            const plantMeta = {};
            for (const r of (pRes.data?.d?.results || [])) {
                if (r.Plant && !plantMeta[r.Plant]) {
                    plantMeta[r.Plant] = { country: r.CountryOfOrigin || '' };
                }
            }
            return plants.map(p => ({
                ...p,
                country: plantMeta[p.plantCode]?.country || '',
            }));
        } catch (err) {
            console.warn(`[S4Client] API_PRODUCT_SRV/A_ProductPlant unavailable (${err.message}) — plant names remain as codes`);
            return plants;
        }
    }

    // ── MASTER DATA — Materials (derived from movement docs + product master) ──
    async getMaterials() {
        // Step 1: unique material codes + base UOM from movement docs (always authorized)
        const movRes = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url   : '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentItem',
                params: { '$select': 'Material,EntryUnit', '$format': 'json', '$top': '5000' },
            }
        );
        const seen = new Set();
        const baseMats = (movRes.data?.d?.results || [])
            .filter(r => r.Material && !seen.has(r.Material) && seen.add(r.Material))
            .map(r => ({
                materialCode: (r.Material || '').trim(),
                materialDesc: (r.Material || '').trim(),
                baseUom     : r.EntryUnit || 'MT',
                productGroup: 'GP',
            }));

        if (!baseMats.length) return baseMats;

        // Step 2: enrich with English descriptions from API_PRODUCT_SRV (if activated)
        const descMap = {};
        try {
            const descRes = await executeHttpRequest(
                { destinationName: DEST },
                {
                    method: 'GET',
                    url: `/sap/opu/odata/sap/API_PRODUCT_SRV/A_ProductDescription?` +
                        _qs({
                            '$filter': _fEncode(`Language eq 'EN'`),
                            '$select': 'Material,MaterialDescription',
                            '$format': 'json',
                            '$top'   : '2000',
                        }),
                }
            );
            for (const d of (descRes.data?.d?.results || [])) {
                if (d.Material) descMap[(d.Material || '').trim()] = d.MaterialDescription || '';
            }
            console.log(`[S4Client] Fetched ${Object.keys(descMap).length} material descriptions from API_PRODUCT_SRV`);
        } catch (err) {
            console.warn(`[S4Client] API_PRODUCT_SRV/A_ProductDescription unavailable (${err.message}) — using material codes as descriptions`);
        }

        // Step 3: enrich with material type / product group from A_Product (if activated)
        const prodMap = {};
        try {
            const prodRes = await executeHttpRequest(
                { destinationName: DEST },
                {
                    method: 'GET',
                    url: `/sap/opu/odata/sap/API_PRODUCT_SRV/A_Product?` +
                        _qs({
                            '$select': 'Material,MaterialType,BaseUnit',
                            '$format': 'json',
                            '$top'   : '2000',
                        }),
                }
            );
            for (const p of (prodRes.data?.d?.results || [])) {
                if (p.Material) prodMap[(p.Material || '').trim()] = {
                    materialType: p.MaterialType || '',
                    baseUom     : p.BaseUnit || '',
                };
            }
            console.log(`[S4Client] Fetched ${Object.keys(prodMap).length} material records from API_PRODUCT_SRV/A_Product`);
        } catch (err) {
            console.warn(`[S4Client] API_PRODUCT_SRV/A_Product unavailable (${err.message}) — using defaults`);
        }

        return baseMats.map(m => ({
            materialCode: m.materialCode,
            materialDesc: descMap[m.materialCode] || m.materialCode,
            baseUom     : prodMap[m.materialCode]?.baseUom || m.baseUom,
            productGroup: prodMap[m.materialCode]?.materialType || 'GP',
        }));
    }

    // ── MASTER DATA — Storage Locations (from stock table per plant) ──
    async getStorageLocations(plantCode) {
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url: `/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod?` +
                    _qs({
                        '$filter': _fEncode(`Plant eq '${plantCode}'`),
                        '$select': 'StorageLocation,Plant',
                        '$format': 'json',
                        '$top'   : '500',
                    }),
            }
        );
        const slocs = [...new Set((res.data?.d?.results || []).map(r => r.StorageLocation).filter(Boolean))];
        return slocs.map(sl => ({ storageLocation: sl, plantCode }));
    }

    // ── MOV domain — API_MATERIAL_DOCUMENT_SRV ─────────────────────────
    // PostingDate lives on A_MaterialDocumentHeader, not on items.
    // Filter by date on the header, expand items, then filter items by Plant.
    async getMovements(plantCode, period) {
        const { startDate, endDate } = _periodDates(period);
        const filter = _fEncode(
            `PostingDate ge datetime'${startDate}T00:00:00' and PostingDate le datetime'${endDate}T23:59:59'`
        );
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url: `/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentHeader?` +
                    _qs({
                        '$filter': filter,
                        '$expand': 'to_MaterialDocumentItem',
                        '$format': 'json',
                        '$top'   : '1000',
                    }),
            }
        );
        const headers = res.data?.d?.results || [];
        const items = [];
        for (const hdr of headers) {
            const postDate = hdr.PostingDate
                ? hdr.PostingDate.replace(/\/Date\((\d+)\)\//, (_, ms) =>
                    new Date(Number(ms)).toISOString().split('T')[0])
                : null;
            for (const item of (hdr.to_MaterialDocumentItem?.results || [])) {
                if (item.Plant !== plantCode) continue;
                items.push({
                    docNumber       : hdr.MaterialDocument,
                    lineItem        : item.MaterialDocumentItem,
                    materialCode    : (item.Material || '').trim(),
                    plantCode       : item.Plant,
                    storageLocation : item.StorageLocation,
                    movementType    : item.GoodsMovementType,
                    movementCategory: MOV_TYPE_TO_CAT[item.GoodsMovementType] || 'GR',
                    postingDate     : postDate,
                    quantity        : parseFloat(item.QuantityInEntryUnit) || 0,
                    uom             : item.EntryUnit || 'MT',
                });
            }
        }
        return items;
    }

    // ── BOOK domain — API_MATERIAL_STOCK_SRV ───────────────────────────
    // Falls back to deriving net stock from all-time movements if the stock API
    // is not activated on the system (404) or if no results are returned.
    async getBookStock(plantCode) {
        try {
            const res = await executeHttpRequest(
                { destinationName: DEST },
                {
                    method: 'GET',
                    url: `/sap/opu/odata/sap/API_MATERIAL_STOCK_SRV/A_MatlStkInAcctMod?` +
                        _qs({
                            '$filter': _fEncode(`Plant eq '${plantCode}'`),
                            '$select': 'Material,Plant,StorageLocation,MatlWrhsStkQtyInMatlBaseUnit,InQualityInspectionStockQty,BlockedStockQty,TransitStockQty,BaseUnit',
                            '$format': 'json',
                            '$top'   : '2000',
                        }),
                }
            );
            const rows = res.data?.d?.results || [];
            if (rows.length > 0) {
                return rows.map(i => ({
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
        } catch (err) {
            // API_MATERIAL_STOCK_SRV not available — fall through to movement-based derivation
            console.warn(`[S4Client] Stock API unavailable (${err.message}), deriving book stock from movements`);
        }
        // Derive net book stock from all-time material movements for the plant
        return this._deriveBookStockFromMovements(plantCode);
    }

    async _deriveBookStockFromMovements(plantCode) {
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url: `/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/A_MaterialDocumentItem?` +
                    _qs({
                        '$filter': _fEncode(`Plant eq '${plantCode}'`),
                        '$select': 'Material,StorageLocation,GoodsMovementType,QuantityInEntryUnit,EntryUnit',
                        '$format': 'json',
                        '$top'   : '5000',
                    }),
            }
        );
        const items = res.data?.d?.results || [];
        console.log(`[S4Client] _deriveBookStockFromMovements plant=${plantCode}: ${items.length} movement items`);
        // Aggregate net quantity per material+storageLocation (GR positive, GI negative)
        const netMap = {};
        for (const i of items) {
            const mat  = (i.Material || '').trim();
            const sloc = i.StorageLocation || '';
            const key  = `${mat}|${sloc}`;
            const qty  = parseFloat(i.QuantityInEntryUnit) || 0;
            const cat  = MOV_TYPE_TO_CAT[i.GoodsMovementType] || 'GR';
            const sign = (cat === 'GI' || cat === 'CONSUMPTION') ? -1 : 1;
            if (!netMap[key]) netMap[key] = { materialCode: mat, storageLocation: sloc, uom: i.EntryUnit || 'MT', net: 0 };
            netMap[key].net += sign * qty;
        }
        const netEntries = Object.values(netMap);
        console.log(`[S4Client] Derived ${netEntries.length} net book stock positions for plant=${plantCode}`);
        return netEntries.map(r => ({
            materialCode   : r.materialCode,
            plantCode,
            storageLocation: r.storageLocation,
            unrestricted   : Math.max(0, parseFloat(r.net.toFixed(3))),
            qualInspection : 0,
            blocked        : 0,
            inTransit      : 0,
            uom            : r.uom,
        }));
    }

    // ── PHYS domain — API_PHYSICAL_INVENTORY_DOC_SRV ───────────────────
    async getPhysicalInventory(plantCode, period) {
        const { fiscalYear } = _periodDates(period);
        const res = await executeHttpRequest(
            { destinationName: DEST },
            {
                method: 'GET',
                url: `/sap/opu/odata/sap/API_PHYSICAL_INVENTORY_DOC_SRV/A_PhysInventoryDocHeader?` +
                    _qs({
                        '$filter': _fEncode(`PlantOfPhysInvtryDoc eq '${plantCode}' and FiscalYear eq '${fiscalYear}'`),
                        '$expand': 'to_PhysInventoryDocItem',
                        '$format': 'json',
                        '$top'   : '1000',
                    }),
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
