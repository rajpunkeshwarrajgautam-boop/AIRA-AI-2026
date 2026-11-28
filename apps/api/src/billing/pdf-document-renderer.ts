import type { GstInvoiceRenderInput, GstCreditNoteRenderInput } from './gst-document-renderer.js';
import {
  DEFAULT_SUPPLIER_ADDRESS,
  DEFAULT_SUPPLIER_CIN,
  DEFAULT_SUPPLIER_EMAIL,
  DEFAULT_SUPPLIER_LEGAL_NAME,
  DEFAULT_SUPPLIER_PAN,
  DEFAULT_SUPPLIER_STATE_CODE
} from './tax-determination.js';

function sanitizePdfText(input: unknown): string {
  return String(input ?? '')
    .replace(/₹/g, 'INR ')
    .replace(/•/g, '*')
    .replace(/—/g, '-')
    .replace(/–/g, '-')
    .replace(/·/g, '|')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\s+/g, ' ')
    .trim();
}

function wrapLine(text: string, maxChars: number): string[] {
  const clean = sanitizePdfText(text);
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + 1 + w.length <= maxChars) {
      cur += ` ${w}`;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function sanitizeBuyerEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const t = email.trim();
  if (!t || t.endsWith('@aira.internal')) return undefined;
  return t;
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

function assembleSinglePageA4Pdf(contentStream: string): Buffer {
  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(contentStream, 'latin1')} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n'
  ];

  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const chunks: Buffer[] = [Buffer.from(header, 'latin1')];
  const offsets: number[] = [0];
  let byteCursor = Buffer.byteLength(header, 'latin1');

  for (const obj of objects) {
    offsets.push(byteCursor);
    const buf = Buffer.from(obj, 'latin1');
    chunks.push(buf);
    byteCursor += buf.length;
  }

  const xrefOffset = byteCursor;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  const trailer =
    `${xrefLines.join('')}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(chunks);
}

class PdfCursor {
  private cmds: string[] = [];
  private y = 800;

  drawBanner(text: string, r: number, g: number, b: number): void {
    const clean = sanitizePdfText(text);
    this.cmds.push(`q ${r} ${g} ${b} rg 42 ${this.y - 18} 511 22 re f Q`);
    this.cmds.push(`BT /F2 9.5 Tf 1 1 1 rg 52 ${this.y - 10} Td (${clean}) Tj ET`);
    this.y -= 30;
  }

  heading(text: string, rightText?: string): void {
    this.cmds.push(`BT /F2 15 Tf 0.11 0.10 0.09 rg 42 ${this.y} Td (${sanitizePdfText(text)}) Tj ET`);
    if (rightText) {
      this.cmds.push(`BT /F2 12 Tf 0.11 0.10 0.09 rg 360 ${this.y} Td (${sanitizePdfText(rightText)}) Tj ET`);
    }
    this.y -= 20;
  }

  line(text: string, opts?: { bold?: boolean; size?: number; indent?: number; color?: [number, number, number]; rightText?: string }): void {
    const font = opts?.bold ? '/F2' : '/F1';
    const size = opts?.size ?? 9.5;
    const x = 42 + (opts?.indent ?? 0);
    const [r, g, b] = opts?.color ?? [0.18, 0.17, 0.16];
    const maxChars = Math.max(40, Math.floor((opts?.rightText ? 340 - x : 510 - x) / (size * 0.5)));
    const wrapped = wrapLine(text, maxChars);

    wrapped.forEach((part, idx) => {
      this.cmds.push(`BT ${font} ${size} Tf ${r} ${g} ${b} rg ${x} ${this.y} Td (${part}) Tj ET`);
      if (idx === 0 && opts?.rightText) {
        this.cmds.push(`BT ${font} ${size} Tf ${r} ${g} ${b} rg 430 ${this.y} Td (${sanitizePdfText(opts.rightText)}) Tj ET`);
      }
      this.y -= size + 5;
    });
  }

  divider(): void {
    this.cmds.push(`q 0.85 0.84 0.82 RG 0.8 w 42 ${this.y + 4} m 553 ${this.y + 4} l S Q`);
    this.y -= 12;
  }

  gap(points = 8): void {
    this.y -= points;
  }

  toStream(): string {
    return this.cmds.join('\n');
  }
}

/**
 * Generates a deterministic A4 binary PDF (%PDF-1.4) invoice document strictly
 * from persisted invoice snapshot data without ever including internal user IDs.
 */
export function buildInvoicePdfBuffer(inv: GstInvoiceRenderInput): Buffer {
  const pdf = new PdfCursor();
  const isSandboxDoc = Boolean(
    inv.isSandbox ||
    inv.taxComplianceStatus === 'SANDBOX_REHEARSAL' ||
    inv.invoiceNumber.startsWith('SBX/')
  );
  const isVoided = inv.documentStatus === 'VOIDED';
  const currencyPrefix = inv.currency === 'INR' ? 'INR ' : `${inv.currency} `;
  const isExportZeroRated = inv.currency !== 'INR' && Number(inv.gstAmount || 0) === 0;

  if (isVoided) {
    pdf.drawBanner(`VOIDED DOCUMENT - NOT VALID FOR INPUT TAX CREDIT`, 0.72, 0.14, 0.14);
  } else if (isSandboxDoc) {
    pdf.drawBanner(`SANDBOX REHEARSAL RECEIPT - NOT A VALID TAX INVOICE`, 0.76, 0.42, 0.05);
  }

  pdf.heading(
    isSandboxDoc ? 'Sandbox Receipt' : (isExportZeroRated ? 'Commercial Export Invoice' : 'Tax Invoice'),
    inv.invoiceNumber
  );

  const supplierLegal = inv.supplierName || DEFAULT_SUPPLIER_LEGAL_NAME;
  const supplierAddr = inv.supplierAddress || DEFAULT_SUPPLIER_ADDRESS;
  const supplierState = inv.supplierStateCode || DEFAULT_SUPPLIER_STATE_CODE;
  const supplierPan = inv.supplierPan || DEFAULT_SUPPLIER_PAN;
  const supplierCin = inv.supplierCin || DEFAULT_SUPPLIER_CIN;
  const supplierEmail = inv.supplierEmail || DEFAULT_SUPPLIER_EMAIL;

  pdf.line(supplierLegal, { bold: true, size: 10.5 });
  pdf.line(supplierAddr, { size: 9, color: [0.35, 0.34, 0.32] });
  pdf.line(
    `${inv.supplierGstin ? `GSTIN: ${inv.supplierGstin} | ` : ''}State: ${supplierState} | PAN: ${supplierPan} | CIN: ${supplierCin}`,
    { size: 8.5, color: [0.35, 0.34, 0.32] }
  );
  pdf.line(`Support: ${supplierEmail}`, { size: 8.5, color: [0.35, 0.34, 0.32] });

  pdf.gap(4);
  pdf.divider();

  pdf.line(`Invoice Date (IST): ${inv.date}`, {
    rightText: `Status: ${isVoided ? 'VOIDED' : inv.status}`,
    bold: true
  });
  if (inv.financialYear) {
    pdf.line(`Financial Year: ${inv.financialYear}`, { size: 9 });
  }
  const startStr = formatIstDate(inv.billingPeriodStart);
  const endStr = formatIstDate(inv.billingPeriodEnd);
  if (startStr && endStr) {
    pdf.line(`Service Period: ${startStr} to ${endStr}`, { size: 9 });
  }
  if (inv.gatewayPaymentId) {
    pdf.line(`Payment Ref: ${inv.gatewayPaymentId}${inv.paymentMethod ? ` (${inv.paymentMethod})` : ''}`, { size: 9 });
  }

  pdf.gap(6);
  pdf.divider();

  pdf.line('Billed To', { bold: true, size: 10 });
  pdf.line(inv.customerName || 'AIRA Subscriber', { bold: true });
  const buyerEmail = sanitizeBuyerEmail(inv.customerEmail);
  if (buyerEmail) pdf.line(buyerEmail, { size: 9 });
  if (inv.customerAddress) pdf.line(inv.customerAddress, { size: 9 });
  if (inv.customerGstin) {
    pdf.line(`Customer GSTIN (B2B): ${inv.customerGstin}`, { size: 9, bold: true });
  } else if (isExportZeroRated) {
    pdf.line(`Destination / Place of Supply: ${inv.placeOfSupplyName || inv.placeOfSupply || 'Outside India'} (Export of Services)`, { size: 9 });
  } else if (inv.placeOfSupply) {
    pdf.line(`Place of Supply: ${inv.placeOfSupplyName ? `${inv.placeOfSupplyName} (${inv.placeOfSupply})` : inv.placeOfSupply}`, { size: 9 });
  }

  pdf.gap(6);
  pdf.divider();

  pdf.line(`Description (SAC ${inv.sacCode || '998315'})`, { bold: true, size: 9.5, rightText: `Amount (${inv.currency})` });
  pdf.gap(2);
  pdf.line(
    `${inv.plan} Monthly Subscription${startStr && endStr ? ` (${startStr} - ${endStr})` : ''}`,
    { rightText: `${currencyPrefix}${Number(inv.taxableBase || 0).toFixed(2)}` }
  );

  if (inv.cgstAmount !== undefined && inv.utgstAmount !== undefined && inv.utgstAmount > 0) {
    pdf.line('CGST', { rightText: `${currencyPrefix}${Number(inv.cgstAmount).toFixed(2)}` });
    pdf.line('UTGST', { rightText: `${currencyPrefix}${Number(inv.utgstAmount).toFixed(2)}` });
  } else if (inv.cgstAmount !== undefined && inv.sgstAmount !== undefined) {
    pdf.line('CGST (9%)', { rightText: `${currencyPrefix}${Number(inv.cgstAmount).toFixed(2)}` });
    pdf.line('SGST (9%)', { rightText: `${currencyPrefix}${Number(inv.sgstAmount).toFixed(2)}` });
  } else if (inv.igstAmount !== undefined && inv.igstAmount > 0) {
    pdf.line('IGST (18%)', { rightText: `${currencyPrefix}${Number(inv.igstAmount).toFixed(2)}` });
  } else if (isExportZeroRated) {
    pdf.line('Zero-Rated Export of Services (0% Tax)', { rightText: `${currencyPrefix}0.00` });
  } else {
    pdf.line('Applicable Tax', { rightText: `${currencyPrefix}${Number(inv.gstAmount || 0).toFixed(2)}` });
  }

  pdf.divider();
  pdf.line(`Total Paid (${inv.currency})`, {
    bold: true,
    size: 11,
    rightText: `${currencyPrefix}${Number(inv.totalAmount || 0).toFixed(2)}`
  });

  pdf.gap(12);
  pdf.line(`Compliance Status: ${inv.taxComplianceStatus || 'COMPLIANT'} | Reverse Charge: ${inv.reverseCharge ? 'Yes' : 'No'}`, {
    size: 8.5,
    color: [0.40, 0.39, 0.37]
  });
  pdf.line('Computer-generated electronic invoice document issued by VIREXA AI VENTURES PRIVATE LIMITED.', {
    size: 8.5,
    color: [0.40, 0.39, 0.37]
  });

  return assembleSinglePageA4Pdf(pdf.toStream());
}

/**
 * Generates a deterministic A4 binary PDF (%PDF-1.4) credit note document.
 */
export function buildCreditNotePdfBuffer(cn: GstCreditNoteRenderInput): Buffer {
  const pdf = new PdfCursor();
  const isSandboxDoc = Boolean(cn.isSandbox || cn.creditNoteNumber.startsWith('SCN/'));
  const isVoided = cn.documentStatus === 'VOIDED';
  const currencyPrefix = cn.currency === 'INR' ? 'INR ' : `${cn.currency} `;

  if (isVoided) {
    pdf.drawBanner('VOIDED CREDIT NOTE', 0.72, 0.14, 0.14);
  } else if (isSandboxDoc) {
    pdf.drawBanner('SANDBOX REHEARSAL RECEIPT - NOT A VALID TAX CREDIT NOTE', 0.76, 0.42, 0.05);
  }

  pdf.heading(isSandboxDoc ? 'Sandbox Credit Note' : 'Credit Note (CGST Rule 53(1A))', cn.creditNoteNumber);
  pdf.line(cn.supplierName || DEFAULT_SUPPLIER_LEGAL_NAME, { bold: true, size: 10.5 });
  pdf.line(cn.supplierAddress || DEFAULT_SUPPLIER_ADDRESS, { size: 9, color: [0.35, 0.34, 0.32] });
  pdf.divider();

  pdf.line(`Original Invoice: ${cn.originalInvoiceNumber}`, {
    bold: true,
    rightText: `Status: ${isVoided ? 'VOIDED' : cn.status}`
  });
  pdf.line(`Credit Note Date (IST): ${cn.date}`, { size: 9 });
  if (cn.reason) pdf.line(`Reason: ${cn.reason}`, { size: 9 });
  pdf.gap(4);
  pdf.divider();

  const buyerEmail = sanitizeBuyerEmail(cn.customerEmail);
  pdf.line(`Issued To: ${cn.customerName || 'AIRA Subscriber'}`, { bold: true });
  if (buyerEmail) pdf.line(buyerEmail, { size: 9 });
  if (cn.customerGstin) pdf.line(`Customer GSTIN: ${cn.customerGstin}`, { size: 9 });
  pdf.gap(4);
  pdf.divider();

  const taxable = Number(cn.taxableBase ?? Math.max(0, Number(cn.refundAmount || 0) - Number(cn.gstAmount || 0)));
  pdf.line('Credit Adjustment Description', { bold: true, rightText: `Credit (${cn.currency})` });
  pdf.line(`Taxable Adjustment (${cn.originalInvoiceNumber})`, { rightText: `${currencyPrefix}${taxable.toFixed(2)}` });
  if (cn.cgstAmount !== undefined && cn.sgstAmount !== undefined) {
    pdf.line('CGST Reversal', { rightText: `${currencyPrefix}${Number(cn.cgstAmount).toFixed(2)}` });
    pdf.line('SGST Reversal', { rightText: `${currencyPrefix}${Number(cn.sgstAmount).toFixed(2)}` });
  } else if (cn.igstAmount !== undefined && cn.igstAmount > 0) {
    pdf.line('IGST Reversal', { rightText: `${currencyPrefix}${Number(cn.igstAmount).toFixed(2)}` });
  }
  pdf.divider();
  pdf.line(`Total Credit Note Value (${cn.currency})`, {
    bold: true,
    size: 11,
    rightText: `${currencyPrefix}${Number(cn.refundAmount || 0).toFixed(2)}`
  });

  return assembleSinglePageA4Pdf(pdf.toStream());
}
