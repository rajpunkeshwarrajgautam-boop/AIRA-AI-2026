import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  taxDeterminationService,
  validateGstin,
  getIndianFinancialYear,
  calculateProportionalRefundTax,
  INDIAN_GST_JURISDICTIONS,
  DEFAULT_SUPPLIER_LEGAL_NAME,
  DEFAULT_SUPPLIER_STATE_CODE,
  DEFAULT_PROVISIONAL_SAC_CODE
} from '../apps/api/src/billing/tax-determination.js';

describe('Commercial GST Tax Calculations & Statutory Engine (SPEC-GST-BILLING-2026-01)', () => {
  it('defaults supplier identity to VIREXA AI VENTURES PRIVATE LIMITED in Uttar Pradesh (09), never Delhi (07)', () => {
    const cfg = taxDeterminationService.getSupplierTaxConfig();
    assert.equal(DEFAULT_SUPPLIER_LEGAL_NAME, 'VIREXA AI VENTURES PRIVATE LIMITED');
    assert.equal(DEFAULT_SUPPLIER_STATE_CODE, '09');
    assert.equal(DEFAULT_PROVISIONAL_SAC_CODE, '998315');
    assert.equal(cfg.stateCode, '09');
    assert.equal(cfg.stateName, 'Uttar Pradesh');
    assert.equal(cfg.sacCode, '998315');
  });

  it('calculates AIRA Plus ₹399 intra-UP (09 -> 09) GST-inclusive split as CGST 9% + SGST 9%', () => {
    const res = taxDeterminationService.determineTax({
      amountMinorUnits: 39900,
      currency: 'INR',
      customerState: '09',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true,
      sacApproved: true,
      financeTaxSignOff: true
    });

    assert.equal(res.totalAmount, 399.00);
    assert.equal(res.taxableBase, 338.14);
    assert.equal(res.gstAmount, 60.86);
    assert.equal(res.cgstAmount, 30.43);
    assert.equal(res.sgstAmount, 30.43);
    assert.equal(res.utgstAmount, undefined);
    assert.equal(res.igstAmount, undefined);
    assert.equal(res.placeOfSupply, '09');
    assert.equal(res.posBasis, 'RECIPIENT_ADDRESS');
    assert.equal(res.taxComplianceStatus, 'COMPLIANT');
  });

  it('calculates AIRA Pro ₹999 intra-UP (09 -> 09) with deterministic minor-unit reconciliation for both rounding policies', () => {
    const floorRem = taxDeterminationService.determineTax({
      amountMinorUnits: 99900,
      currency: 'INR',
      customerState: 'UP',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true,
      roundingPolicy: 'FLOOR_REMAINDER'
    });
    assert.equal(floorRem.taxableBaseMinorUnits, 84661);
    assert.equal(floorRem.gstAmountMinorUnits, 15239);
    assert.equal(floorRem.cgstAmountMinorUnits, 7619);
    assert.equal(floorRem.sgstAmountMinorUnits, 7620);
    assert.equal(
      (floorRem.cgstAmountMinorUnits || 0) + (floorRem.sgstAmountMinorUnits || 0) + floorRem.taxableBaseMinorUnits,
      99900
    );

    const parity = taxDeterminationService.determineTax({
      amountMinorUnits: 99900,
      currency: 'INR',
      customerState: 'UP',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true,
      roundingPolicy: 'PARITY_HALF_EVEN'
    });
    assert.equal(parity.taxableBaseMinorUnits, 84660);
    assert.equal(parity.gstAmountMinorUnits, 15240);
    assert.equal(parity.cgstAmountMinorUnits, 7620);
    assert.equal(parity.sgstAmountMinorUnits, 7620);
    assert.equal(
      (parity.cgstAmountMinorUnits || 0) + (parity.sgstAmountMinorUnits || 0) + parity.taxableBaseMinorUnits,
      99900
    );
  });

  it('calculates inter-state IGST (18%) from UP (09) to Delhi (07) and Maharashtra (27)', () => {
    const delhiRes = taxDeterminationService.determineTax({
      amountMinorUnits: 39900,
      currency: 'INR',
      customerState: 'Delhi',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true
    });
    assert.equal(delhiRes.placeOfSupply, '07');
    assert.equal(delhiRes.igstAmount, 60.86);
    assert.equal(delhiRes.cgstAmount, undefined);
    assert.equal(delhiRes.sgstAmount, undefined);

    const mhRes = taxDeterminationService.determineTax({
      amountMinorUnits: 99900,
      currency: 'INR',
      customerState: 'MH',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true
    });
    assert.equal(mhRes.placeOfSupply, '27');
    assert.equal(mhRes.igstAmount, 152.39);
  });

  it('supports UTGST for Union Territories without legislature (04, 26, 31, 35, 38) when supplier is in same UT', () => {
    for (const utCode of ['04', '26', '31', '35', '38']) {
      const res = taxDeterminationService.determineTax({
        amountMinorUnits: 39900,
        currency: 'INR',
        customerState: utCode,
        supplierState: utCode
      });
      assert.equal(res.cgstAmount, 30.43, `UT ${utCode} expects CGST`);
      assert.equal(res.utgstAmount, 30.43, `UT ${utCode} expects UTGST`);
      assert.equal(res.sgstAmount, undefined, `UT ${utCode} must not emit SGST`);
      assert.equal(res.igstAmount, undefined);
    }
  });

  it('maps all 37 active Indian GST jurisdictions and rejects legacy merged code 25', () => {
    assert.equal(INDIAN_GST_JURISDICTIONS.length, 37);
    for (const j of INDIAN_GST_JURISDICTIONS) {
      assert.equal(taxDeterminationService.normalizePlaceOfSupply(j.code), j.code);
      assert.equal(taxDeterminationService.normalizePlaceOfSupply(j.name), j.code);
      assert.equal(taxDeterminationService.normalizePlaceOfSupply(j.shortCode), j.code);
    }
    assert.equal(taxDeterminationService.normalizePlaceOfSupply('25'), 'UNKNOWN');
    assert.equal(taxDeterminationService.normalizePlaceOfSupply('Daman and Diu'), 'UNKNOWN');
  });

  it('validates GSTIN structure, Mod-36 checksum, state prefix, PAN slice, and B2B POS precedence (Sec 12(2)(a))', () => {
    const valid = validateGstin('09AAMCV4678C1ZV', { expectedStateCode: '09', expectedPan: 'AAMCV4678C' });
    assert.equal(valid.valid, true);
    assert.equal(valid.stateCode, '09');
    assert.equal(valid.panSlice, 'AAMCV4678C');

    // Invalid checksum char
    const badCheck = validateGstin('09AAMCV4678C1ZW');
    assert.equal(badCheck.valid, false);

    // Merged code 25
    const bad25 = validateGstin('25AAMCV4678C1Z1');
    assert.equal(bad25.valid, false);

    // B2B GSTIN overrides mismatched B2C customerState per IGST Sec 12(2)(a)
    const b2bRes = taxDeterminationService.determineTax({
      amountMinorUnits: 99900,
      currency: 'INR',
      customerState: '09',
      customerGstin: '09AAMCV4678C1ZV',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true
    });
    assert.equal(b2bRes.isB2b, true);
    assert.equal(b2bRes.posBasis, 'RECIPIENT_GSTIN');
    assert.equal(b2bRes.placeOfSupply, '09');
  });

  it('never silently defaults UNKNOWN place of supply to IGST, and supports explicit Sec 12(2)(b)(ii) opt-in', () => {
    const unresolved = taxDeterminationService.determineTax({
      amountMinorUnits: 39900,
      currency: 'INR',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true
    });
    assert.equal(unresolved.placeOfSupply, 'UNKNOWN');
    assert.equal(unresolved.posBasis, 'UNRESOLVED');
    assert.equal(unresolved.igstAmount, undefined);
    assert.equal(unresolved.cgstAmount, undefined);
    assert.equal(unresolved.sgstAmount, undefined);
    assert.equal(unresolved.taxComplianceStatus, 'PROVISIONAL_PENDING_PLACE_OF_SUPPLY');

    const sec12Fallback = taxDeterminationService.determineTax({
      amountMinorUnits: 39900,
      currency: 'INR',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true,
      allowSupplierFallbackSec12_2_b_ii: true
    });
    assert.equal(sec12Fallback.placeOfSupply, '09');
    assert.equal(sec12Fallback.posBasis, 'SUPPLIER_LOCATION_SEC12_2_B_II');
    assert.equal(sec12Fallback.cgstAmount, 30.43);
    assert.equal(sec12Fallback.sgstAmount, 30.43);
  });

  it('fails closed in production when SAC approval or Finance tax sign-off is missing', () => {
    const unapproved = taxDeterminationService.determineTax({
      amountMinorUnits: 39900,
      currency: 'INR',
      customerState: '09',
      supplierGstin: '09AAMCV4678C1ZV',
      supplierGstinVerified: true,
      sacApproved: false,
      financeTaxSignOff: false
    });
    assert.equal(unapproved.isProvisionalFixture, true);
    assert.equal(unapproved.taxComplianceStatus, 'PROVISIONAL_PENDING_TAX_APPROVAL');
  });

  it('calculates Indian Financial Year accurately across IST April 1 rollover boundary', () => {
    const beforeRollover = new Date('2027-03-31T23:59:59.000+05:30').getTime();
    const afterRollover = new Date('2027-04-01T00:00:00.000+05:30').getTime();

    const fyBefore = getIndianFinancialYear(beforeRollover);
    assert.equal(fyBefore.financialYear, '2026-27');
    assert.equal(fyBefore.compactFy, '26-27');
    assert.equal(fyBefore.gstr1CreditNoteCutoff, '2027-11-30');
    assert.equal(fyBefore.issueDateIst, '2027-03-31');

    const fyAfter = getIndianFinancialYear(afterRollover);
    assert.equal(fyAfter.financialYear, '2027-28');
    assert.equal(fyAfter.compactFy, '27-28');
    assert.equal(fyAfter.gstr1CreditNoteCutoff, '2028-11-30');
    assert.equal(fyAfter.issueDateIst, '2027-04-01');
  });

  it('reconciles multi-step partial refunds proportionally back to original invoice paise without drift', () => {
    const step1 = calculateProportionalRefundTax({
      originalTotalMinorUnits: 99900,
      originalTaxableMinorUnits: 84661,
      originalGstMinorUnits: 15239,
      originalCgstMinorUnits: 7619,
      originalSgstMinorUnits: 7620,
      originalUtgstMinorUnits: 0,
      originalIgstMinorUnits: 0,
      alreadyRefundedTotalMinorUnits: 0,
      alreadyRefundedTaxableMinorUnits: 0,
      alreadyRefundedGstMinorUnits: 0,
      alreadyRefundedCgstMinorUnits: 0,
      alreadyRefundedSgstMinorUnits: 0,
      alreadyRefundedUtgstMinorUnits: 0,
      alreadyRefundedIgstMinorUnits: 0,
      refundMinorUnits: 33300
    });

    const step2 = calculateProportionalRefundTax({
      originalTotalMinorUnits: 99900,
      originalTaxableMinorUnits: 84661,
      originalGstMinorUnits: 15239,
      originalCgstMinorUnits: 7619,
      originalSgstMinorUnits: 7620,
      originalUtgstMinorUnits: 0,
      originalIgstMinorUnits: 0,
      alreadyRefundedTotalMinorUnits: step1.refundMinorUnits,
      alreadyRefundedTaxableMinorUnits: step1.taxableBaseMinorUnits,
      alreadyRefundedGstMinorUnits: step1.gstAmountMinorUnits,
      alreadyRefundedCgstMinorUnits: step1.cgstMinorUnits,
      alreadyRefundedSgstMinorUnits: step1.sgstMinorUnits,
      alreadyRefundedUtgstMinorUnits: 0,
      alreadyRefundedIgstMinorUnits: 0,
      refundMinorUnits: 66600
    });

    assert.equal(step1.taxableBaseMinorUnits + step2.taxableBaseMinorUnits, 84661);
    assert.equal(step1.cgstMinorUnits + step2.cgstMinorUnits, 7619);
    assert.equal(step1.sgstMinorUnits + step2.sgstMinorUnits, 7620);
    assert.equal(step1.gstAmountMinorUnits + step2.gstAmountMinorUnits, 15239);
  });
});
