import type { GstInvoiceRenderInput, GstCreditNoteRenderInput } from './gst-document-renderer.js';
import {
  DEFAULT_SUPPLIER_ADDRESS,
  DEFAULT_SUPPLIER_CIN,
  DEFAULT_SUPPLIER_EMAIL,
  DEFAULT_SUPPLIER_LEGAL_NAME,
  DEFAULT_SUPPLIER_PAN,
  DEFAULT_SUPPLIER_STATE_CODE
} from './tax-determination.js';

const WIN_ANSI_EXT_MAP: Record<string, number> = {
  '\u20AC': 0x80,
  '\u201A': 0x82,
  '\u0192': 0x83,
  '\u201E': 0x84,
  '\u2026': 0x85,
  '\u2020': 0x86,
  '\u2021': 0x87,
  '\u02C6': 0x88,
  '\u2030': 0x89,
  '\u0160': 0x8A,
  '\u2039': 0x8B,
  '\u0152': 0x8C,
  '\u017D': 0x8E,
  '\u2018': 0x91,
  '\u2019': 0x92,
  '\u201C': 0x93,
  '\u201D': 0x94,
  '\u2022': 0x95,
  '\u2013': 0x96,
  '\u2014': 0x97,
  '\u02DC': 0x98,
  '\u2122': 0x99,
  '\u0161': 0x9A,
  '\u203A': 0x9B,
  '\u0153': 0x9C,
  '\u017E': 0x9E,
  '\u0178': 0x9F
};

/**
 * Escapes and encodes text safely into single-byte WinAnsi / Latin-1 PDF string literals.
 */
function sanitizePdfText(input: unknown): string {
  const raw = String(input ?? '').normalize('NFC').replace(/\u20B9/g, 'Rs. ');
  let out = '';

  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7E) {
      if (ch === '\\' || ch === '(' || ch === ')') {
        out += `\\${ch}`;
      } else {
        out += ch;
      }
      continue;
    }

    if (code >= 0xA0 && code <= 0xFF) {
      out += String.fromCharCode(code);
      continue;
    }

    const extByte = WIN_ANSI_EXT_MAP[ch];
    if (extByte !== undefined) {
      out += String.fromCharCode(extByte);
      continue;
    }

    const folded = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    let appended = false;
    for (const fc of folded) {
      const fCode = fc.charCodeAt(0);
      if (fCode >= 0x20 && fCode <= 0x7E) {
        out += (fc === '\\' || fc === '(' || fc === ')') ? `\\${fc}` : fc;
        appended = true;
      } else if (fCode >= 0xA0 && fCode <= 0xFF) {
        out += String.fromCharCode(fCode);
        appended = true;
      }
    }
    if (!appended && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ' ';
    } else if (!appended) {
      out += '?';
    }
  }

  return out;
}

function wrapLine(text: string, maxChars: number): string[] {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (!current) {
      if (word.length <= maxChars) {
        current = word;
      } else {
        for (let i = 0; i < word.length; i += maxChars) {
          const chunk = word.slice(i, i + maxChars);
          if (chunk.length === maxChars) lines.push(chunk);
          else current = chunk;
        }
      }
    } else if (current.length + 1 + word.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      if (word.length <= maxChars) {
        current = word;
      } else {
        current = '';
        for (let i = 0; i < word.length; i += maxChars) {
          const chunk = word.slice(i, i + maxChars);
          if (chunk.length === maxChars) lines.push(chunk);
          else current = chunk;
        }
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Returns true if the text contains characters that cannot be encoded in WinAnsiEncoding
 * (Basic Latin + Latin-1 Supplement + WIN_ANSI_EXT_MAP). Detects non-Latin scripts such
 * as Devanagari (Hindi), Arabic, CJK, etc., which would be corrupted or silently dropped
 * by sanitizePdfText().
 */
export function hasUnsupportedUnicodeContent(text: string): boolean {
  if (!text) return false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code <= 0x7E) continue; // Basic Latin
    if (code >= 0xA0 && code <= 0xFF) continue; // Latin-1 Supplement
    if (WIN_ANSI_EXT_MAP[ch] !== undefined) continue; // WIN_ANSI extension
    // Try NFKD fold — if folded chars are all in-range, still safe
    const folded = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    let foldedSafe = folded.length > 0;
    for (const fc of folded) {
      const fc0 = fc.charCodeAt(0);
      if (!((fc0 >= 0x20 && fc0 <= 0x7E) || (fc0 >= 0xA0 && fc0 <= 0xFF))) {
        foldedSafe = false;
        break;
      }
    }
    if (!foldedSafe) return true;
  }
  return false;
}

function sanitizeBuyerEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const trimmed = email.trim();
  if (!trimmed || trimmed.endsWith('@aira.internal')) return undefined;
  return trimmed;
}

