import assert from 'node:assert/strict';
import test from 'node:test';

// Contracts
import {
  AIRA_ARTIFACT_CONTRACT_VERSION,
  AiraArtifactDescriptorSchema,
  validateAiraArtifactDescriptor,
  SpreadsheetWorkbookSchema,
  PresentationDeckSchema,
  ArtifactPatchSchema,
  type SpreadsheetWorkbook,
  type PresentationDeck,
} from '../packages/contracts/src/artifacts.js';

// Engines
import {
  evaluateSpreadsheetCell,
  recalculateSpreadsheet,
  sanitizeSpreadsheetCsvCell,
  exportSpreadsheetToCsv,
} from '../src/utils/spreadsheetEngine.js';

import {
  createDefaultPresentationDeck,
  addSlideToDeck,
  reorderDeckSlides,
  updateDeckSlide,
  type Slide,
} from '../src/utils/presentationEngine.js';

import {
  renderDiagramToSvg,
  detectDiagramType,
} from '../src/utils/diagramRenderer.js';

import {
  generateDocxArchive,
  generateXlsxArchive,
  generatePptxArchive,
  generatePdfArchive,
} from '../src/utils/officeDocumentExporter.js';

import {
  applyArtifactPatch,
  type ArtifactPatch,
} from '../src/utils/artifactPatchEngine.js';

