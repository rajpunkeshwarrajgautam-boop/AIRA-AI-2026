/**
 * AIRA AI 2026 — Indian Goods and Services Tax (GST) Determination & FY Helper
 *
 * Verified Supplier Identity (`SPEC-GST-BILLING-2026-01`):
 * - Legal Entity: VIREXA AI VENTURES PRIVATE LIMITED (Trade: VIREXA AI VENTURES)
 * - PAN: AAMCV4678C | CIN: U58201UP2026PTC250225
 * - Supplier Jurisdiction: Uttar Pradesh ('09') — Lucknow, 226010
 * - Billing Support Email: virexaiventures@gmail.com
 *
 * Statutory Rules Enforced:
 * - IGST Act Sec 12(2): B2B GSTIN -> B2C Recipient State -> NEVER silent UNKNOWN -> IGST.
 * - CGST Act Sec 31 & Sec 34: IST Financial Year (Apr 1 – Mar 31), integer minor-unit precision,
 *   proportional Credit Note tax reconciliation, CGST+SGST vs CGST+UTGST vs IGST determination.
 * - Fail-closed production guard: SAC 998315 and 18% GST are treated strictly as provisional
 *   sandbox/configurable fixtures until GST non-core amendment approval (`AIRA_SUPPLIER_SAC_APPROVED`)
 *   and written Finance/CA sign-off (`AIRA_FINANCE_TAX_SIGNOFF`).
 */

export interface IndianGstJurisdiction {
  code: string;
  name: string;
  shortCode: string;
  type: 'STATE' | 'UT_WITH_LEGISLATURE' | 'UT_WITHOUT_LEGISLATURE' | 'OTHER_TERRITORY';
  isUtgst: boolean;
}

export const INDIAN_GST_JURISDICTIONS: readonly IndianGstJurisdiction[] = Object.freeze([
  { code: '01', name: 'Jammu and Kashmir', shortCode: 'JK', type: 'UT_WITH_LEGISLATURE', isUtgst: false },
  { code: '02', name: 'Himachal Pradesh', shortCode: 'HP', type: 'STATE', isUtgst: false },
  { code: '03', name: 'Punjab', shortCode: 'PB', type: 'STATE', isUtgst: false },
  { code: '04', name: 'Chandigarh', shortCode: 'CH', type: 'UT_WITHOUT_LEGISLATURE', isUtgst: true },
  { code: '05', name: 'Uttarakhand', shortCode: 'UK', type: 'STATE', isUtgst: false },
  { code: '06', name: 'Haryana', shortCode: 'HR', type: 'STATE', isUtgst: false },
  { code: '07', name: 'Delhi', shortCode: 'DL', type: 'UT_WITH_LEGISLATURE', isUtgst: false },
  { code: '08', name: 'Rajasthan', shortCode: 'RJ', type: 'STATE', isUtgst: false },
  { code: '09', name: 'Uttar Pradesh', shortCode: 'UP', type: 'STATE', isUtgst: false },
  { code: '10', name: 'Bihar', shortCode: 'BR', type: 'STATE', isUtgst: false },
  { code: '11', name: 'Sikkim', shortCode: 'SK', type: 'STATE', isUtgst: false },
  { code: '12', name: 'Arunachal Pradesh', shortCode: 'AR', type: 'STATE', isUtgst: false },
  { code: '13', name: 'Nagaland', shortCode: 'NL', type: 'STATE', isUtgst: false },
  { code: '14', name: 'Manipur', shortCode: 'MN', type: 'STATE', isUtgst: false },
  { code: '15', name: 'Mizoram', shortCode: 'MZ', type: 'STATE', isUtgst: false },
  { code: '16', name: 'Tripura', shortCode: 'TR', type: 'STATE', isUtgst: false },
  { code: '17', name: 'Meghalaya', shortCode: 'ML', type: 'STATE', isUtgst: false },
  { code: '18', name: 'Assam', shortCode: 'AS', type: 'STATE', isUtgst: false },
  { code: '19', name: 'West Bengal', shortCode: 'WB', type: 'STATE', isUtgst: false },
  { code: '20', name: 'Jharkhand', shortCode: 'JH', type: 'STATE', isUtgst: false },
  { code: '21', name: 'Odisha', shortCode: 'OD', type: 'STATE', isUtgst: false },
  { code: '22', name: 'Chhattisgarh', shortCode: 'CG', type: 'STATE', isUtgst: false },
  { code: '23', name: 'Madhya Pradesh', shortCode: 'MP', type: 'STATE', isUtgst: false },
  { code: '24', name: 'Gujarat', shortCode: 'GJ', type: 'STATE', isUtgst: false },
  // Note: Code 25 (former Daman & Diu) merged into 26 on 26 Jan 2020 and is intentionally rejected.
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', shortCode: 'DN', type: 'UT_WITHOUT_LEGISLATURE', isUtgst: true },
  { code: '27', name: 'Maharashtra', shortCode: 'MH', type: 'STATE', isUtgst: false },
  { code: '29', name: 'Karnataka', shortCode: 'KA', type: 'STATE', isUtgst: false },
  { code: '30', name: 'Goa', shortCode: 'GA', type: 'STATE', isUtgst: false },
  { code: '31', name: 'Lakshadweep', shortCode: 'LD', type: 'UT_WITHOUT_LEGISLATURE', isUtgst: true },
  { code: '32', name: 'Kerala', shortCode: 'KL', type: 'STATE', isUtgst: false },
  { code: '33', name: 'Tamil Nadu', shortCode: 'TN', type: 'STATE', isUtgst: false },
  { code: '34', name: 'Puducherry', shortCode: 'PY', type: 'UT_WITH_LEGISLATURE', isUtgst: false },
  { code: '35', name: 'Andaman and Nicobar Islands', shortCode: 'AN', type: 'UT_WITHOUT_LEGISLATURE', isUtgst: true },
  { code: '36', name: 'Telangana', shortCode: 'TS', type: 'STATE', isUtgst: false },
  { code: '37', name: 'Andhra Pradesh', shortCode: 'AP', type: 'STATE', isUtgst: false },
  { code: '38', name: 'Ladakh', shortCode: 'LA', type: 'UT_WITHOUT_LEGISLATURE', isUtgst: true },
  { code: '97', name: 'Other Territory', shortCode: 'OT', type: 'OTHER_TERRITORY', isUtgst: false }
]);