function formatIstDate(epochMs?: number): string | null {
  if (!epochMs || !Number.isFinite(epochMs)) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(epochMs));
  } catch {
    return null;
  }
}

/**
 * Serializes a valid multi-page A4 PDF (595x842 pt) with WinAnsiEncoding core fonts
 * and exact byte-offset cross-reference table.
 */
function assembleMultiPageA4Pdf(pages: string[]): Buffer {
  const pageList = pages.length > 0 ? pages : [''];
  const pageCount = pageList.length;
  const objects: Array<{ id: number; body: string }> = [];

  const pageObjIds: number[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    pageObjIds.push(5 + i * 2);
  }

  objects.push({ id: 1, body: '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' });
  objects.push({
    id: 2,
    body: `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>\nendobj\n`
  });
  objects.push({
    id: 3,
    body: '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n'
  });
  objects.push({
    id: 4,
    body: '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n'
  });

  for (let i = 0; i < pageCount; i += 1) {
    const pageId = 5 + i * 2;
    const streamId = 6 + i * 2;
    const stream = pageList[i];
    const streamLen = Buffer.byteLength(stream, 'latin1');

    objects.push({
      id: pageId,
      body: `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>\nendobj\n`
    });
    objects.push({
      id: streamId,
      body: `${streamId} 0 obj\n<< /Length ${streamLen} >>\nstream\n${stream}\nendstream\nendobj\n`
    });
  }

  const header = '%PDF-1.4\n';
  const offsets: number[] = [0];
  let byteCursor = Buffer.byteLength(header, 'latin1');
  const rawParts: string[] = [header];

  for (const obj of objects) {
    offsets.push(byteCursor);
    rawParts.push(obj.body);
    byteCursor += Buffer.byteLength(obj.body, 'latin1');
  }

  const totalEntries = objects.length + 1;
  const xrefOffset = byteCursor;
  const xrefLines = [`xref\n0 ${totalEntries}\n0000000000 65535 f \n`];
  for (let i = 1; i < offsets.length; i += 1) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }

  const trailer = `trailer\n<< /Size ${totalEntries} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  rawParts.push(xrefLines.join(''), trailer);

  return Buffer.from(rawParts.join(''), 'latin1');
}

class PdfCursor {
  private pages: string[][] = [[]];
  private y = 800;
  private continuationHeader: string;

  constructor(continuationHeader = 'AIRA AI 2026 - Billing Document') {
    this.continuationHeader = continuationHeader;
  }

  private currentCmds(): string[] {
    return this.pages[this.pages.length - 1];
  }

  private ensureSpace(neededPts: number): void {
    if (this.y - neededPts >= 58) return;
    this.pages.push([]);
    const pageNumber = this.pages.length;
    this.currentCmds().push(
      `BT /F2 9 Tf 0.45 0.43 0.40 rg 42 814 Td (${sanitizePdfText(`${this.continuationHeader} (Page ${pageNumber})`)}) Tj ET`
    );
    this.currentCmds().push('0.88 0.85 0.81 RG 0.6 w 42 806 m 553 806 l S');
    this.y = 788;
  }

  private pushLine(
    lineText: string,
    opts?: { bold?: boolean; size?: number; color?: [number, number, number]; rightText?: string; isFirstLine?: boolean }
  ): void {
    const size = opts?.size ?? 9.5;
    const font = opts?.bold ? '/F2' : '/F1';
    const [r, g, b] = opts?.color ?? [0.15, 0.14, 0.13];
    const lineAdvance = Math.round(size * 1.48);

    this.ensureSpace(lineAdvance);
    this.currentCmds().push(`BT ${font} ${size} Tf ${r} ${g} ${b} rg 42 ${this.y} Td (${sanitizePdfText(lineText)}) Tj ET`);
    if (opts?.rightText && opts.isFirstLine) {
      this.currentCmds().push(`BT ${font} ${size} Tf ${r} ${g} ${b} rg 430 ${this.y} Td (${sanitizePdfText(opts.rightText)}) Tj ET`);
    }
    this.y -= lineAdvance;
  }

  heading(text: string, rightText?: string): void {
    this.ensureSpace(24);
    this.currentCmds().push(`BT /F2 15 Tf 0.11 0.10 0.09 rg 42 ${this.y} Td (${sanitizePdfText(text)}) Tj ET`);
    if (rightText) {
      this.currentCmds().push(`BT /F2 12 Tf 0.11 0.10 0.09 rg 360 ${this.y} Td (${sanitizePdfText(rightText)}) Tj ET`);
    }
    this.y -= 20;
  }

  drawBanner(text: string, r: number, g: number, b: number): void {
    this.ensureSpace(22);
    this.currentCmds().push(`${r} ${g} ${b} rg 42 ${this.y - 4} 511 16 re f`);
    this.currentCmds().push(`BT /F2 8.5 Tf 1 1 1 rg 50 ${this.y} Td (${sanitizePdfText(text)}) Tj ET`);
    this.y -= 22;
  }

  line(text: string, opts?: { bold?: boolean; size?: number; color?: [number, number, number]; rightText?: string; maxChars?: number }): void {
    const maxChars = opts?.maxChars ?? (opts?.rightText ? 60 : 88);
    const wrapped = wrapLine(text, maxChars);
    if (wrapped.length === 0) return;

    for (let i = 0; i < wrapped.length; i += 1) {
      this.pushLine(wrapped[i], {
        ...opts,
        isFirstLine: i === 0
      });
    }
  }

  divider(): void {
    this.ensureSpace(12);
    this.currentCmds().push('0.86 0.83 0.78 RG 0.6 w 42 ' + (this.y + 4) + ' m 553 ' + (this.y + 4) + ' l S');
    this.y -= 8;
  }

  gap(pts = 8): void {
    if (this.y - pts >= 58) {
      this.y -= pts;
    }
  }

  toPages(): string[] {
    return this.pages.map(cmds => cmds.join('\n'));
  }
}

export function buildInvoicePdfBuffer(inv: GstInvoiceRenderInput): Buffer {
  // Guard: reject non-Latin customer text that WinAnsiEncoding cannot represent.
  const nonLatinFields = [inv.buyerName, inv.buyerAddress, inv.buyerAddressLine2].filter(Boolean) as string[];
  for (const field of nonLatinFields) {
    if (hasUnsupportedUnicodeContent(field)) {
      const err: any = new Error('PDF_UNSUPPORTED_CHARACTERS: Customer name or address contains non-Latin characters that cannot be encoded in WinAnsiEncoding. Use the HTML invoice instead.');
      err.code = 'PDF_UNSUPPORTED_CHARACTERS';
      err.htmlAlternativeAvailable = true;
      throw err;
    }
  }

  const isSandboxDoc = Boolean(inv.isSandbox);
  const isVoidedDoc = String(inv.documentStatus || '').toUpperCase() === 'VOIDED';
  const currencyPrefix = inv.currency === 'INR' ? 'INR ' : `${inv.currency} `;
  const isExportDoc = inv.posBasis === 'EXPORT_OUTSIDE_INDIA';
  const isVerifiedLutExport = isExportDoc && (
    inv.taxComplianceStatus === 'COMPLIANT_ZERO_RATED_EXPORT' ||
    Boolean(inv.lutApproved && inv.lutNumber)
  );

  const pdf = new PdfCursor(`AIRA AI 2026 - Invoice ${inv.invoiceNumber}`);

  if (isVoidedDoc) {
    pdf.drawBanner(`VOIDED DOCUMENT - NOT VALID FOR INPUT TAX CREDIT`, 0.72, 0.14, 0.14);
  } else if (isSandboxDoc) {
    pdf.drawBanner(`SANDBOX REHEARSAL RECEIPT - NOT A VALID TAX INVOICE`, 0.76, 0.42, 0.05);
  }

  const docTitle = isSandboxDoc
    ? (isExportDoc ? 'Sandbox Export Receipt' : 'Sandbox Tax Invoice')
    : (isExportDoc ? (isVerifiedLutExport ? 'Commercial Export Invoice' : 'Provisional Export Statement') : 'Tax Invoice');

  pdf.heading(docTitle, inv.invoiceNumber);

  const supplierLegal = inv.supplierName || DEFAULT_SUPPLIER_LEGAL_NAME;
  const supplierAddr = inv.supplierAddress || DEFAULT_SUPPLIER_ADDRESS;
  const supplierState = inv.supplierStateCode || DEFAULT_SUPPLIER_STATE_CODE;
  const supplierPan = inv.supplierPan || DEFAULT_SUPPLIER_PAN;
  const supplierCin = inv.supplierCin || DEFAULT_SUPPLIER_CIN;
  const supplierEmail = inv.supplierEmail || DEFAULT_SUPPLIER_EMAIL;

  pdf.line(supplierLegal, { bold: true, size: 10.5 });
  pdf.line(supplierAddr, { size: 9, color: [0.35, 0.34, 0.32] });
  pdf.line(
    `GSTIN: ${inv.supplierGstin || 'Provisional (Pending Registration)'} | PAN: ${supplierPan} | CIN: ${supplierCin} | State: ${supplierState}`,
    { size: 8.5, color: [0.35, 0.34, 0.32] }
  );
  pdf.line(`Support: ${supplierEmail}`, { size: 8.5, color: [0.35, 0.34, 0.32] });

  pdf.gap(4);
  pdf.divider();

  pdf.line(`Invoice Date (IST): ${inv.date}`, {
    size: 9,
    rightText: `Status: ${isVoidedDoc ? 'VOIDED' : inv.status}`
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
  if (inv.customerStateCode) pdf.line(`Region / State: ${inv.customerStateName || inv.customerStateCode}`, { size: 9 });
  if (inv.customerGstin) pdf.line(`Customer GSTIN (B2B): ${inv.customerGstin}`, { size: 9, bold: true });
  if (isExportDoc) {
    pdf.line(`Destination / Place of Supply: ${inv.placeOfSupplyName || inv.placeOfSupply || 'Outside India'} (Export of Services)`, { size: 9 });
  } else if (inv.placeOfSupply) {
    pdf.line(`Place of Supply: ${inv.placeOfSupplyName ? `${inv.placeOfSupplyName} (${inv.placeOfSupply})` : inv.placeOfSupply}`, { size: 9 });
  }

  pdf.gap(6);
  pdf.divider();

  pdf.line(`Description (SAC ${inv.sacCode || '998315'})`, { bold: true, size: 9.5, rightText: `Amount (${inv.currency})` });
  pdf.gap(2);
  pdf.line(
    `${inv.plan} Subscription - 30 Days AI Workspace Access`,
    { rightText: `${currencyPrefix}${Number(inv.taxableBase || 0).toFixed(2)}` }
  );

  if (isExportDoc && Number(inv.gstAmount ?? 0) === 0) {
    if (isVerifiedLutExport) {
      const lutSuffix = inv.lutNumber ? ` (${inv.lutNumber})` : '';
      pdf.line(`Zero-Rated Export (IGST Act Sec 2(6) / LUT${lutSuffix})`, { rightText: `${currencyPrefix}0.00` });
    } else {
      pdf.line('Export of Services (Outside India - LUT Pending Verification)', { rightText: `${currencyPrefix}0.00` });
    }
  } else if (inv.cgstAmount !== undefined && (inv.utgstRate !== undefined || (inv.utgstAmount !== undefined && inv.utgstAmount > 0))) {
    pdf.line('CGST', { rightText: `${currencyPrefix}${Number(inv.cgstAmount).toFixed(2)}` });
    pdf.line('UTGST', { rightText: `${currencyPrefix}${Number(inv.utgstAmount).toFixed(2)}` });
  } else if (inv.cgstAmount !== undefined && inv.sgstAmount !== undefined) {
    pdf.line('CGST (9%)', { rightText: `${currencyPrefix}${Number(inv.cgstAmount).toFixed(2)}` });
    pdf.line('SGST (9%)', { rightText: `${currencyPrefix}${Number(inv.sgstAmount).toFixed(2)}` });
  } else if (inv.igstAmount !== undefined) {
    pdf.line('IGST (18%)', { rightText: `${currencyPrefix}${Number(inv.igstAmount).toFixed(2)}` });
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
    color: [0.4, 0.39, 0.37]
  });
  if (inv.irn) {
    pdf.line(`e-Invoice IRN: ${inv.irn}`, { size: 8, color: [0.4, 0.39, 0.37] });
  }
  pdf.line('Computer-generated electronic invoice document issued by VIREXA AI VENTURES PRIVATE LIMITED.', {
    size: 8,
    color: [0.45, 0.44, 0.42]
  });

  return assembleMultiPageA4Pdf(pdf.toPages());
}

export function buildCreditNotePdfBuffer(cn: GstCreditNoteRenderInput): Buffer {
  // Guard: reject non-Latin customer text that WinAnsiEncoding cannot represent.
  const nonLatinFields = [cn.buyerName, cn.buyerAddress].filter(Boolean) as string[];
  for (const field of nonLatinFields) {
    if (hasUnsupportedUnicodeContent(field)) {
      const err: any = new Error('PDF_UNSUPPORTED_CHARACTERS: Customer name or address contains non-Latin characters that cannot be encoded in WinAnsiEncoding. Use the HTML invoice instead.');
      err.code = 'PDF_UNSUPPORTED_CHARACTERS';
      err.htmlAlternativeAvailable = true;
      throw err;
    }
  }

  const isSandboxDoc = Boolean(cn.isSandbox);
  const isVoidedDoc = String(cn.documentStatus || '').toUpperCase() === 'VOIDED';
  const currencyPrefix = cn.currency === 'INR' ? 'INR ' : `${cn.currency} `;
  const pdf = new PdfCursor(`AIRA AI 2026 - Credit Note ${cn.creditNoteNumber}`);

  if (isVoidedDoc) {
    pdf.drawBanner('VOIDED CREDIT NOTE', 0.72, 0.14, 0.14);
  } else if (isSandboxDoc) {
    pdf.drawBanner('SANDBOX REHEARSAL RECEIPT - NOT A VALID TAX CREDIT NOTE', 0.76, 0.42, 0.05);
  }

  pdf.heading(isSandboxDoc ? 'Sandbox Credit Note' : 'Credit Note (CGST Rule 53(1A))', cn.creditNoteNumber);
  pdf.line(cn.supplierName || DEFAULT_SUPPLIER_LEGAL_NAME, { bold: true, size: 10.5 });
  pdf.line(cn.supplierAddress || DEFAULT_SUPPLIER_ADDRESS, { size: 9, color: [0.35, 0.34, 0.32] });
  pdf.divider();

  pdf.line(`Original Invoice: ${cn.originalInvoiceNumber}`, {
    size: 9,
    rightText: `Status: ${cn.status}`
  });
  pdf.line(`Credit Note Date (IST): ${cn.date}`, { size: 9 });
  if (cn.reason) pdf.line(`Reason: ${cn.reason}`, { size: 9 });
  pdf.gap(4);
  pdf.divider();

  pdf.line(`Issued To: ${cn.customerName || 'AIRA Subscriber'}`, { bold: true });
  const buyerEmail = sanitizeBuyerEmail(cn.customerEmail);
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
  } else if (cn.igstAmount !== undefined) {
    pdf.line('IGST Reversal', { rightText: `${currencyPrefix}${Number(cn.igstAmount).toFixed(2)}` });
  }
  pdf.divider();
  pdf.line(`Total Credit Note Value (${cn.currency})`, {
    bold: true,
    size: 11,
    rightText: `${currencyPrefix}${Number(cn.refundAmount || 0).toFixed(2)}`
  });

  return assembleMultiPageA4Pdf(pdf.toPages());
}
