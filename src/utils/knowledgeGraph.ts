/**
 * Knowledge Graph Engine for Aira Projects & Subgraph Context Retrieval
 * Standard: Agency Knowledge Graph Engineer
 * Purpose: Token cost reduction (<30% of corpus), provenance tracking, and contradiction management.
 */

export interface SourceNode {
  sha256: string;
  title: string;
  content: string;
  tokenCount: number;
  createdAt: number;
}

export interface EntityNode {
  id: string;
  name: string;
  type: 'component' | 'service' | 'constraint' | 'schema' | 'concept';
  confidence: number;
  summary: string;
  sourceCount: number;
  contested?: boolean;
  needsReview?: boolean;
}

export interface RelationshipEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: 'RELATES' | 'DEPENDS_ON' | 'ENFORCES' | 'DERIVED_FROM' | 'CONTRADICTS';
  claim: string;
  confidence: number;
  sourceSha: string;
}

export interface KnowledgeGraph {
  sources: Record<string, SourceNode>;
  entities: Record<string, EntityNode>;
  edges: RelationshipEdge[];
  metrics: {
    totalEntities: number;
    totalEdges: number;
    totalSources: number;
    contestedCount: number;
    estimatedTotalTokens: number;
  };
}

/**
 * Deterministic SHA-256 calculation using Web Crypto API
 */
export async function calculateSha256(text: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback simple 32-char hex hash
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(32, '0');
  }
}

/**
 * Fast rough token estimator (approx 4 chars per token)
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build property knowledge graph from project documents
 */
export async function buildKnowledgeGraphFromDocs(
  docs: Array<{ id: string; name: string; content: string }>
): Promise<KnowledgeGraph> {
  const sources: Record<string, SourceNode> = {};
  const entities: Record<string, EntityNode> = {};
  const edges: RelationshipEdge[] = [];
  let estimatedTotalTokens = 0;

  for (const doc of docs) {
    const sha = await calculateSha256(doc.content);
    const tokenCount = estimateTokens(doc.content);
    estimatedTotalTokens += tokenCount;

    sources[sha] = {
      sha256: sha,
      title: doc.name,
      content: doc.content,
      tokenCount,
      createdAt: Date.now(),
    };

    // Extract sentences & structural definitions
    const lines = doc.content.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.length < 10) continue;

      // Rule extraction: words formatted as TitleCase or Key: Value or Component/Service names
      const matchDefinition = line.match(/^[-*]?\s*([A-Za-z0-9_\-\s]{3,30}):\s*(.+)/);
      if (matchDefinition) {
        const entityName = matchDefinition[1].trim();
        const claim = matchDefinition[2].trim();
        const entityId = entityName.toLowerCase().replace(/[^a-z0-9]/g, '_');

        if (!entities[entityId]) {
          entities[entityId] = {
            id: entityId,
            name: entityName,
            type: entityName.toLowerCase().includes('service') || entityName.toLowerCase().includes('api')
              ? 'service'
              : entityName.toLowerCase().includes('rule') || entityName.toLowerCase().includes('policy')
              ? 'constraint'
              : 'component',
            confidence: 0.95,
            summary: claim.slice(0, 140),
            sourceCount: 1,
            contested: false,
          };
        } else {
          entities[entityId].sourceCount += 1;
          // Check for contradictions
          if (entities[entityId].summary !== claim.slice(0, 140)) {
            // Contradiction detected
            entities[entityId].contested = true;
            edges.push({
              id: `contradict-${entityId}-${Date.now()}`,
              sourceId: entityId,
              targetId: entityId,
              type: 'CONTRADICTS',
              claim: `Conflict detected between sources: "${entities[entityId].summary}" vs "${claim.slice(0, 140)}"`,
              confidence: 0.9,
              sourceSha: sha,
            });
          }
        }

        // Add Provenance edge
        edges.push({
          id: `derived-${entityId}-${sha.slice(0, 8)}`,
          sourceId: entityId,
          targetId: sha,
          type: 'DERIVED_FROM',
          claim: claim,
          confidence: 0.98,
          sourceSha: sha,
        });
      }
    }
  }

  // Interconnect entities by shared mentions
  const entityList = Object.values(entities);
  for (let i = 0; i < entityList.length; i++) {
    for (let j = i + 1; j < entityList.length; j++) {
      const a = entityList[i];
      const b = entityList[j];

      if (a.summary.toLowerCase().includes(b.name.toLowerCase())) {
        edges.push({
          id: `rel-${a.id}-${b.id}`,
          sourceId: a.id,
          targetId: b.id,
          type: 'RELATES',
          claim: `${a.name} references ${b.name}`,
          confidence: 0.85,
          sourceSha: 'structural',
        });
      }
    }
  }

  const contestedCount = entityList.filter(e => e.contested).length;

  return {
    sources,
    entities,
    edges,
    metrics: {
      totalEntities: entityList.length,
      totalEdges: edges.length,
      totalSources: Object.keys(sources).length,
      contestedCount,
      estimatedTotalTokens,
    }
  };
}

