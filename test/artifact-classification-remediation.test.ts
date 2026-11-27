import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyResponseArtifacts,
} from '../packages/agent-runtime/src/artifact-classifier.js';
import {
  normalizeArtifactOpenPayload,
} from '../src/utils/aiEngine.js';
import {
  isArtifactTypePreviewable,
} from '../src/utils/artifactClassification.js';

describe('Section 6 — Code and Artifact Classification Remediation (TDD)', () => {
  it('1. keeps ordinary TypeScript, Python, SQL, JSON, Shell, and mixed prose+code responses as chat Markdown (no Generated Analysis Artifact)', () => {
    const samples = [
      {
        prompt: 'Write a TypeScript debounce function and explain how it works.',
        content: 'Here is a generic TypeScript debounce helper:\n\n```typescript\nexport function debounce<T extends (...args: any[]) => void>(fn: T, ms: number) {\n  let timer: ReturnType<typeof setTimeout>;\n  return (...args: Parameters<T>) => {\n    clearTimeout(timer);\n    timer = setTimeout(() => fn(...args), ms);\n  };\n}\n```\n\nIt uses `clearTimeout` to reset the timer.',
      },
      {
        prompt: 'Show a Python binary search implementation.',
        content: 'Below is binary search in Python:\n\n```python\ndef binary_search(arr, target):\n    lo, hi = 0, len(arr) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if arr[mid] == target:\n            return mid\n    return -1\n```',
      },
      {
        prompt: 'Give me a SQL query for top 5 customers.',
        content: 'Use a simple aggregation:\n\n```sql\nSELECT customer_id, SUM(amount) AS total FROM invoices GROUP BY 1 ORDER BY 2 DESC LIMIT 5;\n```',
      },
      {
        prompt: 'Return a sample package config JSON.',
        content: 'Sample JSON:\n\n```json\n{\n  "name": "aira-sample",\n  "private": true\n}\n```',
      },
      {
        prompt: 'How do I check git status and commit?',
        content: 'Run:\n\n```bash\ngit status --short\ngit commit -m "chore: update"\n```',
      },
      {
        prompt: 'Explain inline code vs Markdown.',
        content: 'Use `const x = 1` inline or Markdown formatting:\n\n```markdown\n# Title\n- bullet 1\n```',
      },
    ];

    for (const s of samples) {
      const result = classifyResponseArtifacts({
        content: s.content,
        prompt: s.prompt,
      });
      assert.equal(result.artifacts.length, 0, `Ordinary snippet must not become artifact: ${s.prompt}`);
    }
  });

  it('2. extracts explicit <airaArtifact>/<antArtifact> envelopes accurately without prose pollution', () => {
    const raw = `Here is your Python script:\n<airaArtifact identifier="py_etl" type="application/vnd.ant.code" language="python" title="ETL Script">\nprint("hello")\n</airaArtifact>`;
    const result = classifyResponseArtifacts({
      content: raw,
      prompt: 'Create a Python ETL file artifact',
    });
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].id, 'py_etl');
    assert.equal(result.artifacts[0].type, 'application/vnd.ant.code');
    assert.equal(result.artifacts[0].language, 'python');
    assert.equal(result.artifacts[0].content.trim(), 'print("hello")');
  });

  it('3. distinguishes executable HTML apps, standalone SVG diagrams, and explicit editable Markdown artifacts when requested', () => {
    const htmlApp = classifyResponseArtifacts({
      content: 'Here is the app:\n\n```html\n<!DOCTYPE html><html><body><button onclick="alert(1)">Go</button></body></html>\n```',
      prompt: 'Create an interactive HTML counter app',
    });
    assert.equal(htmlApp.artifacts.length, 1);
    assert.equal(htmlApp.artifacts[0].type, 'text/html');
    assert.equal(htmlApp.artifacts[0].language, 'html');
    assert.ok(!htmlApp.artifacts[0].content.includes('Here is the app:'));

    const svgDiagram = classifyResponseArtifacts({
      content: 'Diagram:\n\n```svg\n<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20"/></svg>\n```',
      prompt: 'Create an SVG diagram of a circle',
    });
    assert.equal(svgDiagram.artifacts.length, 1);
    assert.equal(svgDiagram.artifacts[0].type, 'image/svg+xml');
    assert.equal(svgDiagram.artifacts[0].language, 'svg');

    const editableDoc = classifyResponseArtifacts({
      content: '# API Rate Limiter Spec\n\n## Limits\n- 60 req/min\n',
      prompt: 'Draft an editable markdown specification document for an API rate limiter',
    });
    assert.equal(editableDoc.artifacts.length, 1);
    assert.equal(editableDoc.artifacts[0].type, 'text/markdown');
    assert.equal(editableDoc.artifacts[0].language, 'markdown');
  });

  it('4. never defaults unknown code artifacts to executable HTML language on SSE artifact_open', () => {
    const codeOpen = normalizeArtifactOpenPayload({
      title: 'Utility Script',
      type: 'application/vnd.ant.code',
    });
    assert.equal(codeOpen.type, 'application/vnd.ant.code');
    assert.notEqual(codeOpen.language, 'html');
    assert.equal(codeOpen.language, 'text');

    const unknownOpen = normalizeArtifactOpenPayload({
      title: 'Mystery Payload',
    });
    assert.equal(unknownOpen.type, 'application/vnd.ant.code');
    assert.notEqual(unknownOpen.language, 'html');

    const explicitHtml = normalizeArtifactOpenPayload({
      title: 'Interactive App',
      type: 'text/html',
    });
    assert.equal(explicitHtml.type, 'text/html');
    assert.equal(explicitHtml.language, 'html');
  });

  it('5. marks generic application/vnd.ant.code non-previewable in UnifiedWorkspace / Studio', () => {
    assert.equal(isArtifactTypePreviewable('application/vnd.ant.code'), false);
    assert.equal(isArtifactTypePreviewable('text/html'), true);
    assert.equal(isArtifactTypePreviewable('image/svg+xml'), true);
    assert.equal(isArtifactTypePreviewable('text/markdown'), true);
    assert.equal(isArtifactTypePreviewable('application/vnd.ant.mermaid'), true);
  });
});
