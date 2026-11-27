import React from 'react';
import { Users, Bot, User, CheckCircle2, AlertTriangle, RotateCcw, RotateCw, FileDown } from 'lucide-react';
import type { CollabActor, CollabPresence } from '../../../packages/contracts/src/collaboration.js';

export interface GenUICollaborativeCanvasProps {
  sessionId: string;
  currentActor: CollabActor;
  participants: CollabPresence[];
  connectionStatus: 'connected' | 'connecting' | 'offline' | 'syncing';
  saveStatus: 'saved' | 'saving' | 'conflict';
  hasConflicts?: boolean;
  conflictDetails?: string;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onExportDocx?: () => void;
  onExportXlsx?: () => void;
  onExportPptx?: () => void;
  onExportPdf?: () => void;
}

export const GenUICollaborativeCanvas: React.FC<GenUICollaborativeCanvasProps> = ({
  sessionId,
  currentActor,
  participants,
  connectionStatus,
  saveStatus,
  hasConflicts,
  conflictDetails,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExportDocx,
  onExportXlsx,
  onExportPptx,
  onExportPdf,
}) => {
  const activeParticipants = participants.filter((p) => p.status !== 'disconnected');

  return (
    <div className="flex flex-col border-b border-border bg-card/60 px-4 py-2 text-sm backdrop-blur">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Session & Connection Status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Users className="h-4 w-4 text-primary" />
            <span>Multi-Agent Live Canvas</span>
          </div>

          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connectionStatus === 'connected'
                  ? 'bg-emerald-500'
                  : connectionStatus === 'syncing'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-rose-500'
              }`}
              aria-hidden="true"
            />
            <span className="capitalize text-muted-foreground">{connectionStatus}</span>
          </div>

          {saveStatus === 'saved' && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              <span>DURABLY SAVED</span>
            </div>
          )}
          {saveStatus === 'saving' && (
            <span className="text-xs text-amber-500">Syncing changes...</span>
          )}
        </div>

        {/* Center: Collaborators Avatars (Human + AI Specialists) */}
        <div className="flex items-center gap-1.5" aria-label="Active Collaborators">
          {activeParticipants.map((p) => {
            const isMe = p.actorId === currentActor.actorId;
            const isAgent = p.actor.isAgent;
            return (
              <div
                key={p.actorId}
                className="group relative flex h-7 items-center gap-1.5 rounded-full border border-border/80 px-2.5 py-0.5 text-xs shadow-sm transition hover:border-primary/50"
                style={{ backgroundColor: `${p.actor.color}15` }}
                title={`${p.actor.displayName} (${p.actor.role}${isAgent ? ' - AI Agent' : ''})`}
              >
                {isAgent ? (
                  <Bot className="h-3.5 w-3.5 text-purple-400" />
                ) : (
                  <User className="h-3.5 w-3.5 text-blue-400" />
                )}
                <span className="max-w-[100px] truncate font-medium text-foreground">
                  {p.actor.displayName} {isMe ? '(You)' : ''}
                </span>
                {isAgent && p.actor.agentRole && (
                  <span className="rounded bg-purple-500/20 px-1 text-[10px] uppercase font-semibold text-purple-300">
                    {p.actor.agentRole}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Right: Actions & Exports */}
        <div className="flex items-center gap-2">
          {/* Participant-Scoped Undo/Redo */}
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            className="flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-40"
            title="Undo your last edit"
            aria-label="Undo"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            className="flex h-7 w-7 items-center justify-center rounded border border-border text-muted-foreground hover:bg-muted disabled:opacity-40"
            title="Redo your last edit"
            aria-label="Redo"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>

          {/* Export Actions */}
          <div className="flex items-center gap-1 border-l border-border pl-2">
            {onExportDocx && (
              <button
                type="button"
                onClick={onExportDocx}
                className="flex items-center gap-1 rounded bg-secondary/80 px-2 py-1 text-xs font-medium text-secondary-foreground hover:bg-secondary"
                title="Export as Microsoft Word (.docx)"
              >
                <FileDown className="h-3 w-3" />
                <span>DOCX</span>
              </button>
            )}
            {onExportXlsx && (
              <button
                type="button"
                onClick={onExportXlsx}
                className="flex items-center gap-1 rounded bg-emerald-500/20 px-2 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/30"
                title="Export as Microsoft Excel (.xlsx)"
              >
                <FileDown className="h-3 w-3" />
                <span>XLSX</span>
              </button>
            )}
            {onExportPptx && (
              <button
                type="button"
                onClick={onExportPptx}
                className="flex items-center gap-1 rounded bg-orange-500/20 px-2 py-1 text-xs font-medium text-orange-400 hover:bg-orange-500/30"
                title="Export as Microsoft PowerPoint (.pptx)"
              >
                <FileDown className="h-3 w-3" />
                <span>PPTX</span>
              </button>
            )}
            {onExportPdf && (
              <button
                type="button"
                onClick={onExportPdf}
                className="flex items-center gap-1 rounded bg-rose-500/20 px-2 py-1 text-xs font-medium text-rose-400 hover:bg-rose-500/30"
                title="Export as Adobe PDF (.pdf)"
              >
                <FileDown className="h-3 w-3" />
                <span>PDF</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Same-Cell / Concurrent Conflict Warning */}
      {hasConflicts && (
        <div className="mt-2 flex items-center gap-2 rounded bg-amber-500/10 px-3 py-1.5 text-xs text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
          <span className="font-medium">
            {conflictDetails || 'Concurrent edit conflict detected. The server has reconciled the state.'}
          </span>
        </div>
      )}
    </div>
  );
};
