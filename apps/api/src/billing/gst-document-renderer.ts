import {
  DEFAULT_SUPPLIER_ADDRESS,
  DEFAULT_SUPPLIER_CIN,
  DEFAULT_SUPPLIER_EMAIL,
  DEFAULT_SUPPLIER_LEGAL_NAME,
  DEFAULT_SUPPLIER_PAN,
  DEFAULT_SUPPLIER_STATE_CODE,
  DEFAULT_SUPPLIER_TRADE_NAME
} from './tax-determination.js';

export interface GstInvoiceRenderInput {
  invoiceNumber: string;
  date: string;
  financialYear?: string;
  documentStatus?: string;
  voidedAt?: number;
  voidReason?: string;
  plan: string;
  currency: string;
  totalAmount: number;
  taxableBase: number;
  gstAmount: number;
  cgstAmount?: number;
  sgstAmount?: number;
  utgstAmount?: number;
  igstAmount?: number;
  taxRate?: number;
  cgstRate?: number;
  sgstRate?: number;
  utgstRate?: number;
  igstRate?: number;
  taxRateVersion?: string;
  sacCode: string;
  sacDescription?: string;
  supplierName: string;
  supplierTradeName?: string;
  supplierGstin?: string;
  supplierStateCode?: string;
  supplierStateName?: string;
  supplierAddress?: string;
  supplierPan?: string;
  supplierCin?: string;
  supplierEmail?: string;
  customerName?: string;
  customerEmail?: string;
  customerAddress?: string;
  customerStateCode?: string;
  customerStateName?: string;
  customerGstin?: string;
  isB2b?: boolean;
  reverseCharge?: boolean;
  placeOfSupply?: string;
  placeOfSupplyName?: string;
  posBasis?: string;
  taxComplianceStatus?: string;
  lutNumber?: string;
  lutApproved?: boolean;
  status: string;
  isSandbox?: boolean;
  billingPeriodStart?: number;
  billingPeriodEnd?: number;
  invoiceTimingBasis?: string;
  gateway?: string;
  paymentMethod?: string;
  gatewayOrderId?: string;
  gatewayPaymentId?: string;
  irn?: string;
  irnAckNo?: string;
  irnAckDate?: string;
  signedQrCode?: string;
}

export interface GstCreditNoteRenderInput {
  creditNoteNumber: string;
  date: string;
  financialYear?: string;
  documentStatus?: string;
  voidedAt?: number;
  voidReason?: string;
  originalInvoiceNumber: string;
  originalInvoiceDate?: string;
  reason?: string;
  currency: string;
  refundAmount: number;
  taxableBase?: number;
  gstAmount?: number;
  cgstAmount?: number;
  sgstAmount?: number;
  utgstAmount?: number;
  igstAmount?: number;
  taxRate?: number;
  cgstRate?: number;
  sgstRate?: number;
  utgstRate?: number;
  igstRate?: number;
  sacCode?: string;
  sacDescription?: string;
  placeOfSupply?: string;
  placeOfSupplyName?: string;
  supplierName: string;
  supplierTradeName?: string;
  supplierGstin?: string;
  supplierStateCode?: string;
  supplierAddress?: string;
  supplierPan?: string;
  supplierCin?: string;
  supplierEmail?: string;
  customerName?: string;
  customerEmail?: string;
  customerAddress?: string;
  customerStateCode?: string;
  customerGstin?: string;
  isB2b?: boolean;
  statutoryGstr1Cutoff?: string;
  status: string;
  isSandbox?: boolean;
  gateway?: string;
  refundId?: string;
  irn?: string;
  irnAckNo?: string;
  irnAckDate?: string;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPct(rate?: number, fallbackPct = 18): string {
  const pct = typeof rate === 'number' && Number.isFinite(rate)
    ? Number((rate <= 1 ? rate * 100 : rate).toFixed(2))
    : fallbackPct;
  return `${pct}%`;
}

function formatIstDate(epochMs?: number): string | null {
  if (!epochMs || !Number.isFinite(epochMs)) return null;
  return new Date(epochMs).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit'
  });
}

function sanitizeCustomerEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim();
  if (!trimmed || trimmed.endsWith('@aira.internal')) return undefined;
  return trimmed;
}

