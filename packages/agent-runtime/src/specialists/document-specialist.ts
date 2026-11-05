import {
  SpecialistRole,
  CapabilityCategory
} from '../../../contracts/src/index.js';
import {
  BaseSpecialistAgent,
  SpecialistExecutionContext,
  SpecialistExecutionResult
} from './specialist-interface.js';

export class DocumentSpecialistAgent extends BaseSpecialistAgent {
  public readonly role: SpecialistRole = 'document';
  public readonly name = 'Document Specialist';
  public readonly description = 'Formats executive summaries, reports, technical specifications, and structured markdown deliverables.';
  public readonly requiredCapabilities: readonly CapabilityCategory[] = Object.freeze([
    'document_intelligence'
  ]);

  protected async performExecution(
    context: SpecialistExecutionContext,
    startedAt: number
  ): Promise<SpecialistExecutionResult> {
    const rawPayload = context.inputPayload || {};
    const title = typeof rawPayload.title === 'string' ? rawPayload.title : 'AIRA Executive Deliverable';
    const sections = Array.isArray(rawPayload.sections) ? rawPayload.sections : [];
    const rawContent = typeof rawPayload.content === 'string' ? rawPayload.content : '';

    let markdown = `# ${title}\n\n`;
    if (rawContent) {
      markdown += `${rawContent}\n\n`;
    }
    if (sections.length > 0) {
      for (const sec of sections) {
        markdown += `## ${sec.heading || 'Section'}\n${sec.body || ''}\n\n`;
      }
    }
    markdown += `\n---\n*Authored by AIRA Document Specialist — Execution ID: ${context.taskId}*`;

    const durationMs = Math.max(1, Date.now() - startedAt);

    return this.buildResult(
      context,
      'COMPLETED',
      {
        title,
        documentType: 'markdown',
        renderedDocument: markdown,
        wordCount: markdown.split(/\s+/).length
      },
      startedAt,
      undefined,
      {
        tokensUsed: 35,
        durationMs
      }
    );
  }
}
