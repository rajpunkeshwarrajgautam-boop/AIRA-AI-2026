import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

export interface GstTaxCalculation {
  totalAmountPaise: number;
  totalAmountRupees: number;
  taxableBasePaise: number;
  taxableBaseRupees: number;
  gstAmountPaise: number;
  gstAmountRupees: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstRatePercent: number;
}

export function calculateGstInclusive(totalAmountRupees: number, isInterstate = false, gstRatePercent = 18): GstTaxCalculation {
  const totalAmountPaise = Math.round(totalAmountRupees * 100);
  const rateFactor = 1 + (gstRatePercent / 100);
  
  // Taxable base in paise (rounded to nearest integer)
  const taxableBasePaise = Math.round(totalAmountPaise / rateFactor);
  const gstAmountPaise = totalAmountPaise - taxableBasePaise;
  
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;

  if (isInterstate) {
    igstPaise = gstAmountPaise;
  } else {
    cgstPaise = Math.round(gstAmountPaise / 2);
    sgstPaise = gstAmountPaise - cgstPaise;
  }

  return {
    totalAmountPaise,
    totalAmountRupees: Number((totalAmountPaise / 100).toFixed(2)),
    taxableBasePaise,
    taxableBaseRupees: Number((taxableBasePaise / 100).toFixed(2)),
    gstAmountPaise,
    gstAmountRupees: Number((gstAmountPaise / 100).toFixed(2)),
    cgstPaise,
    sgstPaise,
    igstPaise,
    gstRatePercent
  };
}

describe('Commercial GST Tax Calculations', () => {
  it('calculates AIRA Plus INR 399 GST-inclusive split correctly', () => {
    const calc = calculateGstInclusive(399, false, 18);
    // 399 / 1.18 = 338.1355... -> 338.14
    assert.equal(calc.totalAmountRupees, 399.00);
    assert.equal(calc.taxableBaseRupees, 338.14);
    assert.equal(calc.gstAmountRupees, 60.86);
    assert.equal(calc.totalAmountPaise, 39900);
    assert.equal(calc.taxableBasePaise, 33814);
    assert.equal(calc.gstAmountPaise, 6086);
    assert.equal(calc.cgstPaise + calc.sgstPaise, 6086);
  });

  it('calculates AIRA Pro INR 999 GST-inclusive split correctly', () => {
    const calc = calculateGstInclusive(999, false, 18);
    // 999 / 1.18 = 846.6101... -> 846.61
    assert.equal(calc.totalAmountRupees, 999.00);
    assert.equal(calc.taxableBaseRupees, 846.61);
    assert.equal(calc.gstAmountRupees, 152.39);
    assert.equal(calc.totalAmountPaise, 99900);
    assert.equal(calc.taxableBasePaise, 84661);
    assert.equal(calc.gstAmountPaise, 15239);
  });

  it('handles interstate IGST allocation properly', () => {
    const calc = calculateGstInclusive(399, true, 18);
    assert.equal(calc.igstPaise, 6086);
    assert.equal(calc.cgstPaise, 0);
    assert.equal(calc.sgstPaise, 0);
  });

  it('supports configurable tax rates without hardcoding 18%', () => {
    const calc12 = calculateGstInclusive(100, false, 12);
    // 100 / 1.12 = 89.2857 -> 89.29
    assert.equal(calc12.taxableBaseRupees, 89.29);
    assert.equal(calc12.gstAmountRupees, 10.71);
  });
});