const JURISDICTION_BY_CODE = new Map<string, IndianGstJurisdiction>(
  INDIAN_GST_JURISDICTIONS.map((j) => [j.code, j])
);

const STATE_ALIAS_TO_CODE: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const j of INDIAN_GST_JURISDICTIONS) {
    map[j.code] = j.code;
    map[j.shortCode] = j.code;
    map[j.name.toUpperCase()] = j.code;
  }
  map['NEW DELHI'] = '07';
  map['NCT OF DELHI'] = '07';
  map['TG'] = '36';
  map['OR'] = '21';
  map['ORISSA'] = '21';
  map['UTTARANCHAL'] = '05';
  map['UA'] = '05';
  map['PONDICHERRY'] = '34';
  map['DNHDD'] = '26';
  map['DADRA AND NAGAR HAVELI'] = '26';
  return map;
})();

export const DEFAULT_SUPPLIER_LEGAL_NAME = 'VIREXA AI VENTURES PRIVATE LIMITED';
export const DEFAULT_SUPPLIER_TRADE_NAME = 'VIREXA AI VENTURES';
export const DEFAULT_SUPPLIER_STATE_CODE = '09'; // Uttar Pradesh
export const DEFAULT_SUPPLIER_ADDRESS =
  '2/290, Gomti Nagar, Virat Khand, Lucknow, Uttar Pradesh, 226010, India';
export const DEFAULT_SUPPLIER_PAN = 'AAMCV4678C';
export const DEFAULT_SUPPLIER_CIN = 'U58201UP2026PTC250225';
export const DEFAULT_SUPPLIER_EMAIL = 'virexaiventures@gmail.com';
export const DEFAULT_PROVISIONAL_SAC_CODE = '998315';
export const DEFAULT_PROVISIONAL_SAC_DESCRIPTION =
  'Hosting and information technology infrastructure provisioning services';

export type GstRegistrationMode = 'REGULAR' | 'UNREGISTERED' | 'COMPOSITION';
export type TaxRoundingPolicy = 'FLOOR_REMAINDER' | 'PARITY_HALF_EVEN';
export type PlaceOfSupplyBasis =
  | 'RECIPIENT_GSTIN'
  | 'RECIPIENT_ADDRESS'
  | 'SUPPLIER_LOCATION_SEC12_2_B_II'
  | 'EXPORT_OUTSIDE_INDIA'
  | 'UNRESOLVED';

export type TaxComplianceStatus =
  | 'COMPLIANT'
  | 'COMPLIANT_ZERO_RATED_EXPORT'
  | 'PROVISIONAL_PENDING_GSTIN'
  | 'PROVISIONAL_PENDING_PLACE_OF_SUPPLY'
  | 'PROVISIONAL_PENDING_GSTIN_VERIFICATION'
  | 'PROVISIONAL_PENDING_GSTIN_AND_POS'
  | 'PROVISIONAL_PENDING_TAX_APPROVAL'
  | 'NON_TAX_RECEIPT';

export interface GstinValidationResult {
  valid: boolean;
  normalized: string;
  stateCode?: string;
  stateName?: string;
  panSlice?: string;
  reason?: string;
}

export interface IndianFinancialYearInfo {
  financialYear: string; // e.g., '2026-27'
  compactFy: string; // e.g., '26-27'
  startYear: number;
  endYear: number;
  gstr1CreditNoteCutoff: string; // e.g., '2027-11-30'
  issueDateIst: string; // e.g., '2026-11-28'
}

export interface SupplierTaxConfig {
  registrationMode: GstRegistrationMode;
  legalName: string;
  tradeName: string;
  gstin?: string;
  gstinVerified: boolean;
  pan: string;
  cin: string;
  address: string;
  stateCode: string;
  stateName: string;
  supportEmail: string;
  sacCode: string;
  sacDescription: string;
  sacApproved: boolean;
  financeTaxSignOff: boolean;
  gstRatePercent: number;
  rateVersion: string;
  roundingPolicy: TaxRoundingPolicy;
  einvoiceIrnRequired: boolean;
}

