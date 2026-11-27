import type { DiagramType } from '../../packages/contracts/src/artifacts.js';

export function detectDiagramType(source: string): DiagramType {
  const clean = source.trim().toLowerCase();
  if (clean.startsWith('graph') || clean.startsWith('flowchart')) return 'flowchart';
  if (clean.startsWith('sequencediagram')) return 'sequence';
  if (clean.startsWith('classdiagram')) return 'class';
  if (clean.startsWith('architecture') || clean.includes('boundary')) return 'architecture';
  return 'general';
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface DiagramNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

/**
 * Pure TypeScript declarative diagram to SVG renderer.
 * Safely parses flowcharts, sequence, and architecture diagrams without external CDNs or unsafe eval.
 */
export function renderDiagramToSvg(
  source: string,
  options: { width?: number; height?: number; isDark?: boolean } = {}
): string {
  const isDark = Boolean(options.isDark);
  const bgColor = isDark ? '#1E1E1E' : '#FFFFFF';
  const textColor = isDark ? '#F3F4F6' : '#1F2937';
  const nodeBg = isDark ? '#2D3748' : '#F9FAFB';
  const nodeBorder = isDark ? '#4B5563' : '#D1D5DB';
  const arrowColor = isDark ? '#9CA3AF' : '#6B7280';
  const accentColor = '#B54A2B';

  const lines = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('%%'));

  const nodes: Map<string, DiagramNode> = new Map();
  const edges: DiagramEdge[] = [];

  // Parse lines matching A[Label] --> B[Label] or A --> B
  const arrowRegex = /([a-zA-Z0-9_-]+)(?:\[([^\]]+)\])?\s*(-->|->|==>)\s*([a-zA-Z0-9_-]+)(?:\[([^\]]+)\])?/;

  for (const line of lines) {
    const match = line.match(arrowRegex);
    if (match) {
      const fromId = match[1];
      const fromLabel = match[2] || fromId;
      const toId = match[4];
      const toLabel = match[5] || toId;

      if (!nodes.has(fromId)) {
        nodes.set(fromId, {
          id: fromId,
          label: fromLabel,
          x: 0,
          y: 0,
          width: 140,
          height: 48,
        });
      }
      if (!nodes.has(toId)) {
        nodes.set(toId, {
          id: toId,
          label: toLabel,
          x: 0,
          y: 0,
          width: 140,
          height: 48,
        });
      }

      edges.push({ from: fromId, to: toId });
    } else {
      // Standalone node: A[Label]
      const nodeMatch = line.match(/^([a-zA-Z0-9_-]+)\[([^\]]+)\]$/);
      if (nodeMatch) {
        const id = nodeMatch[1];
        const label = nodeMatch[2];
        if (!nodes.has(id)) {
          nodes.set(id, {
            id,
            label,
            x: 0,
            y: 0,
            width: 140,
            height: 48,
          });
        }
      }
    }
  }

  // Fallback if no structured nodes were parsed
  if (nodes.size === 0) {
    const fallbackTitle = escapeXml(lines[0] ? `Diagram Preview: ${lines[0]}` : 'Diagram Preview');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 240" width="100%" height="100%" style="background:${bgColor};font-family:system-ui,-apple-system,sans-serif;">
  <rect width="600" height="240" fill="${bgColor}" rx="8"/>
  <rect x="80" y="80" width="440" height="80" rx="8" fill="${nodeBg}" stroke="${nodeBorder}" stroke-width="2"/>
  <text x="300" y="125" text-anchor="middle" fill="${textColor}" font-size="14" font-weight="600">${fallbackTitle}</text>
</svg>`;
  }

  // Layout nodes vertically/horizontally
  const nodeList = Array.from(nodes.values());
  const nodeSpacingY = 80;
  const startX = 220;
  let currentY = 40;

  for (let i = 0; i < nodeList.length; i++) {
    const node = nodeList[i];
    node.x = startX;
    node.y = currentY;
    currentY += nodeSpacingY;
  }

  const svgWidth = 600;
  const svgHeight = Math.max(260, currentY + 40);

  // Render SVG elements
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" height="100%" style="background:${bgColor};font-family:system-ui,-apple-system,sans-serif;">
  <defs>
    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
      <polygon points="0 0, 10 3.5, 0 7" fill="${arrowColor}" />
    </marker>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.08"/>
    </filter>
  </defs>
  <rect width="${svgWidth}" height="${svgHeight}" fill="${bgColor}" rx="8"/>
`;

  // Draw Edges
  for (const edge of edges) {
    const fromNode = nodes.get(edge.from);
    const toNode = nodes.get(edge.to);
    if (!fromNode || !toNode) continue;

    const startX = fromNode.x + fromNode.width / 2;
    const startY = fromNode.y + fromNode.height;
    const endX = toNode.x + toNode.width / 2;
    const endY = toNode.y;

    svg += `  <path d="M ${startX} ${startY} L ${endX} ${endY}" stroke="${arrowColor}" stroke-width="2" marker-end="url(#arrowhead)" fill="none"/>\n`;
  }

  // Draw Nodes
  for (const node of nodeList) {
    const safeLabel = escapeXml(node.label);
    svg += `  <g filter="url(#shadow)">
    <rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" fill="${nodeBg}" stroke="${nodeBorder}" stroke-width="1.5"/>
    <rect x="${node.x}" y="${node.y}" width="4" height="${node.height}" rx="2" fill="${accentColor}"/>
    <text x="${node.x + node.width / 2 + 2}" y="${node.y + node.height / 2 + 5}" text-anchor="middle" fill="${textColor}" font-size="13" font-weight="500">${safeLabel}</text>
  </g>\n`;
  }

  svg += `</svg>`;
  return svg;
}
