import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCompoundInterest,
  computePercentage,
  computeUnitConversion,
  computeLoanPayment,
  evaluateSafeMathExpression,
  sampleSafeMathFunction,
  buildCalculatorSurface,
  recomputeCalculatorSurface,
} from '../packages/contracts/src/genui-calculators.js';
import { validateGenUISurface } from '../packages/contracts/src/genui.js';

describe('Phase 1 — Deterministic Native Calculators (Zero eval/Function)', () => {
  it('computes compound interest accurately with compounding frequency and contributions', () => {
    const res = computeCompoundInterest({
      principal: 10000,
      annualRatePercent: 8,
      years: 5,
      compoundingPerYear: 12,
      monthlyContribution: 0,
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // 10000 * (1 + 0.08/12)^60 = 14898.46
    assert.ok(Math.abs(res.finalBalance - 14898.46) < 0.05);
    assert.equal(res.totalPrincipal, 10000);
    assert.equal(res.yearlySchedule.length, 6); // Year 0..5

    // Zero rate edge case
    const zeroRate = computeCompoundInterest({
      principal: 1000,
      annualRatePercent: 0,
      years: 2,
      compoundingPerYear: 12,
      monthlyContribution: 100,
    });
    assert.equal(zeroRate.ok, true);
    if (!zeroRate.ok) return;
    assert.equal(zeroRate.finalBalance, 3400);
    assert.equal(zeroRate.totalInterest, 0);
  });

  it('computes percentages and rejects zero denominators safely', () => {
    const p1 = computePercentage({ mode: 'percent_of', valueA: 15, valueB: 200 });
    assert.equal(p1.ok, true);
    if (p1.ok) assert.equal(p1.result, 30);

    const p2 = computePercentage({ mode: 'percent_change', valueA: 80, valueB: 100 });
    assert.equal(p2.ok, true);
    if (p2.ok) assert.equal(p2.result, 25);

    const divZero = computePercentage({ mode: 'what_percent', valueA: 10, valueB: 0 });
    assert.equal(divZero.ok, false);
  });

  it('computes deterministic unit conversions including temperature offsets', () => {
    const kmToMi = computeUnitConversion({ category: 'length', value: 10, fromUnit: 'km', toUnit: 'mi' });
    assert.equal(kmToMi.ok, true);
    if (kmToMi.ok) assert.ok(Math.abs(kmToMi.result - 6.21371) < 0.001);

    const cToF = computeUnitConversion({ category: 'temperature', value: 100, fromUnit: 'C', toUnit: 'F' });
    assert.equal(cToF.ok, true);
    if (cToF.ok) assert.equal(cToF.result, 212);

    const bad = computeUnitConversion({ category: 'length', value: 10, fromUnit: 'km', toUnit: 'kg' });
    assert.equal(bad.ok, false);
  });

  it('computes loan EMI payment and handles 0% APR and invalid bounds safely', () => {
    const loan = computeLoanPayment({ principal: 100000, annualRatePercent: 6, termMonths: 12 });
    assert.equal(loan.ok, true);
    if (loan.ok) {
      assert.ok(Math.abs(loan.monthlyPayment - 8606.64) < 0.05);
      assert.ok(loan.yearlySchedule.length >= 2);
    }

    const zeroApr = computeLoanPayment({ principal: 12000, annualRatePercent: 0, termMonths: 12 });
    assert.equal(zeroApr.ok, true);
    if (zeroApr.ok) {
      assert.equal(zeroApr.monthlyPayment, 1000);
      assert.equal(zeroApr.totalInterest, 0);
    }
  });

  it('evaluates scientific expressions via pure parser without eval/Function and rejects code injection', () => {
    const ok1 = evaluateSafeMathExpression('2 * sin(pi / 6) + sqrt(16) ^ 1.5');
    assert.equal(ok1.ok, true);
    // 2 * 0.5 + 4^1.5 = 1 + 8 = 9
    if (ok1.ok) assert.ok(Math.abs(ok1.value - 9) < 1e-9);

    const div0 = evaluateSafeMathExpression('10 / (5 - 5)');
    assert.equal(div0.ok, false);

    // Code injection attempts must reject cleanly
    for (const evil of [
      'process.exit(1)',
      'window.alert(1)',
      '(() => 1)()',
      'constructor.constructor("return 1")()',
    ]) {
      const r = evaluateSafeMathExpression(evil);
      assert.equal(r.ok, false, `Unsafe expression must fail: ${evil}`);
    }

    const sampled = sampleSafeMathFunction('x^2 + 1', -2, 2, 5);
    assert.equal(sampled.ok, true);
    if (sampled.ok) {
      assert.equal(sampled.points.length, 5);
      assert.deepEqual(sampled.points[0], { x: -2, y: 5 });
      assert.deepEqual(sampled.points[2], { x: 0, y: 1 });
    }
  });

  it('builds valid GenUISurface calculator specs and recomputes deterministically on local state change', () => {
    const surf = buildCalculatorSurface('compound_interest', {
      principal: 5000,
      annualRatePercent: 10,
      years: 3,
      compoundingPerYear: 1,
      monthlyContribution: 0,
    });
    assert.equal(validateGenUISurface(surf).ok, true);

    const updated = recomputeCalculatorSurface(surf, {
      ...surf.state,
      principal: 10000,
    });
    assert.equal(validateGenUISurface(updated).ok, true);
    const metricComp = updated.components.find((c) => c.id === 'metric_final');
    assert.ok(metricComp && metricComp.type === 'metric_display');
    // 10000 * 1.1^3 = 13310
    assert.ok(String(metricComp.props.value).includes('13,310'));
  });
});
