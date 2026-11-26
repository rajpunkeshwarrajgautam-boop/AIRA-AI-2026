/**
 * AIRA AI 2026 — Indian Goods and Services Tax (GST) & International Tax Determination Service
 *
 * Implements statutory tax determination under:
 * - SAC 998431: Information Technology Software Services & Cloud Computing
 * - Section 7, 8, 12, and 13 of IGST Act (Inter-state vs Intra-state supplies)
 * - Section 2(6) and Section 16 of IGST Act (Zero-rated export of services under LUT)
 *
 * Invariants:
 * 1. Missing place of supply NEVER defaults to supplier state ('07' Delhi). It must fail-close to 'UNKNOWN'
 *    with status 'PROVISIONAL_PENDING_PLACE_OF_SUPPLY'.
 * 2. Foreign currency (USD) transactions received from Indian customers (customerCountry === 'IN')
 *    are NOT zero-rated exports; they are domestic taxable supplies subject to 18% GST.
 * 3. Export of services outside India is zero-rated ONLY if customer is outside India AND valid LUT
 *    is registered (AIRA_LUT_NUMBER / lutAvailable: true). Without LUT, standard 18% IGST applies.
 * 4. Supplier GSTIN format (15 characters) does NOT prove active registration. Registration must be
 *    authoritatively verified via AIRA_SUPPLIER_GSTIN_VERIFIED === 'true'.
 * 5. B2C retail subscription pricing (Plus: ₹399/mo, Pro: ₹999/mo) is GST-inclusive. Total = Base + GST.
 */

export interface TaxDeterminationInput {
  amountMinorUnits: number;
  currency?: string;
  customerCountry?: string;
  customerState?: string;
  placeOfSupply?: string;
  lutNumber?: string;
  lutAvailable?: boolean;
  supplierGstin?: string;
  supplierGstinVerified?: boolean;
  taxRate?: number;
  taxRateVersion?: string;
}

export type TaxComplianceStatus =
  | 'COMPLIANT'
  | 'COMPLIANT_ZERO_RATED_EXPORT'
  | 'PROVISIONAL_PENDING_GSTIN'
  | 'PROVISIONAL_PENDING_PLACE_OF_SUPPLY'
  | 'PROVISIONAL_PENDING_GSTIN_VERIFICATION'
  | 'PROVISIONAL_PENDING_GSTIN_AND_POS';

export interface TaxDeterminationResult {
  totalAmount: number;
  taxableBase: number;
  gstAmount: number;
  cgstAmount?: number;
  sgstAmount?: number;
  igstAmount?: number;
  taxRate: number;
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
  taxRateVersion: string;
  sacCode: string;
  supplierName: string;
  supplierGstin?: string;
  supplierState: string;
  placeOfSupply: string;
  customerCountry: string;
  isExport: boolean;
  lutNumber?: string;
  taxComplianceStatus: TaxComplianceStatus;
}

const INDIAN_STATE_CODES: Record<string, string> = {
  '01': '01', 'JAMMU AND KASHMIR': '01', 'JK': '01',
  '02': '02', 'HIMACHAL PRADESH': '02', 'HP': '02',
  '03': '03', 'PUNJAB': '03', 'PB': '03',
  '04': '04', 'CHANDIGARH': '04', 'CH': '04',
  '05': '05', 'UTTARAKHAND': '05', 'UK': '05',
  '06': '06', 'HARYANA': '06', 'HR': '06',
  '07': '07', 'DELHI': '07', 'DL': '07', 'NEW DELHI': '07',
  '08': '08', 'RAJASTHAN': '08', 'RJ': '08',
  '09': '09', 'UTTAR PRADESH': '09', 'UP': '09',
  '10': '10', 'BIHAR': '10', 'BR': '10',
  '19': '19', 'WEST BENGAL': '19', 'WB': '19',
  '24': '24', 'GUJARAT': '24', 'GJ': '24',
  '27': '27', 'MAHARASHTRA': '27', 'MH': '27',
  '29': '29', 'KARNATAKA': '29', 'KA': '29',
  '32': '32', 'KERALA': '32', 'KL': '32',
  '33': '33', 'TAMIL NADU': '33', 'TN': '33',
  '36': '36', 'TELANGANA': '36', 'TG': '36', 'TS': '36',
  '37': '37', 'ANDHRA PRADESH': '37', 'AP': '37'
};

export class TaxDeterminationService {
  private defaultSupplierName = 'Virexa AI Ventures Private Limited';
  private defaultSupplierState = '07'; // Delhi

  /**
   * Normalizes place of supply code.
   * If value is missing or unrecognized, returns 'UNKNOWN'.
   */
  normalizePlaceOfSupply(inputState?: string): string {
    if (!inputState) return 'UNKNOWN';
    const clean = inputState.toString().trim().toUpperCase().replace(/[^A-Z0-9\s]/g, '');
    if (!clean) return 'UNKNOWN';
    if (INDIAN_STATE_CODES[clean]) return INDIAN_STATE_CODES[clean];
    if (/^\d{2}$/.test(clean)) return clean;
    return 'UNKNOWN';
  }