function buildTaxRowsHtml(params: {
  symbol: string;
  currency?: string;
  taxComplianceStatus?: string;
  posBasis?: string;
  lutNumber?: string;
  lutApproved?: boolean;
  taxRate?: number;
  cgstAmount?: number;
  cgstRate?: number;
  sgstAmount?: number;
  sgstRate?: number;
  utgstAmount?: number;
  utgstRate?: number;
  igstAmount?: number;
  igstRate?: number;
  gstAmount?: number;
  placeOfSupply?: string;
}): string {
  const { symbol } = params;
  const isExportSupply = params.posBasis === 'EXPORT_OUTSIDE_INDIA';
  const isVerifiedLutExport = isExportSupply && (
    params.taxComplianceStatus === 'COMPLIANT_ZERO_RATED_EXPORT' ||
    Boolean(params.lutApproved && params.lutNumber)
  );
  if (isExportSupply && Number(params.gstAmount ?? 0) === 0) {
    if (isVerifiedLutExport) {
      const lutSuffix = params.lutNumber ? ` (${escapeHtml(params.lutNumber)})` : '';
      return `<tr><td>Zero-Rated Export of Services (IGST Act Sec 2(6) / LUT${lutSuffix})</td><td class="num">${symbol}0.00</td></tr>`;
    }
    return `<tr><td>Export of Services (Outside India &mdash; Tax/LUT Pending Verification)</td><td class="num">${symbol}0.00</td></tr>`;
  }
  if (params.cgstAmount !== undefined && (params.utgstRate !== undefined || (params.utgstAmount !== undefined && params.utgstAmount > 0))) {
    return [
      `<tr><td>CGST (${formatPct(params.cgstRate, 9)})</td><td class="num">${symbol}${Number(params.cgstAmount || 0).toFixed(2)}</td></tr>`,
      `<tr><td>UTGST (${formatPct(params.utgstRate ?? params.cgstRate, 9)})</td><td class="num">${symbol}${Number(params.utgstAmount || 0).toFixed(2)}</td></tr>`
    ].join('');
  }
  if (params.cgstAmount !== undefined && params.sgstAmount !== undefined) {
    return [
      `<tr><td>CGST (${formatPct(params.cgstRate, 9)})</td><td class="num">${symbol}${Number(params.cgstAmount || 0).toFixed(2)}</td></tr>`,
      `<tr><td>SGST (${formatPct(params.sgstRate, 9)})</td><td class="num">${symbol}${Number(params.sgstAmount || 0).toFixed(2)}</td></tr>`
    ].join('');
  }
  if (params.igstAmount !== undefined || (params.gstAmount !== undefined && params.placeOfSupply && params.placeOfSupply !== 'UNKNOWN')) {
    return `<tr><td>IGST (${formatPct(params.igstRate ?? params.taxRate, 18)})</td><td class="num">${symbol}${Number(params.igstAmount ?? params.gstAmount ?? 0).toFixed(2)}</td></tr>`;
  }
  return `<tr><td>Provisional GST (${formatPct(params.taxRate, 18)}) — Jurisdiction Pending</td><td class="num">${symbol}${Number(params.gstAmount ?? 0).toFixed(2)}</td></tr>`;
}

const SHARED_A4_STYLES = `
  @page { size: A4; margin: 14mm; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1c1917; margin: 28px auto; max-width: 794px; padding: 0 18px; line-height: 1.5; }
  .banner-sandbox { background: #fffbeb; border: 2px dashed #d97706; color: #92400e; padding: 10px 14px; font-weight: 700; font-size: 13px; border-radius: 6px; margin-bottom: 18px; text-align: center; letter-spacing: 0.03em; }
  .banner-voided { background: #fef2f2; border: 2px solid #dc2626; color: #991b1b; padding: 10px 14px; font-weight: 700; font-size: 13px; border-radius: 6px; margin-bottom: 18px; text-align: center; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #e7e5e4; padding-bottom: 16px; margin-bottom: 20px; gap: 16px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .card { border: 1px solid #e7e5e4; border-radius: 6px; padding: 12px 14px; background: #fafaf9; font-size: 12.5px; }
  .card h2 { margin: 0 0 6px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #57534e; }
  .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; background: #ecfdf5; color: #065f46; font-weight: 600; font-size: 12px; }
  .badge-warn { background: #fffbeb; color: #92400e; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { border-bottom: 1px solid #e7e5e4; padding: 10px 8px; text-align: left; font-size: 13.5px; }
  th { background: #fafaf9; font-size: 12px; text-transform: uppercase; color: #57534e; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .total { font-weight: 700; font-size: 15px; background: #f5f5f4; }
  .meta { font-size: 12.5px; color: #57534e; }
  .foot { margin-top: 24px; border-top: 1px solid #e7e5e4; padding-top: 12px; font-size: 11.5px; color: #57534e; }
  @media print { body { margin: 0; padding: 0; } }
`;