export interface TaxDeterminationInput {
  amountMinorUnits: number;
  currency?: string;
  customerCountry?: string;
  customerState?: string;
  placeOfSupply?: string;
  customerGstin?: string;
  supplierState?: string;
  supplierGstin?: string;
  supplierGstinVerified?: boolean;
  supplierName?: string;
  sacCode?: string;
  sacDescription?: string;
  sacApproved?: boolean;
  financeTaxSignOff?: boolean;
  registrationMode?: GstRegistrationMode;
  roundingPolicy?: TaxRoundingPolicy;
  allowSupplierFallbackSec12_2_b_ii?: boolean;
  lutNumber?: string;
  lutAvailable?: boolean;
  taxRate?: number;
  taxRateVersion?: string;
}

export interface TaxDeterminationResult {
  totalAmount: number;
  totalAmountMinorUnits: number;
  taxableBase: number;
  taxableBaseMinorUnits: number;
  gstAmount: number;
  gstAmountMinorUnits: number;
  cgstAmount?: number;
  cgstAmountMinorUnits?: number;
  sgstAmount?: number;
  sgstAmountMinorUnits?: number;
  utgstAmount?: number;
  utgstAmountMinorUnits?: number;
  igstAmount?: number;
  igstAmountMinorUnits?: number;
  taxRate: number;
  cgstRate?: number;
  sgstRate?: number;
  utgstRate?: number;
  igstRate?: number;
  taxRateVersion: string;
  roundingPolicy: TaxRoundingPolicy;
  sacCode: string;
  sacDescription: string;
  isProvisionalFixture: boolean;
  supplierName: string;
  supplierTradeName: string;
  supplierGstin?: string;
  supplierState: string;
  supplierStateName: string;
  supplierAddress: string;
  supplierPan: string;
  supplierCin: string;
  supplierEmail: string;
  placeOfSupply: string;
  placeOfSupplyName?: string;
  posBasis: PlaceOfSupplyBasis;
  isB2b: boolean;
  customerGstin?: string;
  customerCountry: string;
  isExport: boolean;
  lutNumber?: string;
  lutApproved: boolean;
  registrationMode: GstRegistrationMode;
  taxComplianceStatus: TaxComplianceStatus;
}

export interface ProportionalRefundTaxInput {
  originalTotalMinorUnits: number;
  originalTaxableMinorUnits: number;
  originalGstMinorUnits: number;
  originalCgstMinorUnits: number;
  originalSgstMinorUnits: number;
  originalUtgstMinorUnits: number;
  originalIgstMinorUnits: number;
  alreadyRefundedTotalMinorUnits: number;
  alreadyRefundedTaxableMinorUnits: number;
  alreadyRefundedGstMinorUnits: number;
  alreadyRefundedCgstMinorUnits: number;
  alreadyRefundedSgstMinorUnits: number;
  alreadyRefundedUtgstMinorUnits: number;
  alreadyRefundedIgstMinorUnits: number;
  refundMinorUnits: number;
}

export interface ProportionalRefundTaxResult {
  refundMinorUnits: number;
  refundMajor: number;
  taxableBaseMinorUnits: number;
  taxableBaseMajor: number;
  gstAmountMinorUnits: number;
  gstAmountMajor: number;
  cgstMinorUnits: number;
  cgstMajor: number;
  sgstMinorUnits: number;
  sgstMajor: number;
  utgstMinorUnits: number;
  utgstMajor: number;
  igstMinorUnits: number;
  igstMajor: number;
}

const GSTIN_CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function toMajorUnits(minorUnits: number): number {
  return Math.round(minorUnits) / 100;
}

/**
 * Computes authoritative GSTIN Mod-36 checksum verification and jurisdiction consistency.
 */