export interface SubgraphRetrievalResult {
  formattedContext: string;
  matchedEntities: EntityNode[];
  edgesTraversed: RelationshipEdge[];
  sourceTokensOriginal: number;
  subgraphTokensRetrieved: number;
  tokenSavingsPercent: number;
}

/**
 * Retrieve 1-to-2 hop relevant subgraph based on user query
 * Replaces monolithic 50k-token raw dumps with a concentrated 300-token semantic subgraph
 */
export function retrieveRelevantSubgraph(
  query: string,
  graph: KnowledgeGraph
): SubgraphRetrievalResult | null {
  const queryLower = query.toLowerCase();
  const matchedEntities: EntityNode[] = [];
  const matchedEntityIds = new Set<string>();

  // 1. Direct entity matches
  for (const entity of Object.values(graph.entities)) {
    if (queryLower.includes(entity.name.toLowerCase()) || queryLower.includes(entity.id)) {
      matchedEntities.push(entity);
      matchedEntityIds.add(entity.id);
    }
  }

  // If no direct entity matched, fall back to keyword match on summaries
  if (matchedEntities.length === 0) {
    const words = queryLower.split(/\s+/).filter(w => w.length > 3);
    for (const entity of Object.values(graph.entities)) {
      if (words.some(w => entity.summary.toLowerCase().includes(w))) {
        matchedEntities.push(entity);
        matchedEntityIds.add(entity.id);
        if (matchedEntities.length >= 3) break;
      }
    }
  }

  if (matchedEntities.length === 0) {
    return null;
  }

  // 2. 1-hop traversal across edges
  const edgesTraversed: RelationshipEdge[] = [];
  const neighborIds = new Set<string>();

  for (const edge of graph.edges) {
    if (matchedEntityIds.has(edge.sourceId) || matchedEntityIds.has(edge.targetId)) {
      edgesTraversed.push(edge);
      if (edge.sourceId !== edge.targetId) {
        if (!matchedEntityIds.has(edge.sourceId)) neighborIds.add(edge.sourceId);
        if (!matchedEntityIds.has(edge.targetId)) neighborIds.add(edge.targetId);
      }
    }
  }

  // 3. Format structured knowledge context
  const lines: string[] = [];
  lines.push('### Knowledge Graph Subgraph Context (Token Optimized)');
  lines.push(`Retrieved Entities: ${matchedEntities.length} | Relationships Traversed: ${edgesTraversed.length}`);
  lines.push('');

  lines.push('#### Entities & Claims:');
  for (const ent of matchedEntities) {
    const status = ent.contested ? ' [⚠️ CONTESTED CLAIM]' : '';
    lines.push(`- **${ent.name}** (${ent.type})${status}: ${ent.summary}`);
  }

  const relationEdges = edgesTraversed.filter(e => e.type !== 'DERIVED_FROM');
  if (relationEdges.length > 0) {
    lines.push('');
    lines.push('#### Structural Relationships:');
    for (const rel of relationEdges) {
      lines.push(`- ${rel.sourceId} -[:${rel.type}]-> ${rel.targetId}: ${rel.claim}`);
    }
  }

  lines.push('');
  lines.push('#### Provenance Sources:');
  const sourceShas = new Set(edgesTraversed.map(e => e.sourceSha).filter(s => s !== 'structural'));
  for (const sha of sourceShas) {
    const src = graph.sources[sha];
    if (src) {
      lines.push(`- Source: "${src.title}" (sha256: ${sha.slice(0, 10)}..., tokens: ${src.tokenCount})`);
    }
  }

  const formattedContext = lines.join('\n');
  const subgraphTokensRetrieved = estimateTokens(formattedContext);
  const sourceTokensOriginal = graph.metrics.estimatedTotalTokens || 5000;
  const tokenSavingsPercent = Math.max(0, Math.round(((sourceTokensOriginal - subgraphTokensRetrieved) / sourceTokensOriginal) * 100));

  return {
    formattedContext,
    matchedEntities,
    edgesTraversed,
    sourceTokensOriginal,
    subgraphTokensRetrieved,
    tokenSavingsPercent,
  };
}