/**
 * Renders a self-contained A4 printable HTML Tax Invoice strictly from persisted snapshot data.
 * Never embeds internal principal IDs (`usr_...`), DB IDs, or fabricates PDF claims.
 */
export function buildInvoiceHtmlDocument(inv: GstInvoiceRenderInput): string {
  const symbol = inv.currency === 'INR' ? '₹' : '$';
  const isSandboxDoc = Boolean(
    inv.isSandbox ||
    inv.taxComplianceStatus === 'SANDBOX_REHEARSAL' ||
    inv.invoiceNumber.startsWith('SBX/')
  );
  const isVoided = inv.documentStatus === 'VOIDED';

  const supplierLegal = inv.supplierName || DEFAULT_SUPPLIER_LEGAL_NAME;
  const supplierTrade = inv.supplierTradeName || DEFAULT_SUPPLIER_TRADE_NAME;
  const supplierAddr = inv.supplierAddress || DEFAULT_SUPPLIER_ADDRESS;
  const supplierPan = inv.supplierPan || DEFAULT_SUPPLIER_PAN;
  const supplierCin = inv.supplierCin || DEFAULT_SUPPLIER_CIN;
  const supplierEmail = inv.supplierEmail || DEFAULT_SUPPLIER_EMAIL;
  const supplierState = inv.supplierStateCode || DEFAULT_SUPPLIER_STATE_CODE;

  const startStr = formatIstDate(inv.billingPeriodStart);
  const endStr = formatIstDate(inv.billingPeriodEnd);
  const periodLabel = startStr && endStr ? `${startStr} to ${endStr}` : null;

  const buyerEmail = sanitizeCustomerEmail(inv.customerEmail);
  const posDisplay = inv.placeOfSupplyName && inv.placeOfSupply
    ? `${inv.placeOfSupplyName} (${inv.placeOfSupply})`
    : (inv.placeOfSupply || 'UNKNOWN');

  const taxRows = buildTaxRowsHtml({
    symbol,
    currency: inv.currency,
    taxComplianceStatus: inv.taxComplianceStatus,
    posBasis: inv.posBasis,
    lutNumber: inv.lutNumber,
    lutApproved: inv.lutApproved,
    taxRate: inv.taxRate,
    cgstAmount: inv.cgstAmount,
    cgstRate: inv.cgstRate,
    sgstAmount: inv.sgstAmount,
    sgstRate: inv.sgstRate,
    utgstAmount: inv.utgstAmount,
    utgstRate: inv.utgstRate,
    igstAmount: inv.igstAmount,
    igstRate: inv.igstRate,
    gstAmount: inv.gstAmount,
    placeOfSupply: inv.placeOfSupply
  });
  const isExportDoc = inv.posBasis === 'EXPORT_OUTSIDE_INDIA';
  const isVerifiedLutExport = isExportDoc && (
    inv.taxComplianceStatus === 'COMPLIANT_ZERO_RATED_EXPORT' ||
    Boolean(inv.lutApproved && inv.lutNumber)
  );
  const docTitle = isSandboxDoc
    ? (isExportDoc ? 'Sandbox Export Receipt' : 'Sandbox Tax Invoice')
    : (isExportDoc ? (isVerifiedLutExport ? 'Commercial Export Invoice' : 'Provisional Export Statement') : 'Tax Invoice');

  const bannerHtml = isVoided
    ? `<div class="banner-voided">VOIDED DOCUMENT — NOT VALID FOR INPUT TAX CREDIT${inv.voidReason ? ` (${escapeHtml(inv.voidReason)})` : ''}</div>`
    : isSandboxDoc
      ? `<div class="banner-sandbox">SANDBOX REHEARSAL RECEIPT — NOT A VALID TAX INVOICE</div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AIRA Tax Invoice ${escapeHtml(inv.invoiceNumber)}</title>
  <style>${SHARED_A4_STYLES}</style>
</head>
<body>
  ${bannerHtml}
  <div class="hdr">
    <div>
      <h1 style="margin:0 0 4px 0;font-size:21px;">${escapeHtml(docTitle)}</h1>
      <div><strong>${escapeHtml(supplierLegal)}</strong>${supplierTrade !== supplierLegal ? ` <span class="meta">(${escapeHtml(supplierTrade)})</span>` : ''}</div>
      <div class="meta">${escapeHtml(supplierAddr)}</div>
      <div class="meta">
        ${inv.supplierGstin ? `GSTIN: <strong>${escapeHtml(inv.supplierGstin)}</strong> &middot; ` : 'GSTIN: Pending Provisioning &middot; '}
        State Code: ${escapeHtml(supplierState)} &middot; PAN: ${escapeHtml(supplierPan)} &middot; CIN: ${escapeHtml(supplierCin)}
      </div>
      <div class="meta">Billing Support: ${escapeHtml(supplierEmail)}</div>
    </div>
    <div style="text-align:right;min-width:210px;">
      <div style="font-family:monospace;font-weight:700;font-size:15px;">${escapeHtml(inv.invoiceNumber)}</div>
      <div class="meta">Invoice Date (IST): ${escapeHtml(inv.date)}</div>
      ${inv.financialYear ? `<div class="meta">Financial Year: ${escapeHtml(inv.financialYear)}</div>` : ''}
      <div style="margin-top:6px;"><span class="badge ${isVoided ? 'badge-warn' : ''}">${escapeHtml(isVoided ? 'VOIDED' : inv.status)}</span></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Billed To (Recipient)</h2>
      <div><strong>${escapeHtml(inv.customerName || 'AIRA Subscriber')}</strong></div>
      ${buyerEmail ? `<div class="meta">${escapeHtml(buyerEmail)}</div>` : ''}
      ${inv.customerAddress ? `<div class="meta">${escapeHtml(inv.customerAddress)}</div>` : ''}
      ${inv.customerStateCode ? `<div class="meta">State/Region: ${escapeHtml(inv.customerStateName ? `${inv.customerStateName} (${inv.customerStateCode})` : inv.customerStateCode)}</div>` : ''}
      ${inv.customerGstin ? `<div class="meta">Recipient GSTIN (B2B): <strong>${escapeHtml(inv.customerGstin)}</strong></div>` : (isExportDoc ? `<div class="meta">Supply Category: Export of Services (Outside India)</div>` : '<div class="meta">Supply Category: B2C (Unregistered)</div>')}
    </div>
    <div class="card">
      <h2>Statutory &amp; Payment Details</h2>
      <div><strong>Place of Supply:</strong> ${escapeHtml(posDisplay)}</div>
      <div><strong>SAC Code:</strong> ${escapeHtml(inv.sacCode)}${inv.sacDescription ? ` &mdash; ${escapeHtml(inv.sacDescription)}` : ''}</div>
      <div><strong>Tax Payable on Reverse Charge:</strong> ${inv.reverseCharge ? 'Yes' : 'No'}</div>
      ${periodLabel ? `<div><strong>Service Period:</strong> ${escapeHtml(periodLabel)}</div>` : ''}
      ${inv.gatewayPaymentId ? `<div><strong>Payment Reference:</strong> ${escapeHtml(inv.gatewayPaymentId)} (${escapeHtml(inv.gateway || 'gateway')})</div>` : ''}
      ${inv.irn ? `<div><strong>e-Invoice IRN:</strong> ${escapeHtml(inv.irn)}${inv.irnAckNo ? ` (Ack ${escapeHtml(inv.irnAckNo)})` : ''}</div>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description of Service (SAC ${escapeHtml(inv.sacCode)})</th>
        <th class="num">Amount (${escapeHtml(inv.currency)})</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>${escapeHtml(inv.plan)} Subscription Service &mdash; Taxable Value${periodLabel ? ` (${escapeHtml(periodLabel)})` : ''}</td>
        <td class="num">${symbol}${inv.taxableBase.toFixed(2)}</td>
      </tr>
      ${taxRows}
      <tr class="total">
        <td>Total Invoice Value (${escapeHtml(inv.currency)})</td>
        <td class="num">${symbol}${inv.totalAmount.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <div class="foot">
    <div><strong>Compliance Status:</strong> ${escapeHtml(inv.taxComplianceStatus || 'COMPLIANT')} &middot; ${isVerifiedLutExport ? `Zero-rated export of services under LUT ${escapeHtml(inv.lutNumber || '')} (IGST Act Sec 2(6) &amp; Sec 16).` : (isExportDoc ? 'Export outside India; LUT verification pending before claiming zero-rated IGST Sec 2(6) status.' : 'Prices include applicable GST.')}</div>
    <div>Printable A4 HTML tax document (use browser Print &rarr; Save as PDF for local archival).</div>
    <div>Notice: Computer-generated document. Electronic signature / authentication under IT Act &amp; CGST Rule 46 requires separate authorized finance/sign-off (U2) before commercial release.</div>
  </div>
</body>
</html>`;
}

/**
 * Renders a self-contained A4 printable HTML Credit Note (CGST Act Sec 34 / Rule 53(1A)) from persisted snapshot data.
 */
export function buildCreditNoteHtmlDocument(cn: GstCreditNoteRenderInput): string {
  const symbol = cn.currency === 'INR' ? '₹' : '$';
  const isSandboxDoc = Boolean(cn.isSandbox || cn.creditNoteNumber.startsWith('SCN/'));
  const isVoided = cn.documentStatus === 'VOIDED';

  const supplierLegal = cn.supplierName || DEFAULT_SUPPLIER_LEGAL_NAME;
  const supplierTrade = cn.supplierTradeName || DEFAULT_SUPPLIER_TRADE_NAME;
  const supplierAddr = cn.supplierAddress || DEFAULT_SUPPLIER_ADDRESS;
  const supplierPan = cn.supplierPan || DEFAULT_SUPPLIER_PAN;
  const supplierCin = cn.supplierCin || DEFAULT_SUPPLIER_CIN;
  const supplierEmail = cn.supplierEmail || DEFAULT_SUPPLIER_EMAIL;
  const supplierState = cn.supplierStateCode || DEFAULT_SUPPLIER_STATE_CODE;
  const buyerEmail = sanitizeCustomerEmail(cn.customerEmail);

  const taxRows = buildTaxRowsHtml({
    symbol,
    currency: cn.currency,
    taxRate: cn.taxRate,
    cgstAmount: cn.cgstAmount,
    cgstRate: cn.cgstRate,
    sgstAmount: cn.sgstAmount,
    sgstRate: cn.sgstRate,
    utgstAmount: cn.utgstAmount,
    utgstRate: cn.utgstRate,
    igstAmount: cn.igstAmount,
    igstRate: cn.igstRate,
    gstAmount: cn.gstAmount,
    placeOfSupply: cn.placeOfSupply
  });

  const bannerHtml = isVoided
    ? `<div class="banner-voided">VOIDED CREDIT NOTE${cn.voidReason ? ` (${escapeHtml(cn.voidReason)})` : ''}</div>`
    : isSandboxDoc
      ? `<div class="banner-sandbox">SANDBOX REHEARSAL RECEIPT — NOT A VALID TAX INVOICE</div>`
      : '';

  const taxableDisplay = Number(cn.taxableBase ?? Math.max(0, Number(cn.refundAmount || 0) - Number(cn.gstAmount || 0))).toFixed(2);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AIRA Credit Note ${escapeHtml(cn.creditNoteNumber)}</title>
  <style>${SHARED_A4_STYLES}</style>
</head>
<body>
  ${bannerHtml}
  <div class="hdr">
    <div>
      <h1 style="margin:0 0 4px 0;font-size:21px;">${isSandboxDoc ? 'Sandbox Credit Note' : 'Credit Note (CGST Rule 53(1A))'}</h1>
      <div><strong>${escapeHtml(supplierLegal)}</strong>${supplierTrade !== supplierLegal ? ` <span class="meta">(${escapeHtml(supplierTrade)})</span>` : ''}</div>
      <div class="meta">${escapeHtml(supplierAddr)}</div>
      <div class="meta">
        ${cn.supplierGstin ? `GSTIN: <strong>${escapeHtml(cn.supplierGstin)}</strong> &middot; ` : 'GSTIN: Pending Provisioning &middot; '}
        State Code: ${escapeHtml(supplierState)} &middot; PAN: ${escapeHtml(supplierPan)} &middot; CIN: ${escapeHtml(supplierCin)}
      </div>
      <div class="meta">Billing Support: ${escapeHtml(supplierEmail)}</div>
    </div>
    <div style="text-align:right;min-width:210px;">
      <div style="font-family:monospace;font-weight:700;font-size:15px;">${escapeHtml(cn.creditNoteNumber)}</div>
      <div class="meta">Date (IST): ${escapeHtml(cn.date)}</div>
      ${cn.financialYear ? `<div class="meta">Financial Year: ${escapeHtml(cn.financialYear)}</div>` : ''}
      <div style="margin-top:6px;"><span class="badge ${isVoided ? 'badge-warn' : ''}">${escapeHtml(isVoided ? 'VOIDED' : cn.status)}</span></div>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Issued To (Recipient)</h2>
      <div><strong>${escapeHtml(cn.customerName || 'AIRA Subscriber')}</strong></div>
      ${buyerEmail ? `<div class="meta">${escapeHtml(buyerEmail)}</div>` : ''}
      ${cn.customerAddress ? `<div class="meta">${escapeHtml(cn.customerAddress)}</div>` : ''}
      ${cn.customerGstin ? `<div class="meta">Recipient GSTIN: <strong>${escapeHtml(cn.customerGstin)}</strong></div>` : ''}
    </div>
    <div class="card">
      <h2>Original Invoice Linkage</h2>
      <div><strong>Original Invoice:</strong> ${escapeHtml(cn.originalInvoiceNumber)}</div>
      ${cn.originalInvoiceDate ? `<div><strong>Original Invoice Date:</strong> ${escapeHtml(cn.originalInvoiceDate)}</div>` : ''}
      <div><strong>Reason:</strong> ${escapeHtml(cn.reason || 'Subscription refund / cancellation adjustment')}</div>
      ${cn.placeOfSupply ? `<div><strong>Place of Supply:</strong> ${escapeHtml(cn.placeOfSupplyName ? `${cn.placeOfSupplyName} (${cn.placeOfSupply})` : cn.placeOfSupply)}</div>` : ''}
      ${cn.customerStateCode ? `<div><strong>Recipient State Code:</strong> ${escapeHtml(cn.customerStateCode)}</div>` : ''}
      ${cn.isB2b ? '<div><strong>Supply Type:</strong> B2B</div>' : ''}
      ${cn.irn ? `<div><strong>IRN:</strong> ${escapeHtml(cn.irn)}${cn.irnAckNo ? ` (Ack: ${escapeHtml(cn.irnAckNo)})` : ''}</div>` : ''}
      ${cn.statutoryGstr1Cutoff ? `<div><strong>Statutory GSTR-1 Cutoff:</strong> ${escapeHtml(cn.statutoryGstr1Cutoff)}</div>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Credit Adjustment Description${cn.sacCode ? ` (SAC ${escapeHtml(cn.sacCode)})` : ''}</th>
        <th class="num">Credit Amount (${escapeHtml(cn.currency)})</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Proportional Taxable Credit against ${escapeHtml(cn.originalInvoiceNumber)}</td>
        <td class="num">${symbol}${taxableDisplay}</td>
      </tr>
      ${taxRows}
      <tr class="total">
        <td>Total Credit Note Value (${escapeHtml(cn.currency)})</td>
        <td class="num">${symbol}${Number(cn.refundAmount || 0).toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <div class="foot">
    <div>Printable A4 HTML credit note document (use browser Print &rarr; Save as PDF for local archival).</div>
    <div>Notice: Computer-generated Credit Note under CGST Act Section 34. Electronic authentication requires U2 finance sign-off prior to live commercial activation.</div>
  </div>
</body>
</html>`;
}