export function validateGstin(
  rawGstin: string,
  options?: { expectedStateCode?: string; expectedPan?: string }
): GstinValidationResult {
  const normalized = String(rawGstin || '').trim().toUpperCase();
  if (!normalized) {
    return { valid: false, normalized: '', reason: 'GSTIN is empty.' };
  }
  if (!GSTIN_REGEX.test(normalized)) {
    return {
      valid: false,
      normalized,
      reason: 'GSTIN must match 15-character Indian GSTIN format (SSPPPPPPPPPPZ1C).'
    };
  }

  const stateCode = normalized.slice(0, 2);
  const panSlice = normalized.slice(2, 12);
  if (stateCode === '25') {
    return {
      valid: false,
      normalized,
      stateCode,
      panSlice,
      reason: 'State code 25 (legacy Daman & Diu) is merged into 26.'
    };
  }
  const jurisdiction = JURISDICTION_BY_CODE.get(stateCode);
  if (!jurisdiction) {
    return {
      valid: false,
      normalized,
      stateCode,
      panSlice,
      reason: `Unsupported Indian GST state/UT prefix '${stateCode}'.`
    };
  }

  let factor = 1;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const codePoint = GSTIN_CHARSET.indexOf(normalized[i]);
    if (codePoint < 0) {
      return { valid: false, normalized, stateCode, panSlice, reason: 'Invalid GSTIN character.' };
    }
    const product = codePoint * factor;
    factor = factor === 1 ? 2 : 1;
    sum += Math.floor(product / 36) + (product % 36);
  }
  const checkCodePoint = (36 - (sum % 36)) % 36;
  const expectedChar = GSTIN_CHARSET[checkCodePoint];
  if (normalized[14] !== expectedChar) {
    return {
      valid: false,
      normalized,
      stateCode,
      stateName: jurisdiction.name,
      panSlice,
      reason: 'GSTIN checksum verification failed.'
    };
  }

  if (options?.expectedStateCode && options.expectedStateCode !== stateCode) {
    return {
      valid: false,
      normalized,
      stateCode,
      stateName: jurisdiction.name,
      panSlice,
      reason: `GSTIN state prefix '${stateCode}' does not match expected state '${options.expectedStateCode}'.`
    };
  }

  if (options?.expectedPan && options.expectedPan.trim().toUpperCase() !== panSlice) {
    return {
      valid: false,
      normalized,
      stateCode,
      stateName: jurisdiction.name,
      panSlice,
      reason: `GSTIN PAN slice '${panSlice}' does not match company PAN.`
    };
  }

  return {
    valid: true,
    normalized,
    stateCode,
    stateName: jurisdiction.name,
    panSlice
  };
}

/**
 * Derives the Indian Financial Year (`April 1 – March 31`) strictly in IST (`Asia/Kolkata`).
 */
export function getIndianFinancialYear(epochMs: number = Date.now()): IndianFinancialYearInfo {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(epochMs));

  const year = Number(parts.find((p) => p.type === 'year')?.value || '2026');
  const month = Number(parts.find((p) => p.type === 'month')?.value || '4');
  const day = String(parts.find((p) => p.type === 'day')?.value || '01').padStart(2, '0');
  const monthStr = String(month).padStart(2, '0');

  const startYear = month >= 4 ? year : year - 1;
  const endYear = startYear + 1;
  const startShort = String(startYear).slice(-2);
  const endShort = String(endYear).slice(-2);

  return {
    financialYear: `${startYear}-${endShort}`,
    compactFy: `${startShort}-${endShort}`,
    startYear,
    endYear,
    gstr1CreditNoteCutoff: `${endYear}-11-30`,
    issueDateIst: `${year}-${monthStr}-${day}`
  };
}

/**
 * Splits minor-unit GST proportionally across cumulative refunds so partial refunds
 * sum identically back to the original invoice without orphaned paise.
 */
export function calculateProportionalRefundTax(input: ProportionalRefundTaxInput): ProportionalRefundTaxResult {
  const origTotal = Math.max(0, Math.round(input.originalTotalMinorUnits));
  const refund = Math.max(0, Math.round(input.refundMinorUnits));
  if (origTotal <= 0 || refund <= 0) {
    return {
      refundMinorUnits: 0,
      refundMajor: 0,
      taxableBaseMinorUnits: 0,
      taxableBaseMajor: 0,
      gstAmountMinorUnits: 0,
      gstAmountMajor: 0,
      cgstMinorUnits: 0,
      cgstMajor: 0,
      sgstMinorUnits: 0,
      sgstMajor: 0,
      utgstMinorUnits: 0,
      utgstMajor: 0,
      igstMinorUnits: 0,
      igstMajor: 0
    };
  }

  const clampNonNegInt = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  const alreadyTotal = clampNonNegInt(input.alreadyRefundedTotalMinorUnits);
  const alreadyCgst = clampNonNegInt(input.alreadyRefundedCgstMinorUnits);
  const alreadySgst = clampNonNegInt(input.alreadyRefundedSgstMinorUnits);
  const alreadyUtgst = clampNonNegInt(input.alreadyRefundedUtgstMinorUnits);
  const alreadyIgst = clampNonNegInt(input.alreadyRefundedIgstMinorUnits);

  const cumulativeRefunded = Math.min(origTotal, alreadyTotal + refund);
  const ratio = cumulativeRefunded / origTotal;

  const targetTaxableCum = Math.round(input.originalTaxableMinorUnits * ratio);
  const targetGstCum = cumulativeRefunded - targetTaxableCum;

  let cgstMinor = 0;
  let sgstMinor = 0;
  let utgstMinor = 0;
  let igstMinor = 0;

  if (input.originalIgstMinorUnits > 0 && input.originalCgstMinorUnits === 0) {
    igstMinor = Math.max(0, targetGstCum - alreadyIgst);
  } else if (input.originalGstMinorUnits > 0) {
    const targetCgstCum = Math.round(input.originalCgstMinorUnits * ratio);
    cgstMinor = Math.max(0, targetCgstCum - alreadyCgst);

    if (input.originalUtgstMinorUnits > 0) {
      const targetUtgstCum = Math.max(0, targetGstCum - targetCgstCum);
      utgstMinor = Math.max(0, targetUtgstCum - alreadyUtgst);
    } else {
      const targetSgstCum = Math.max(0, targetGstCum - targetCgstCum);
      sgstMinor = Math.max(0, targetSgstCum - alreadySgst);
    }
  }

  const gstMinor = cgstMinor + sgstMinor + utgstMinor + igstMinor;
  const taxableMinor = Math.max(0, refund - gstMinor);

  return {
    refundMinorUnits: refund,
    refundMajor: toMajorUnits(refund),
    taxableBaseMinorUnits: taxableMinor,
    taxableBaseMajor: toMajorUnits(taxableMinor),
    gstAmountMinorUnits: gstMinor,
    gstAmountMajor: toMajorUnits(gstMinor),
    cgstMinorUnits: cgstMinor,
    cgstMajor: toMajorUnits(cgstMinor),
    sgstMinorUnits: sgstMinor,
    sgstMajor: toMajorUnits(sgstMinor),
    utgstMinorUnits: utgstMinor,
    utgstMajor: toMajorUnits(utgstMinor),
    igstMinorUnits: igstMinor,
    igstMajor: toMajorUnits(igstMinor)
  };
}

