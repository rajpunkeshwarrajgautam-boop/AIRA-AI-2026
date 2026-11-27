import type { SpreadsheetWorkbook, PresentationDeck } from '../../packages/contracts/src/artifacts.js';
import { computeCrc32 } from './artifactZipExporter.js';
import { colIndexToLetter, colLetterToIndex } from './spreadsheetEngine.js';

interface ZipEntry {
  path: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/**
 * Builds an in-memory PKZip archive from a collection of file paths and string/binary contents.
 */
export function buildZipPackage(files: Array<{ path: string; content: string | Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [];

  for (const f of files) {
    const data = typeof f.content === 'string' ? encoder.encode(f.content) : f.content;
    entries.push({
      path: f.path,
      data,
      crc: computeCrc32(data),
      offset: 0,
    });
  }

  let localHeadersSize = 0;
  let centralDirSize = 0;

  for (const entry of entries) {
    const pathBytes = encoder.encode(entry.path);
    localHeadersSize += 30 + pathBytes.length + entry.data.length;
    centralDirSize += 46 + pathBytes.length;
  }

  const endRecordSize = 22;
  const totalArchiveSize = localHeadersSize + centralDirSize + endRecordSize;

  const buffer = new Uint8Array(totalArchiveSize);
  const view = new DataView(buffer.buffer);
  let cursor = 0;

  // 1. Write Local File Headers & File Data
  for (const entry of entries) {
    entry.offset = cursor;
    const pathBytes = encoder.encode(entry.path);

    // Signature 0x04034b50 (PK\x03\x04)
    view.setUint32(cursor, 0x04034b50, true); cursor += 4;
    view.setUint16(cursor, 20, true); cursor += 2; // version needed
    view.setUint16(cursor, 0x0800, true); cursor += 2; // UTF-8 flag
    view.setUint16(cursor, 0, true); cursor += 2; // no compression (store)
    view.setUint16(cursor, 0, true); cursor += 2; // mod time
    view.setUint16(cursor, 0, true); cursor += 2; // mod date
    view.setUint32(cursor, entry.crc, true); cursor += 4; // crc32
    view.setUint32(cursor, entry.data.length, true); cursor += 4; // compressed size
    view.setUint32(cursor, entry.data.length, true); cursor += 4; // uncompressed size
    view.setUint16(cursor, pathBytes.length, true); cursor += 2; // path length
    view.setUint16(cursor, 0, true); cursor += 2; // extra field length

    buffer.set(pathBytes, cursor); cursor += pathBytes.length;
    buffer.set(entry.data, cursor); cursor += entry.data.length;
  }

  // 2. Write Central Directory Headers
  const centralDirOffset = cursor;
  for (const entry of entries) {
    const pathBytes = encoder.encode(entry.path);

    // Signature 0x02014b50 (PK\x01\x02)
    view.setUint32(cursor, 0x02014b50, true); cursor += 4;
    view.setUint16(cursor, 20, true); cursor += 2; // version made by
    view.setUint16(cursor, 20, true); cursor += 2; // version needed
    view.setUint16(cursor, 0x0800, true); cursor += 2; // UTF-8 flag
    view.setUint16(cursor, 0, true); cursor += 2; // no compression
    view.setUint16(cursor, 0, true); cursor += 2; // mod time
    view.setUint16(cursor, 0, true); cursor += 2; // mod date
    view.setUint32(cursor, entry.crc, true); cursor += 4; // crc32
    view.setUint32(cursor, entry.data.length, true); cursor += 4; // compressed size
    view.setUint32(cursor, entry.data.length, true); cursor += 4; // uncompressed size
    view.setUint16(cursor, pathBytes.length, true); cursor += 2; // path length
    view.setUint16(cursor, 0, true); cursor += 2; // extra field length
    view.setUint16(cursor, 0, true); cursor += 2; // comment length
    view.setUint16(cursor, 0, true); cursor += 2; // disk number start
    view.setUint16(cursor, 0, true); cursor += 2; // internal file attributes
    view.setUint32(cursor, 0, true); cursor += 4; // external file attributes
    view.setUint32(cursor, entry.offset, true); cursor += 4; // relative offset of local header

    buffer.set(pathBytes, cursor); cursor += pathBytes.length;
  }

  // 3. Write End of Central Directory Record
  const centralDirLength = cursor - centralDirOffset;

  // Signature 0x06054b50 (PK\x05\x06)
  view.setUint32(cursor, 0x06054b50, true); cursor += 4;
  view.setUint16(cursor, 0, true); cursor += 2; // disk number
  view.setUint16(cursor, 0, true); cursor += 2; // start disk
  view.setUint16(cursor, entries.length, true); cursor += 2; // records on disk
  view.setUint16(cursor, entries.length, true); cursor += 2; // total records
  view.setUint32(cursor, centralDirLength, true); cursor += 4; // central dir size
  view.setUint32(cursor, centralDirOffset, true); cursor += 4; // central dir offset
  view.setUint16(cursor, 0, true); cursor += 2; // comment length

  return buffer;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates a valid OpenXML (.docx) Word Document archive.
 */
export function generateDocxArchive(title: string, markdownOrText: string): Uint8Array {
  const safeTitle = escapeXml(title);
  const paragraphs = markdownOrText
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  let docxBodyXml = `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="48"/></w:rPr><w:t>${safeTitle}</w:t></w:r></w:p>`;

  for (const para of paragraphs) {
    if (para.startsWith('# ')) {
      const heading = escapeXml(para.slice(2));
      docxBodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>${heading}</w:t></w:r></w:p>`;
    } else if (para.startsWith('## ')) {
      const heading = escapeXml(para.slice(3));
      docxBodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>${heading}</w:t></w:r></w:p>`;
    } else if (para.startsWith('### ')) {
      const heading = escapeXml(para.slice(4));
      docxBodyXml += `<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>${heading}</w:t></w:r></w:p>`;
    } else {
      const text = escapeXml(para.replace(/\*\*(.*?)\*\*/g, '$1'));
      docxBodyXml += `<w:p><w:r><w:sz w:val="22"/><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
    }
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${docxBodyXml}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/><w:color w:val="222222"/></w:rPr></w:rDefault>
  </w:docDefaults>
</w:styles>`;

  return buildZipPackage([
    { path: '[Content_Types].xml', content: contentTypesXml },
    { path: '_rels/.rels', content: rootRelsXml },
    { path: 'word/_rels/document.xml.rels', content: wordRelsXml },
    { path: 'word/document.xml', content: documentXml },
    { path: 'word/styles.xml', content: stylesXml },
  ]);
}

/**
 * Generates a valid OpenXML (.xlsx) Excel Workbook archive.
 */
export function generateXlsxArchive(workbook: SpreadsheetWorkbook): Uint8Array {
  const sheet = workbook.sheets[0] || { name: 'Sheet1', cells: {} };
  const cells = sheet.cells || {};

  let sheetDataXml = '';
  // Group cells by row
  const rowMap = new Map<number, Array<{ coord: string; col: number; val: unknown }>>();

  for (const [coord, cell] of Object.entries(cells)) {
    const m = coord.match(/^([A-Z]+)([0-9]+)$/);
    if (m) {
      const colIndex = colLetterToIndex(m[1]);
      const rowIndex = parseInt(m[2], 10);
      if (!rowMap.has(rowIndex)) rowMap.set(rowIndex, []);
      rowMap.get(rowIndex)!.push({
        coord,
        col: colIndex,
        val: cell.computed !== undefined ? cell.computed : (cell.raw ?? ''),
      });
    }
  }

  const sortedRows = Array.from(rowMap.keys()).sort((a, b) => a - b);
  for (const r of sortedRows) {
    sheetDataXml += `<row r="${r}">`;
    const rowCells = rowMap.get(r)!.sort((a, b) => a.col - b.col);
    for (const c of rowCells) {
      const val = c.val;
      if (typeof val === 'number') {
        sheetDataXml += `<c r="${c.coord}" t="n"><v>${val}</v></c>`;
      } else if (typeof val === 'boolean') {
        sheetDataXml += `<c r="${c.coord}" t="b"><v>${val ? 1 : 0}</v></c>`;
      } else {
        const text = escapeXml(String(val));
        sheetDataXml += `<c r="${c.coord}" t="inlineStr"><is><t>${text}</t></is></c>`;
      }
    }
    sheetDataXml += `</row>`;
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheet.name || 'Sheet1')}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    ${sheetDataXml}
  </sheetData>
</worksheet>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf/></cellStyleXfs>
  <cellXfs count="1"><xf/></cellXfs>
</styleSheet>`;

  return buildZipPackage([
    { path: '[Content_Types].xml', content: contentTypesXml },
    { path: '_rels/.rels', content: rootRelsXml },
    { path: 'xl/_rels/workbook.xml.rels', content: workbookRelsXml },
    { path: 'xl/workbook.xml', content: workbookXml },
    { path: 'xl/worksheets/sheet1.xml', content: worksheetXml },
    { path: 'xl/styles.xml', content: stylesXml },
  ]);
}

/**
 * Generates a valid OpenXML (.pptx) PowerPoint Presentation archive.
 */
export function generatePptxArchive(deck: PresentationDeck): Uint8Array {
  const slideEntries: Array<{ path: string; content: string }> = [];
  const slideRels: string[] = [];

  for (let i = 0; i < deck.slides.length; i++) {
    const slide = deck.slides[i];
    const slideIndex = i + 1;
    const safeTitle = escapeXml(slide.title);
    const safeSubtitle = escapeXml(slide.subtitle || '');

    let bulletsXml = '';
    for (const b of slide.bullets || []) {
      bulletsXml += `<a:p><a:pPr lvl="0"/><a:r><a:rPr sz="1800"/><a:t>${escapeXml(b)}</a:t></a:r></a:p>`;
    }

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr/>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="609600"/><a:ext cx="7772400" cy="1143000"/></a:xfrm></p:spPr>
        <p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="3200" b="1"/><a:t>${safeTitle}</a:t></a:r></a:p></p:txBody>
      </p:sp>
      <p:sp>
        <p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
        <p:spPr><a:xfrm><a:off x="685800" y="1981200"/><a:ext cx="7772400" cy="4114800"/></a:xfrm></p:spPr>
        <p:txBody>
          <a:bodyPr/>
          ${safeSubtitle ? `<a:p><a:r><a:rPr sz="2000" i="1"/><a:t>${safeSubtitle}</a:t></a:r></a:p>` : ''}
          ${bulletsXml}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    slideEntries.push({ path: `ppt/slides/slide${slideIndex}.xml`, content: slideXml });
    slideRels.push(`<Relationship Id="rId${slideIndex + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${slideIndex}.xml"/>`);
  }

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('\n  ')}
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

  const presentationRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slideRels.join('\n  ')}
</Relationships>`;

  const presentationXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    ${deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('\n    ')}
  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500"/>
</p:presentation>`;

  return buildZipPackage([
    { path: '[Content_Types].xml', content: contentTypesXml },
    { path: '_rels/.rels', content: rootRelsXml },
    { path: 'ppt/_rels/presentation.xml.rels', content: presentationRelsXml },
    { path: 'ppt/presentation.xml', content: presentationXml },
    ...slideEntries,
  ]);
}

/**
 * Generates a valid PDF 1.4 binary document from title and markdown/plain text content.
 * Follows ISO 32000-1 / PDF 1.4 specification with binary comments, cross-reference table,
 * catalog dictionary, pages tree, and standard font resources without external dependencies.
 */
export function generatePdfArchive(title: string, markdownOrText: string): Uint8Array {
  const encoder = new TextEncoder();
  const escapePdfText = (text: string): string => {
    return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  };

  const paragraphs = markdownOrText
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // PDF Content Stream construction
  let contentStream = 'BT\n';
  // Title in bold font /F2, size 18
  contentStream += '/F2 18 Tf\n72 720 Td\n(' + escapePdfText(title) + ') Tj\n';

  let currentY = 720;
  for (const para of paragraphs) {
    if (currentY < 100) break; // stay within single page bounds
    if (para.startsWith('# ')) {
      currentY -= 32;
      contentStream += `0 -32 Td\n/F2 14 Tf\n(${escapePdfText(para.slice(2))}) Tj\n`;
    } else if (para.startsWith('## ') || para.startsWith('### ')) {
      currentY -= 26;
      const heading = para.replace(/^#{2,3}\s+/, '');
      contentStream += `0 -26 Td\n/F2 12 Tf\n(${escapePdfText(heading)}) Tj\n`;
    } else {
      const cleanPara = para.replace(/\*\*(.*?)\*\*/g, '$1');
      const words = cleanPara.split(/\s+/);
      let curLine = '';
      for (const w of words) {
        if ((curLine + ' ' + w).trim().length > 75) {
          currentY -= 16;
          contentStream += `0 -16 Td\n/F1 10 Tf\n(${escapePdfText(curLine.trim())}) Tj\n`;
          curLine = w;
        } else {
          curLine = (curLine + ' ' + w).trim();
        }
      }
      if (curLine) {
        currentY -= 16;
        contentStream += `0 -16 Td\n/F1 10 Tf\n(${escapePdfText(curLine.trim())}) Tj\n`;
      }
      currentY -= 10;
      contentStream += '0 -10 Td\n';
    }
  }
  contentStream += 'ET\n';

  const streamBytes = encoder.encode(contentStream);

  // Objects:
  // 1: Catalog
  // 2: Pages
  // 3: Page
  // 4: Contents stream
  // 5: Font F1 (Helvetica)
  // 6: Font F2 (Helvetica-Bold)

  let pdfStr = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [0];

  offsets.push(encoder.encode(pdfStr).length);
  pdfStr += '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';

  offsets.push(encoder.encode(pdfStr).length);
  pdfStr += '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n';

  offsets.push(encoder.encode(pdfStr).length);
  pdfStr += '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>\nendobj\n';

  offsets.push(encoder.encode(pdfStr).length);
  pdfStr += `4 0 obj\n<< /Length ${streamBytes.length} >>\nstream\n${contentStream}endstream\nendobj\n`;

  offsets.push(encoder.encode(pdfStr).length);
  pdfStr += '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n';

  offsets.push(encoder.encode(pdfStr).length);
  pdfStr += '6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n';

  const startXref = encoder.encode(pdfStr).length;
  pdfStr += 'xref\n0 7\n0000000000 65535 f \n';
  for (let i = 1; i <= 6; i++) {
    const off = String(offsets[i]).padStart(10, '0');
    pdfStr += `${off} 00000 n \n`;
  }

  pdfStr += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return encoder.encode(pdfStr);
}

