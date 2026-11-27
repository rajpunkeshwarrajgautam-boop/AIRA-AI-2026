import { z } from 'zod';

export const AIRA_ARTIFACT_CONTRACT_VERSION = 'aira-artifact/v1' as const;

export const ArtifactClassSchema = z.enum([
  'document',
  'code',
  'sheet',
  'slide',
  'diagram',
  'surface',
  'app',
  'mcp-app',
]);
export type ArtifactClass = z.infer<typeof ArtifactClassSchema>;

export const ExportFormatSchema = z.enum([
  'txt',
  'markdown',
  'html',
  'json',
  'csv',
  'docx',
  'pdf',
  'xlsx',
  'pptx',
  'svg',
  'png',
  'zip',
]);
export type ExportFormat = z.infer<typeof ExportFormatSchema>;

// Spreadsheet schemas
export const SpreadsheetCellSchema = z.object({
  raw: z.string(),
  computed: z.union([z.string(), z.number(), z.boolean()]),
  format: z.string().optional(),
});
export type SpreadsheetCell = z.infer<typeof SpreadsheetCellSchema>;

export const SpreadsheetWorksheetSchema = z.object({
  name: z.string().min(1).max(64),
  rowCount: z.number().int().min(1).max(1000).default(20),
  colCount: z.number().int().min(1).max(52).default(10),
  cells: z.record(z.string(), SpreadsheetCellSchema).default({}),
});
export type SpreadsheetWorksheet = z.infer<typeof SpreadsheetWorksheetSchema>;

export const SpreadsheetWorkbookSchema = z.object({
  activeSheet: z.string().default('Sheet1'),
  sheets: z.array(SpreadsheetWorksheetSchema).min(1),
});
export type SpreadsheetWorkbook = z.infer<typeof SpreadsheetWorkbookSchema>;

// Presentation schemas
export const SlideLayoutSchema = z.enum([
  'title-slide',
  'content',
  'split',
  'stats',
  'quote',
]);
export type SlideLayout = z.infer<typeof SlideLayoutSchema>;

export const SlideMetricSchema = z.object({
  label: z.string(),
  value: z.string(),
  change: z.string().optional(),
});
export type SlideMetric = z.infer<typeof SlideMetricSchema>;

export const SlideSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  subtitle: z.string().optional(),
  layout: SlideLayoutSchema.default('content'),
  bullets: z.array(z.string()).default([]),
  metrics: z.array(SlideMetricSchema).optional(),
  notes: z.string().optional(),
});
export type Slide = z.infer<typeof SlideSchema>;

export const PresentationDeckSchema = z.object({
  title: z.string().min(1).max(200),
  theme: z.enum(['default', 'dark', 'executive', 'creative']).default('default'),
  slides: z.array(SlideSchema).min(1),
});
export type PresentationDeck = z.infer<typeof PresentationDeckSchema>;

// Diagram schemas
export const DiagramTypeSchema = z.enum([
  'flowchart',
  'sequence',
  'class',
  'architecture',
  'general',
]);
export type DiagramType = z.infer<typeof DiagramTypeSchema>;

// Artifact descriptor schema
export const AiraArtifactCapabilitiesSchema = z.object({
  editable: z.boolean().default(true),
  previewable: z.boolean().default(true),
  executable: z.boolean().default(false),
  exportFormats: z.array(ExportFormatSchema).default([]),
});
export type AiraArtifactCapabilities = z.infer<typeof AiraArtifactCapabilitiesSchema>;

export const AiraArtifactDescriptorSchema = z.object({
  schemaVersion: z.literal(AIRA_ARTIFACT_CONTRACT_VERSION),
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  artifactClass: ArtifactClassSchema,
  mimeType: z.string().min(1).max(128),
  content: z.string().max(2 * 1024 * 1024), // 2MB cap
  version: z.number().int().min(1).default(1),
  capabilities: AiraArtifactCapabilitiesSchema.default({
    editable: true,
    previewable: true,
    executable: false,
    exportFormats: [],
  }),
});
export type AiraArtifactDescriptor = z.infer<typeof AiraArtifactDescriptorSchema>;

export function validateAiraArtifactDescriptor(
  raw: unknown
): { ok: true; artifact: AiraArtifactDescriptor } | { ok: false; error: string } {
  const result = AiraArtifactDescriptorSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `Artifact descriptor validation failed: ${issue.path.join('.')} - ${issue.message}`,
    };
  }
  return { ok: true, artifact: result.data };
}

// Artifact patch schema
export const ArtifactPatchTypeSchema = z.enum([
  'replace_section',
  'update_cells',
  'update_slide',
  'insert_slide',
  'replace_file',
  'replace_all',
]);
export type ArtifactPatchType = z.infer<typeof ArtifactPatchTypeSchema>;

export const ArtifactPatchSchema = z.object({
  targetId: z.string().min(1),
  baseVersion: z.number().int().min(1),
  patchType: ArtifactPatchTypeSchema,
  sectionTitle: z.string().optional(),
  content: z.string().optional(),
  payload: z.unknown().optional(),
});
export type ArtifactPatch = z.infer<typeof ArtifactPatchSchema>;