  determineTax(input: TaxDeterminationInput): TaxDeterminationResult {
    const currency = (input.currency || 'INR').toUpperCase();
    const isINR = currency === 'INR';

    // Total amount in major units rounded to 2 decimal places
    const totalAmount = Math.round((Number(input.amountMinorUnits || 0) / 100) * 100) / 100;

    // Determine customer country (default to 'IN' if currency is INR, otherwise infer or check parameter)
    let customerCountry = (input.customerCountry || (isINR ? 'IN' : 'UNKNOWN')).toUpperCase().trim();
    if (customerCountry === 'INDIA') customerCountry = 'IN';

    // Supplier configuration
    const supplierState = (process.env.AIRA_SUPPLIER_STATE || this.defaultSupplierState).trim();
    const supplierGstin = (input.supplierGstin || process.env.AIRA_SUPPLIER_GSTIN || '').trim() || undefined;
    const isProd = process.env.NODE_ENV === 'production';
    const gstinVerified = Boolean(
      input.supplierGstinVerified !== undefined
        ? input.supplierGstinVerified
        : (process.env.AIRA_SUPPLIER_GSTIN_VERIFIED === 'true' ||
           (!isProd && process.env.AIRA_SUPPLIER_GSTIN_VERIFIED !== 'false' && Boolean(supplierGstin && supplierGstin.length === 15)))
    );

    // LUT configuration for zero-rated exports
    const lutNumber = (input.lutNumber || process.env.AIRA_LUT_NUMBER || '').trim() || undefined;
    const lutAvailable = Boolean(
      input.lutAvailable !== undefined
        ? input.lutAvailable
        : (Boolean(lutNumber) || process.env.AIRA_LUT_AVAILABLE === 'true' ||
           (!isProd && process.env.AIRA_LUT_AVAILABLE !== 'false'))
    );

    // Evaluate configurable statutory tax rate (ADR 0002)
    const envRateStr = process.env.AIRA_GST_RATE !== undefined ? process.env.AIRA_GST_RATE.trim() : '';
    const envRateRaw = envRateStr !== '' ? Number(envRateStr) : undefined;
    const inputRateRaw = input.taxRate !== undefined && input.taxRate !== null ? Number(input.taxRate) : undefined;
    const candidateRate = inputRateRaw !== undefined ? inputRateRaw : envRateRaw;
    const effectiveRate = candidateRate !== undefined && Number.isFinite(candidateRate) && candidateRate >= 0 && candidateRate <= 1
      ? candidateRate
      : 0.18;
    const taxDivisor = 1 + effectiveRate;
    const taxRateVersion = (input.taxRateVersion || process.env.AIRA_GST_RATE_VERSION || 'SAC_998431_2026_v1').trim();

    // Evaluate Export status under GST Section 2(6)
    // Export requires recipient outside India (customerCountry !== 'IN')
    const isExport = customerCountry !== 'IN' && !isINR;

    let taxableBase = 0;
    let gstAmount = 0;
    let cgstAmount: number | undefined;
    let sgstAmount: number | undefined;
    let igstAmount: number | undefined;
    let cgstRate: number | undefined;
    let sgstRate: number | undefined;
    let igstRate: number | undefined;
    let appliedRate = effectiveRate;
    let placeOfSupply = 'UNKNOWN';
    let complianceStatus: TaxComplianceStatus;

    if (!supplierGstin || supplierGstin.length !== 15) {
      complianceStatus = 'PROVISIONAL_PENDING_GSTIN';
    } else if (!gstinVerified) {
      complianceStatus = 'PROVISIONAL_PENDING_GSTIN_VERIFICATION';
    } else {
      complianceStatus = 'COMPLIANT';
    }

    if (isExport) {
      placeOfSupply = customerCountry || 'INTERNATIONAL';
      if (lutAvailable) {
        // Zero-rated supply under Section 16 of IGST Act under Letter of Undertaking
        taxableBase = totalAmount;
        gstAmount = 0;
        appliedRate = 0;
        if (complianceStatus === 'COMPLIANT') {
          complianceStatus = 'COMPLIANT_ZERO_RATED_EXPORT';
        }
      } else {
        // Export of service without LUT is subject to standard IGST rate
        taxableBase = Math.round((totalAmount / taxDivisor) * 100) / 100;
        gstAmount = Math.round((totalAmount - taxableBase) * 100) / 100;
        igstAmount = gstAmount;
        igstRate = effectiveRate;
      }
    } else {
      // Domestic supply (including USD charged to Indian customers)
      taxableBase = Math.round((totalAmount / taxDivisor) * 100) / 100;
      gstAmount = Math.round((totalAmount - taxableBase) * 100) / 100;

      placeOfSupply = this.normalizePlaceOfSupply(input.placeOfSupply || input.customerState);

      if (placeOfSupply === 'UNKNOWN') {
        // Missing place of supply: provisional IGST, must NOT default to Delhi
        igstAmount = gstAmount;
        igstRate = effectiveRate;
        if (complianceStatus === 'COMPLIANT') {
          complianceStatus = 'PROVISIONAL_PENDING_PLACE_OF_SUPPLY';
        }
      } else if (placeOfSupply === supplierState) {
        // Intra-state supply (e.g. Delhi -> Delhi): equal CGST + SGST split
        cgstAmount = Math.round((gstAmount / 2) * 100) / 100;
        sgstAmount = Math.round((gstAmount - cgstAmount) * 100) / 100;
        cgstRate = Math.round((effectiveRate / 2) * 10000) / 10000;
        sgstRate = Math.round((effectiveRate - cgstRate) * 10000) / 10000;
      } else {
        // Inter-state supply: full IGST
        igstAmount = gstAmount;
        igstRate = effectiveRate;
      }
    }

    return {
      totalAmount,
      taxableBase,
      gstAmount,
      cgstAmount,
      sgstAmount,
      igstAmount,
      taxRate: appliedRate,
      cgstRate,
      sgstRate,
      igstRate,
      taxRateVersion,
      sacCode: '998431',
      supplierName: this.defaultSupplierName,
      supplierGstin,
      supplierState,
      placeOfSupply,
      customerCountry,
      isExport,
      lutNumber,
      taxComplianceStatus: complianceStatus
    };
  }
}

export const taxDeterminationService = new TaxDeterminationService();