test('AIRA Multimodal Artifact Suite — Phase 4B', async (t) => {
  await t.test('1. Contract & Schema Validation (aira-artifact/v1)', () => {
    assert.equal(AIRA_ARTIFACT_CONTRACT_VERSION, 'aira-artifact/v1');

    const validSheetArtifact = {
      schemaVersion: 'aira-artifact/v1',
      id: 'art-sheet-1',
      title: 'Q4 Financial Model',
      artifactClass: 'sheet',
      mimeType: 'application/vnd.aira.sheet',
      content: '{"activeSheet":"Sheet1","sheets":[{"name":"Sheet1","cells":{}}]}',
      version: 1,
      capabilities: {
        editable: true,
        previewable: true,
        executable: false,
        exportFormats: ['csv', 'xlsx', 'json'],
      },
    };

    const res = validateAiraArtifactDescriptor(validSheetArtifact);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.artifact.artifactClass, 'sheet');
      assert.equal(res.artifact.capabilities.exportFormats.includes('xlsx'), true);
    }

    const invalidArtifact = {
      schemaVersion: 'invalid/version',
      id: 'bad-1',
      title: 'Bad',
      artifactClass: 'unknown_class',
    };
    const invalidRes = validateAiraArtifactDescriptor(invalidArtifact);
    assert.equal(invalidRes.ok, false);
  });

  await t.test('2. Spreadsheet Engine — Formula Calculation & Recalculation', () => {
    const workbook: SpreadsheetWorkbook = {
      activeSheet: 'Budget',
      sheets: [
        {
          name: 'Budget',
          rowCount: 20,
          colCount: 10,
          cells: {
            A1: { raw: '100', computed: 100 },
            A2: { raw: '250', computed: 250 },
            A3: { raw: '=A1+A2', computed: 0 },
            A4: { raw: '=SUM(A1:A2)', computed: 0 },
            A5: { raw: '=AVERAGE(A1:A2)', computed: 0 },
            A6: { raw: '=MAX(A1:A2)', computed: 0 },
            A7: { raw: '=MIN(A1:A2)', computed: 0 },
            A8: { raw: '=IF(A1>50, "Profitable", "Deficit")', computed: '' },
          },
        },
      ],
    };

    const recalculated = recalculateSpreadsheet(workbook);
    const sheet = recalculated.sheets[0];

    assert.equal(sheet.cells.A3?.computed, 350);
    assert.equal(sheet.cells.A4?.computed, 350);
    assert.equal(sheet.cells.A5?.computed, 175);
    assert.equal(sheet.cells.A6?.computed, 250);
    assert.equal(sheet.cells.A7?.computed, 100);
    assert.equal(sheet.cells.A8?.computed, 'Profitable');
  });

  await t.test('3. Spreadsheet Engine — Cycle & Division by Zero Detection', () => {
    const cyclicWorkbook: SpreadsheetWorkbook = {
      activeSheet: 'CycleSheet',
      sheets: [
        {
          name: 'CycleSheet',
          rowCount: 5,
          colCount: 5,
          cells: {
            A1: { raw: '=B1+1', computed: 0 },
            B1: { raw: '=A1+1', computed: 0 },
            C1: { raw: '=10/0', computed: 0 },
          },
        },
      ],
    };

    const res = recalculateSpreadsheet(cyclicWorkbook);
    const sheet = res.sheets[0];

    assert.equal(sheet.cells.A1?.computed, '#CYCLE!');
    assert.equal(sheet.cells.B1?.computed, '#CYCLE!');
    assert.equal(sheet.cells.C1?.computed, '#DIV/0!');
  });

  await t.test('4. Spreadsheet Engine — CSV Formula Injection Defense', () => {
    assert.equal(sanitizeSpreadsheetCsvCell('=cmd|\' /C calc\'!A0'), '\'=cmd|\' /C calc\'!A0');
    assert.equal(sanitizeSpreadsheetCsvCell('+12345'), '\'+12345');
    assert.equal(sanitizeSpreadsheetCsvCell('-999'), '\'-999');
    assert.equal(sanitizeSpreadsheetCsvCell('@SUM(1,2)'), '"\'@SUM(1,2)"');
    assert.equal(sanitizeSpreadsheetCsvCell('Normal Text'), 'Normal Text');
    assert.equal(sanitizeSpreadsheetCsvCell(42), '42');

    const workbook: SpreadsheetWorkbook = {
      activeSheet: 'S1',
      sheets: [
        {
          name: 'S1',
          rowCount: 2,
          colCount: 2,
          cells: {
            A1: { raw: 'User', computed: 'User' },
            B1: { raw: 'Action', computed: 'Action' },
            A2: { raw: 'Alice', computed: 'Alice' },
            B2: { raw: '=DDE("server")', computed: '=DDE("server")' },
          },
        },
      ],
    };

    const csv = exportSpreadsheetToCsv(workbook, 'S1');
    assert.match(csv, /'=\b/);
    assert.doesNotMatch(csv, /(^|,)=DDE/);
  });

  await t.test('5. Presentation Engine — Slide Deck Management', () => {
    const deck = createDefaultPresentationDeck('AIRA GenUI Strategy');
    assert.equal(deck.title, 'AIRA GenUI Strategy');
    assert.equal(deck.slides.length >= 1, true);

    const newSlide: Slide = {
      id: 'slide-arch-2',
      title: 'Multimodal Architecture',
      layout: 'split',
      bullets: ['Unified canvas', 'Zero CDN diagrams', 'Native office exports'],
      notes: 'Highlight isolation boundary.',
    };

    const updated = addSlideToDeck(deck, newSlide);
    assert.equal(updated.slides.length, deck.slides.length + 1);

    // Reorder slides
    const reordered = reorderDeckSlides(updated, 0, 1);
    assert.equal(reordered.slides[1]?.title, deck.slides[0]?.title);

    // Update slide content
    const modified = updateDeckSlide(reordered, 'slide-arch-2', {
      title: 'Updated Multimodal Architecture',
    });
    const found = modified.slides.find((s) => s.id === 'slide-arch-2');
    assert.equal(found?.title, 'Updated Multimodal Architecture');
  });

  await t.test('6. Diagram Engine — Declarative SVG Rendering', () => {
    const flowchartSource = `
graph TD
  A[Client Request] --> B[ModelRouter]
  B --> C[PresentationRouter]
  C --> D[ArtifactStudio]
`;
    assert.equal(detectDiagramType(flowchartSource), 'flowchart');

    const svg = renderDiagramToSvg(flowchartSource);
    assert.equal(svg.startsWith('<svg'), true);
    assert.equal(svg.endsWith('</svg>'), true);
    assert.equal(svg.includes('ModelRouter'), true);
    assert.equal(svg.includes('PresentationRouter'), true);
    assert.equal(svg.includes('<script>'), false, 'SVG must not contain scripts');

    // Resilience on malformed diagram source
    const fallbackSvg = renderDiagramToSvg('invalid diagram markup here without nodes');
    assert.equal(fallbackSvg.startsWith('<svg'), true);
    assert.equal(fallbackSvg.includes('Diagram Preview'), true);
  });

  await t.test('7. Office Document Exporter — True OpenXML PKZip Packages', () => {
    // 1. DOCX
    const docxBuf = generateDocxArchive('AIRA Architecture Brief', '# Overview\n\nThis is a certified brief with **bold** text.');
    assert.equal(docxBuf instanceof Uint8Array, true);
    assert.equal(docxBuf.length > 500, true);
    assert.equal(docxBuf[0], 0x50, 'Must have PKZip signature byte 0');
    assert.equal(docxBuf[1], 0x4b, 'Must have PKZip signature byte 1');

    // 2. XLSX
    const sheetData: SpreadsheetWorkbook = {
      activeSheet: 'Q4',
      sheets: [
        {
          name: 'Q4',
          rowCount: 3,
          colCount: 3,
          cells: {
            A1: { raw: 'Revenue', computed: 'Revenue' },
            B1: { raw: '1000', computed: 1000 },
            A2: { raw: 'Expenses', computed: 'Expenses' },
            B2: { raw: '400', computed: 400 },
          },
        },
      ],
    };
    const xlsxBuf = generateXlsxArchive(sheetData);
    assert.equal(xlsxBuf instanceof Uint8Array, true);
    assert.equal(xlsxBuf.length > 500, true);
    assert.equal(xlsxBuf[0], 0x50);
    assert.equal(xlsxBuf[1], 0x4b);

    // 3. PPTX
    const deck = createDefaultPresentationDeck('Executive Review');
    const pptxBuf = generatePptxArchive(deck);
    assert.equal(pptxBuf instanceof Uint8Array, true);
    assert.equal(pptxBuf.length > 500, true);
    assert.equal(pptxBuf[0], 0x50);
    assert.equal(pptxBuf[1], 0x4b);

    // 4. PDF (Phase 4B targeted closure)
    const pdfBuf = generatePdfArchive('Strategic Overview', '# Executive Summary\n\nRevenue grew by 25% year-over-year.');
    assert.equal(pdfBuf instanceof Uint8Array, true);
    assert.equal(pdfBuf.length > 300, true);
    const pdfText = new TextDecoder().decode(pdfBuf);
    assert.equal(pdfText.startsWith('%PDF-1.4'), true, 'PDF must start with %PDF-1.4 header');
    assert.equal(pdfText.includes('%%EOF'), true, 'PDF must terminate with %%EOF marker');
    assert.equal(pdfText.includes('xref'), true, 'PDF must include xref table');
    assert.equal(pdfText.includes('/Type /Catalog'), true, 'PDF must include Catalog dictionary');
    assert.equal(pdfText.includes('(Strategic Overview) Tj'), true, 'PDF must include title in text stream');
  });

  await t.test('8. Artifact Patch & Conflict Engine', () => {
    const initialArtifact = {
      id: 'art-doc-1',
      title: 'System ADR',
      type: 'text/markdown',
      content: '# Section 1\nContent A\n\n# Section 2\nContent B',
      version: 1,
      versions: [{ version: 1, content: '# Section 1\nContent A\n\n# Section 2\nContent B', timestamp: Date.now() }],
    };

    // Valid patch application
    const validPatch: ArtifactPatch = {
      targetId: 'art-doc-1',
      baseVersion: 1,
      patchType: 'replace_section',
      sectionTitle: 'Section 2',
      content: 'Updated Content B with security invariants.',
    };

    const patched = applyArtifactPatch(initialArtifact, validPatch);
    assert.equal(patched.ok, true);
    if (patched.ok) {
      assert.equal(patched.artifact.version, 2);
      assert.equal(patched.artifact.content.includes('Updated Content B with security invariants.'), true);
      assert.equal(patched.artifact.content.includes('# Section 1\nContent A'), true);
    }

    // Stale version conflict detection
    const stalePatch: ArtifactPatch = {
      targetId: 'art-doc-1',
      baseVersion: 1, // Current is 2!
      patchType: 'replace_section',
      sectionTitle: 'Section 1',
      content: 'Stale update',
    };

    if (patched.ok) {
      const conflictRes = applyArtifactPatch(patched.artifact, stalePatch);
      assert.equal(conflictRes.ok, false);
      if (!conflictRes.ok) {
        assert.equal(conflictRes.code, 'STALE_BASE_VERSION');
      }
    }
  });
});