export class TaxDeterminationService {
  /**
   * Resolves normalized 2-digit Indian GST State/UT code, rejecting retired code '25'.
   * Returns 'UNKNOWN' if empty, missing, or unrecognized.
   */
  normalizePlaceOfSupply(inputState?: string): string {
    if (!inputState) return 'UNKNOWN';
    const raw = inputState.toString().trim().toUpperCase();
    if (!raw) return 'UNKNOWN';
    if (raw === '25' || raw === 'DD' || raw === 'DAMAN AND DIU') return 'UNKNOWN';

    // Handle values formatted like "09 - Uttar Pradesh" or "09 (Uttar Pradesh)"
    const leadingDigits = raw.match(/^(\d{2})(?:\b|\s|-)/);
    if (leadingDigits && JURISDICTION_BY_CODE.has(leadingDigits[1])) {
      return leadingDigits[1];
    }

    const clean = raw.replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean === '25') return 'UNKNOWN';
    if (STATE_ALIAS_TO_CODE[clean]) return STATE_ALIAS_TO_CODE[clean];
    if (JURISDICTION_BY_CODE.has(clean)) return clean;
    return 'UNKNOWN';
  }

  getJurisdiction(code?: string): IndianGstJurisdiction | undefined {
    const normalized = this.normalizePlaceOfSupply(code);
    if (normalized === 'UNKNOWN') return undefined;
    return JURISDICTION_BY_CODE.get(normalized);
  }

  listSupportedStates(): readonly IndianGstJurisdiction[] {
    return INDIAN_GST_JURISDICTIONS;
  }

  /**
   * Loads active supplier tax configuration from environment variables with verified
   * VIREXA AI VENTURES PRIVATE LIMITED (UP 09) non-production fixture defaults.
   */
  getSupplierTaxConfig(): SupplierTaxConfig {
    const rawMode = (process.env.AIRA_GST_REGISTRATION_MODE || 'REGULAR').trim().toUpperCase();
    const registrationMode: GstRegistrationMode =
      rawMode === 'UNREGISTERED' || rawMode === 'COMPOSITION' ? rawMode : 'REGULAR';

    const stateCodeRaw = (
      process.env.AIRA_SUPPLIER_STATE_CODE ||
      process.env.AIRA_SUPPLIER_STATE ||
      DEFAULT_SUPPLIER_STATE_CODE
    ).trim();
    const stateNormalized = this.normalizePlaceOfSupply(stateCodeRaw);
    const stateCode = stateNormalized !== 'UNKNOWN' ? stateNormalized : DEFAULT_SUPPLIER_STATE_CODE;
    const jurisdiction = JURISDICTION_BY_CODE.get(stateCode);

    const rawRatePct = process.env.AIRA_GST_RATE_PERCENT?.trim();
    const rawRateFrac = process.env.AIRA_GST_RATE?.trim();
    let gstRatePercent = 18;
    if (rawRatePct && Number.isFinite(Number(rawRatePct))) {
      gstRatePercent = Number(rawRatePct);
    } else if (rawRateFrac && Number.isFinite(Number(rawRateFrac))) {
      gstRatePercent = Number(rawRateFrac) <= 1 ? Number(rawRateFrac) * 100 : Number(rawRateFrac);
    }

    const sacCode = (process.env.AIRA_SUPPLIER_SAC_CODE || DEFAULT_PROVISIONAL_SAC_CODE).trim();
    const sacDescription = (
      process.env.AIRA_SUPPLIER_SAC_DESCRIPTION || DEFAULT_PROVISIONAL_SAC_DESCRIPTION
    ).trim();
    const sacApproved = process.env.AIRA_SUPPLIER_SAC_APPROVED === 'true';
    const financeTaxSignOff = process.env.AIRA_FINANCE_TAX_SIGNOFF === 'true';

    const roundingRaw = (process.env.AIRA_GST_ROUNDING_POLICY || 'FLOOR_REMAINDER').trim().toUpperCase();
    const roundingPolicy: TaxRoundingPolicy =
      roundingRaw === 'PARITY_HALF_EVEN' ? 'PARITY_HALF_EVEN' : 'FLOOR_REMAINDER';

    const gstin = (process.env.AIRA_SUPPLIER_GSTIN || '').trim().toUpperCase() || undefined;
    const gstinVerified = Boolean(
      process.env.AIRA_SUPPLIER_GSTIN_VERIFIED === 'true' &&
      gstin &&
      validateGstin(gstin).valid
    );

    return {
      registrationMode,
      legalName: (process.env.AIRA_SUPPLIER_NAME || DEFAULT_SUPPLIER_LEGAL_NAME).trim(),
      tradeName: (process.env.AIRA_SUPPLIER_TRADE_NAME || DEFAULT_SUPPLIER_TRADE_NAME).trim(),
      gstin,
      gstinVerified,
      pan: (process.env.AIRA_SUPPLIER_PAN || DEFAULT_SUPPLIER_PAN).trim().toUpperCase(),
      cin: (process.env.AIRA_SUPPLIER_CIN || DEFAULT_SUPPLIER_CIN).trim().toUpperCase(),
      address: (process.env.AIRA_SUPPLIER_ADDRESS || DEFAULT_SUPPLIER_ADDRESS).trim(),
      stateCode,
      stateName: jurisdiction?.name || 'Uttar Pradesh',
      supportEmail: (process.env.AIRA_SUPPLIER_EMAIL || DEFAULT_SUPPLIER_EMAIL).trim(),
      sacCode,
      sacDescription,
      sacApproved,
      financeTaxSignOff,
      gstRatePercent,
      rateVersion: (
        process.env.AIRA_GST_RATE_VERSION ||
        `SAC_${sacCode}_${sacApproved ? 'APPROVED' : 'PROVISIONAL'}_v1`
      ).trim(),
      roundingPolicy,
      einvoiceIrnRequired: process.env.AIRA_EINVOICE_IRN_REQUIRED === 'true'
    };
  }

  determineTax(input: TaxDeterminationInput): TaxDeterminationResult {
    const config = this.getSupplierTaxConfig();
    const currency = (input.currency || 'INR').toUpperCase().trim();
    const isINR = currency === 'INR';

    const totalMinor = Math.max(0, Math.round(Number(input.amountMinorUnits || 0)));
    const totalAmount = toMajorUnits(totalMinor);

    let customerCountry = (input.customerCountry || (isINR ? 'IN' : 'UNKNOWN')).toUpperCase().trim();
    if (customerCountry === 'INDIA') customerCountry = 'IN';

    const supplierStateCandidate = input.supplierState
      ? this.normalizePlaceOfSupply(input.supplierState)
      : config.stateCode;
    const supplierState =
      supplierStateCandidate !== 'UNKNOWN' ? supplierStateCandidate : config.stateCode;
    const supplierJurisdiction = JURISDICTION_BY_CODE.get(supplierState);
    const supplierStateName = supplierJurisdiction?.name || config.stateName;

    const supplierGstin =
      (input.supplierGstin !== undefined ? input.supplierGstin : config.gstin)?.trim().toUpperCase() || undefined;
    const isProdRuntime = Boolean(
      process.env.VERCEL_ENV
        ? process.env.VERCEL_ENV === 'production'
        : process.env.NODE_ENV === 'production'
    );

    const gstinFormatCheck = supplierGstin
      ? validateGstin(supplierGstin, { expectedStateCode: supplierState })
      : { valid: false };
    const supplierGstinVerified = Boolean(
      input.supplierGstinVerified !== undefined
        ? input.supplierGstinVerified
        : (process.env.AIRA_SUPPLIER_GSTIN_VERIFIED === 'true' ||
            (!isProdRuntime && process.env.AIRA_SUPPLIER_GSTIN_VERIFIED !== 'false' && gstinFormatCheck.valid))
    );

    const registrationMode = input.registrationMode || config.registrationMode;
    const sacCode = (input.sacCode || config.sacCode).trim();
    const sacDescription = (input.sacDescription || config.sacDescription).trim();
    const sacApproved =
      input.sacApproved !== undefined
        ? input.sacApproved
        : (config.sacApproved || !isProdRuntime);
    const financeTaxSignOff =
      input.financeTaxSignOff !== undefined
        ? input.financeTaxSignOff
        : (config.financeTaxSignOff || !isProdRuntime);
    const isProvisionalFixture = !(sacApproved && financeTaxSignOff);

    if (input.taxRate !== undefined && input.taxRate !== null) {
      const providedRate = Number(input.taxRate);
      if (!Number.isFinite(providedRate) || providedRate < 0 || providedRate > 1) {
        throw new Error(`VALIDATION_ERROR: Invalid fractional GST rate '${String(input.taxRate)}'. Expected value in [0, 1].`);
      }
    }
    const effectiveRate =
      input.taxRate !== undefined && input.taxRate !== null
        ? Number(input.taxRate)
        : config.gstRatePercent / 100;
    const rateBps = Math.round(effectiveRate * 10000);
    const roundingPolicy = input.roundingPolicy || config.roundingPolicy;
    const taxRateVersion = (input.taxRateVersion || config.rateVersion).trim();

    const rawLutNumber = (input.lutNumber || process.env.AIRA_LUT_NUMBER || '').trim() || undefined;
    const lutNumber = rawLutNumber || (!isProdRuntime ? 'AD0903260012345' : undefined);
    const lutApproved = Boolean(
      (rawLutNumber || (!isProdRuntime && lutNumber)) &&
      (input.lutAvailable !== undefined
        ? input.lutAvailable
        : process.env.AIRA_LUT_AVAILABLE !== 'false')
    );
    const allowProvisionalZeroTaxExport = Boolean(
      !isProdRuntime &&
      input.lutAvailable !== false &&
      process.env.AIRA_LUT_AVAILABLE !== 'false'
    );
    const lutAvailable = lutApproved || allowProvisionalZeroTaxExport;

    const isVerifiedForeignCountry =
      /^[A-Z]{2}$/.test(customerCountry) &&
      customerCountry !== 'IN' &&
      customerCountry !== 'UNKNOWN';
    const isExport = isVerifiedForeignCountry && !isINR;

    // Validate optional recipient B2B GSTIN strictly if supplied
    let normalizedCustomerGstin: string | undefined;
    let isB2b = false;
    if (input.customerGstin && input.customerGstin.trim()) {
      const check = validateGstin(input.customerGstin);
      if (!check.valid) {
        throw new Error(`INVALID_GSTIN: ${check.reason || 'Recipient GSTIN is invalid.'}`);
      }
      normalizedCustomerGstin = check.normalized;
      isB2b = true;
    }

    // Non-Regular supplier registration modes cannot emit GST breakdown
    if (registrationMode === 'UNREGISTERED' || registrationMode === 'COMPOSITION') {
      const posResolved = normalizedCustomerGstin
        ? normalizedCustomerGstin.slice(0, 2)
        : this.normalizePlaceOfSupply(input.placeOfSupply || input.customerState);
      const finalPos = posResolved !== 'UNKNOWN' ? posResolved : supplierState;
      return {
        totalAmount,
        totalAmountMinorUnits: totalMinor,
        taxableBase: totalAmount,
        taxableBaseMinorUnits: totalMinor,
        gstAmount: 0,
        gstAmountMinorUnits: 0,
        taxRate: 0,
        taxRateVersion,
        roundingPolicy,
        sacCode,
        sacDescription,
        isProvisionalFixture,
        supplierName: input.supplierName || config.legalName,
        supplierTradeName: config.tradeName,
        supplierGstin: registrationMode === 'COMPOSITION' ? supplierGstin : undefined,
        supplierState,
        supplierStateName,
        supplierAddress: config.address,
        supplierPan: config.pan,
        supplierCin: config.cin,
        supplierEmail: config.supportEmail,
        placeOfSupply: finalPos,
        placeOfSupplyName: JURISDICTION_BY_CODE.get(finalPos)?.name,
        posBasis: normalizedCustomerGstin
          ? 'RECIPIENT_GSTIN'
          : (posResolved !== 'UNKNOWN' ? 'RECIPIENT_ADDRESS' : 'SUPPLIER_LOCATION_SEC12_2_B_II'),
        isB2b,
        customerGstin: normalizedCustomerGstin,
        customerCountry,
        isExport,
        lutNumber,
        lutApproved: false,
        registrationMode,
        taxComplianceStatus: 'NON_TAX_RECEIPT'
      };
    }

    let complianceStatus: TaxComplianceStatus = 'COMPLIANT';
    if (!supplierGstin || !gstinFormatCheck.valid) {
      complianceStatus = 'PROVISIONAL_PENDING_GSTIN';
    } else if (!supplierGstinVerified) {
      complianceStatus = 'PROVISIONAL_PENDING_GSTIN_VERIFICATION';
    } else if (isProvisionalFixture) {
      complianceStatus = 'PROVISIONAL_PENDING_TAX_APPROVAL';
    }

    let taxableMinor = totalMinor;
    let gstMinor = 0;
    let cgstMinor: number | undefined;
    let sgstMinor: number | undefined;
    let utgstMinor: number | undefined;
    let igstMinor: number | undefined;
    let cgstRate: number | undefined;
    let sgstRate: number | undefined;
    let utgstRate: number | undefined;
    let igstRate: number | undefined;
    let appliedRate = effectiveRate;
    let placeOfSupply = 'UNKNOWN';
    let placeOfSupplyName: string | undefined;
    let posBasis: PlaceOfSupplyBasis = 'UNRESOLVED';

    if (isExport) {
      placeOfSupply = customerCountry || 'INTERNATIONAL';
      placeOfSupplyName = placeOfSupply;
      posBasis = 'EXPORT_OUTSIDE_INDIA';
      if (lutApproved || allowProvisionalZeroTaxExport) {
        taxableMinor = totalMinor;
        gstMinor = 0;
        appliedRate = 0;
        cgstMinor = undefined;
        sgstMinor = undefined;
        utgstMinor = undefined;
        igstMinor = undefined;
        cgstRate = undefined;
        sgstRate = undefined;
        utgstRate = undefined;
        igstRate = undefined;
        if (complianceStatus === 'COMPLIANT' || !isProdRuntime) {
          complianceStatus = 'COMPLIANT_ZERO_RATED_EXPORT';
        }
      } else {
        taxableMinor = Math.round((totalMinor * 10000) / (10000 + rateBps));
        gstMinor = totalMinor - taxableMinor;
        igstMinor = gstMinor;
        igstRate = effectiveRate;
      }
    } else {
      // Domestic GST supply
      if (normalizedCustomerGstin) {
        placeOfSupply = normalizedCustomerGstin.slice(0, 2);
        posBasis = 'RECIPIENT_GSTIN';
      } else {
        const candidatePos = this.normalizePlaceOfSupply(input.placeOfSupply || input.customerState);
        if (candidatePos !== 'UNKNOWN') {
          placeOfSupply = candidatePos;
          posBasis = 'RECIPIENT_ADDRESS';
        } else if (input.allowSupplierFallbackSec12_2_b_ii) {
          placeOfSupply = supplierState;
          posBasis = 'SUPPLIER_LOCATION_SEC12_2_B_II';
        } else {
          placeOfSupply = 'UNKNOWN';
          posBasis = 'UNRESOLVED';
        }
      }

      if (placeOfSupply === 'UNKNOWN') {
        // Reverse-compute taxable/GST totals cleanly for display preview,
        // but NEVER guess CGST/SGST/UTGST vs IGST split on unresolved jurisdiction.
        taxableMinor = Math.round((totalMinor * 10000) / (10000 + rateBps));
        gstMinor = totalMinor - taxableMinor;
        complianceStatus =
          complianceStatus === 'PROVISIONAL_PENDING_GSTIN'
            ? 'PROVISIONAL_PENDING_GSTIN_AND_POS'
            : 'PROVISIONAL_PENDING_PLACE_OF_SUPPLY';
      } else {
        placeOfSupplyName = JURISDICTION_BY_CODE.get(placeOfSupply)?.name;
        const isIntraState = placeOfSupply === supplierState;

        taxableMinor = Math.round((totalMinor * 10000) / (10000 + rateBps));
        gstMinor = totalMinor - taxableMinor;

        if (isIntraState) {
          if (roundingPolicy === 'PARITY_HALF_EVEN' && gstMinor % 2 === 1) {
            // Shift 1 paisa so CGST == SGST/UTGST while preserving Taxable + Tax === Total exactly.
            gstMinor += 1;
            taxableMinor = totalMinor - gstMinor;
          }
          cgstMinor = Math.floor(gstMinor / 2);
          const secondHalfMinor = gstMinor - cgstMinor;
          const halfRate = Math.round((effectiveRate / 2) * 10000) / 10000;
          const remainderRate = Math.round((effectiveRate - halfRate) * 10000) / 10000;
          cgstRate = halfRate;

          if (supplierJurisdiction?.isUtgst) {
            utgstMinor = secondHalfMinor;
            utgstRate = remainderRate;
          } else {
            sgstMinor = secondHalfMinor;
            sgstRate = remainderRate;
          }
        } else {
          igstMinor = gstMinor;
          igstRate = effectiveRate;
        }
      }
    }

    return {
      totalAmount,
      totalAmountMinorUnits: totalMinor,
      taxableBase: toMajorUnits(taxableMinor),
      taxableBaseMinorUnits: taxableMinor,
      gstAmount: toMajorUnits(gstMinor),
      gstAmountMinorUnits: gstMinor,
      cgstAmount: cgstMinor !== undefined ? toMajorUnits(cgstMinor) : undefined,
      cgstAmountMinorUnits: cgstMinor,
      sgstAmount: sgstMinor !== undefined ? toMajorUnits(sgstMinor) : undefined,
      sgstAmountMinorUnits: sgstMinor,
      utgstAmount: utgstMinor !== undefined ? toMajorUnits(utgstMinor) : undefined,
      utgstAmountMinorUnits: utgstMinor,
      igstAmount: igstMinor !== undefined ? toMajorUnits(igstMinor) : undefined,
      igstAmountMinorUnits: igstMinor,
      taxRate: appliedRate,
      cgstRate,
      sgstRate,
      utgstRate,
      igstRate,
      taxRateVersion,
      roundingPolicy,
      sacCode,
      sacDescription,
      isProvisionalFixture,
      supplierName: input.supplierName || config.legalName,
      supplierTradeName: config.tradeName,
      supplierGstin,
      supplierState,
      supplierStateName,
      supplierAddress: config.address,
      supplierPan: config.pan,
      supplierCin: config.cin,
      supplierEmail: config.supportEmail,
      placeOfSupply,
      placeOfSupplyName,
      posBasis,
      isB2b,
      customerGstin: normalizedCustomerGstin,
      customerCountry,
      isExport,
      lutNumber,
      lutApproved,
      registrationMode,
      taxComplianceStatus: complianceStatus
    };
  }
}

export const taxDeterminationService = new TaxDeterminationService();
