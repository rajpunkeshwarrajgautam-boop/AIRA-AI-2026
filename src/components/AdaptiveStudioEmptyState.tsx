import React from 'react';
import { Code2, Layers3, ShieldCheck } from 'lucide-react';
import { AiraMark } from './AiraMark';

/**
 * Honest empty state for the opt-in Adaptive Studio layout.
 * Real artifacts continue to render in the existing sandboxed ArtifactStudio.
 */
export const AdaptiveStudioEmptyState: React.FC = () => (
  <aside className="aira-adaptive-empty-studio" aria-label="Artifact Studio" data-testid="adaptive-studio-empty">
    <div className="aira-adaptive-empty-header">
      <Layers3 size={22} aria-hidden="true" />
      <h2>Artifact Studio</h2>
    </div>
    <div className="aira-adaptive-empty-tabs" aria-hidden="true">
      <span className="aira-adaptive-empty-tab-active">Preview</span>
      <span>Code</span>
    </div>
    <div className="aira-adaptive-empty-body">
      <AiraMark size="lg" isAnimated={false} />
      <h3>Your next creation starts here.</h3>
      <p>Ask Aira to build an artifact, or open one from a conversation. Its real preview will appear in this workspace.</p>
      <div className="aira-adaptive-empty-hint">
        <Code2 size={18} aria-hidden="true" />
        HTML, code, SVG, and supported interactive artifacts
      </div>
    </div>
    <div className="aira-adaptive-empty-footer">
      <ShieldCheck size={18} aria-hidden="true" />
      Generated content stays in Aira's existing isolated preview runtime.
    </div>
  </aside>
);
