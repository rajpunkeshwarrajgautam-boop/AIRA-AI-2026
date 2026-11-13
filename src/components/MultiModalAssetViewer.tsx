import React, { useState, useRef, useMemo } from 'react';
import {
  Image as ImageIcon,
  Volume2,
  Video as VideoIcon,
  FileText,
  ZoomIn,
  ZoomOut,
  Download,
  Play,
  Pause,
  Eye,
  Code,
  ShieldCheck,
  AlertTriangle
} from 'lucide-react';
import type { ArtifactProjectFile } from '../types/multiFileArtifact';
import { sanitizeSvgMarkup, formatAudioTime } from '../utils/multiModalAssets';

interface MultiModalAssetViewerProps {
  file: ArtifactProjectFile;
}

/**
 * Detects whether content is base64 or a data URI and returns a valid data URL.
 */
function resolveMediaDataUrl(content: string, mimeType: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('data:')) {
    return trimmed;
  }
  if (trimmed.startsWith('blob:') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  // If base64 payload without data URI scheme
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed.replace(/\s+/g, ''))) {
    return `data:${mimeType};base64,${trimmed}`;
  }
  // UTF-8 string or SVG
  if (mimeType.includes('svg') || trimmed.startsWith('<svg')) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(trimmed)}`;
  }
  return trimmed;
}

export const MultiModalAssetViewer: React.FC<MultiModalAssetViewerProps> = ({
  file,
}) => {
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [svgViewMode, setSvgViewMode] = useState<'visual' | 'code'>('visual');
  const [naturalDimensions, setNaturalDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioProgress, setAudioProgress] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // This viewer never creates object URLs. In particular, it must not revoke
  // an externally owned blob URL provided by the artifact source. The parent
  // keys this component per file to reset playback/zoom state on navigation.

  const mimeType = useMemo(() => {
    const ext = file.path.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'webp': return 'image/webp';
      case 'gif': return 'image/gif';
      case 'svg': return 'image/svg+xml';
      case 'mp3': return 'audio/mpeg';
      case 'wav': return 'audio/wav';
      case 'ogg': return 'audio/ogg';
      case 'mp4': return 'video/mp4';
      case 'webm': return 'video/webm';
      case 'pdf': return 'application/pdf';
      default: return 'application/octet-stream';
    }
  }, [file.path]);

  const mediaSource = useMemo(() => {
    try {
      return resolveMediaDataUrl(file.content, mimeType);
    } catch {
      return '';
    }
  }, [file.content, mimeType]);

  const sanitizedSvg = useMemo(() => {
    if (file.kind === 'svg' || file.path.endsWith('.svg')) {
      return sanitizeSvgMarkup(file.content);
    }
    return '';
  }, [file.kind, file.path, file.content]);

  // Formatted byte size
  const formattedSize = useMemo(() => {
    const bytes = file.sizeBytes || new TextEncoder().encode(file.content).length;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }, [file.sizeBytes, file.content]);

  // Image controls
  const handleZoomIn = () => setZoomLevel(z => Math.min(3, Math.round((z + 0.25) * 100) / 100));
  const handleZoomOut = () => setZoomLevel(z => Math.max(0.5, Math.round((z - 0.25) * 100) / 100));
  const handleZoomReset = () => setZoomLevel(1);

  // Audio controls
  const togglePlayAudio = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
    }
  };

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = mediaSource;
    a.download = file.name;
    a.click();
  };

  return (
    <div
      data-testid="multimodal-asset-viewer"
      className="flex-1 w-full h-full flex flex-col bg-stone-950 text-stone-200 select-none overflow-hidden"
    >
      {/* Top Asset Meta Bar */}
      <div className="h-9 px-4 flex items-center justify-between border-b border-stone-800 bg-stone-900 text-xs text-stone-400">
        <div className="flex items-center gap-2 min-w-0">
          {file.kind === 'image' && <ImageIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
          {file.kind === 'svg' && <ImageIcon className="w-3.5 h-3.5 text-teal-400 shrink-0" />}
          {file.kind === 'audio' && <Volume2 className="w-3.5 h-3.5 text-purple-400 shrink-0" />}
          {file.kind === 'video' && <VideoIcon className="w-3.5 h-3.5 text-rose-400 shrink-0" />}
          {file.kind === 'pdf' && <FileText className="w-3.5 h-3.5 text-amber-400 shrink-0" />}

          <span className="font-mono text-[12px] font-medium text-stone-200 truncate">
            {file.path}
          </span>
          <span className="text-stone-600">•</span>
          <span className="font-mono text-xs text-stone-400">
            {mimeType}
          </span>
          <span className="text-stone-600">•</span>
          <span className="font-mono text-[10px] text-stone-400">
            {formattedSize}
          </span>
          {naturalDimensions && (
            <>
              <span className="text-stone-600">•</span>
              <span className="text-[10px] text-stone-400">
                <code className="font-mono">{naturalDimensions.width} × {naturalDimensions.height}</code> px
              </span>
            </>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {(file.kind === 'image' || file.kind === 'svg') && (
            <div className="flex items-center gap-1 bg-stone-900 border border-stone-800 rounded px-1 py-0.5">
              <button
                type="button"
                onClick={handleZoomOut}
                disabled={zoomLevel <= 0.5}
                title="Zoom out"
                data-testid="multimodal-zoom-out"
                className="p-0.5 text-stone-400 hover:text-stone-200 disabled:opacity-30"
              >
                <ZoomOut className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={handleZoomReset}
                title="Reset zoom"
                data-testid="multimodal-zoom-reset"
                className="px-1 font-mono text-[10px] text-stone-300 hover:underline"
              >
                {Math.round(zoomLevel * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                disabled={zoomLevel >= 3}
                title="Zoom in"
                data-testid="multimodal-zoom-in"
                className="p-0.5 text-stone-400 hover:text-stone-200 disabled:opacity-30"
              >
                <ZoomIn className="w-3 h-3" />
              </button>
            </div>
          )}

          {file.kind === 'svg' && (
            <div className="flex items-center bg-stone-900 border border-stone-800 rounded p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => setSvgViewMode('visual')}
                data-testid="svg-toggle-visual"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${
                  svgViewMode === 'visual' ? 'bg-stone-800 text-stone-100 font-semibold' : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                <Eye className="w-3 h-3" />
                <span>Visual</span>
              </button>
              <button
                type="button"
                onClick={() => setSvgViewMode('code')}
                data-testid="svg-toggle-code"
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded ${
                  svgViewMode === 'code' ? 'bg-stone-800 text-stone-100 font-semibold' : 'text-stone-400 hover:text-stone-200'
                }`}
              >
                <Code className="w-3 h-3" />
                <span>Source</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={handleDownload}
            data-testid="multimodal-download-btn"
            title="Download asset"
            className="p-1 rounded text-stone-400 hover:text-stone-200 hover:bg-stone-800 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Asset Canvas */}
      <div className="flex-1 w-full h-full relative overflow-auto flex items-center justify-center p-4">
        {loadError && (
          <div
            role="alert"
            data-testid="multimodal-error-box"
            className="flex items-center gap-2 px-4 py-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-lg text-xs"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{loadError}</span>
          </div>
        )}

        {/* 1. Raster Image Preview */}
        {file.kind === 'image' && !loadError && (
          <div
            data-testid="image-preview-stage"
            className="relative flex items-center justify-center max-w-full max-h-full rounded-lg shadow-xl overflow-hidden p-2"
            style={{
              backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
              backgroundColor: 'var(--bg-surface-secondary)',
              backgroundSize: '16px 16px',
            }}
          >
            <img
              src={mediaSource}
              alt={file.name}
              data-testid="multimodal-image-element"
              fetchPriority="high"
              decoding="async"
              crossOrigin="anonymous"
              onLoad={e => {
                const img = e.currentTarget;
                setNaturalDimensions({ width: img.naturalWidth, height: img.naturalHeight });
              }}
              onError={() => setLoadError(`Failed to decode image asset: ${file.name}`)}
              style={{
                transform: `scale(${zoomLevel})`,
                transformOrigin: 'center center',
                transition: 'transform 0.15s ease',
                maxWidth: '90vw',
                maxHeight: '80vh',
                objectFit: 'contain'
              }}
              className="rounded"
            />
          </div>
        )}

        {/* 2. SVG Vector Preview */}
        {file.kind === 'svg' && !loadError && (
          svgViewMode === 'visual' ? (
            <div
              data-testid="svg-preview-stage"
              className="relative flex items-center justify-center max-w-full max-h-full rounded-lg shadow-xl overflow-auto p-4"
              style={{
                backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
                backgroundColor: 'var(--bg-surface-secondary)',
                backgroundSize: '16px 16px',
                transform: `scale(${zoomLevel})`,
                transformOrigin: 'center center',
                transition: 'transform 0.15s ease',
              }}
            >
              {/* Untrusted SVG must never become executable DOM in AIRA's origin. */}
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitizedSvg)}`}
                alt={file.name}
                draggable={false}
                className="max-w-full max-h-full object-contain"
                data-testid="svg-inert-image"
                onError={() => setLoadError(`Failed to decode SVG asset: ${file.name}`)}
              />
            </div>
          ) : (
            <div className="w-full h-full flex flex-col font-mono text-xs overflow-auto bg-stone-950 p-4 rounded-lg border border-stone-800">
              <pre className="whitespace-pre overflow-x-auto text-stone-300">
                <code>{file.content}</code>
              </pre>
            </div>
          )
        )}

        {/* 3. Audio Player */}
        {file.kind === 'audio' && (
          <div
            data-testid="audio-preview-stage"
            className="w-full max-w-md p-6 bg-stone-900 border border-stone-800 rounded-2xl shadow-lg flex flex-col gap-4"
          >
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center border border-purple-500/30">
                <Volume2 className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-stone-100 truncate">{file.name}</h4>
                <p className="text-xs text-stone-500 font-mono mt-0.5">{mimeType} • {formattedSize}</p>
              </div>
            </div>

            <audio
              ref={audioRef}
              src={mediaSource}
              preload="metadata"
              onTimeUpdate={() => {
                if (audioRef.current) {
                  setAudioProgress(audioRef.current.currentTime);
                  if (audioRef.current.duration && isFinite(audioRef.current.duration)) {
                    setAudioDuration(audioRef.current.duration);
                  }
                }
              }}
              onLoadedMetadata={() => {
                if (audioRef.current && audioRef.current.duration && isFinite(audioRef.current.duration)) {
                  setAudioDuration(audioRef.current.duration);
                }
              }}
              onCanPlay={() => {
                if (audioRef.current && audioRef.current.duration && isFinite(audioRef.current.duration)) {
                  setAudioDuration(audioRef.current.duration);
                }
              }}
              onEnded={() => setIsPlaying(false)}
              onError={() => setLoadError(`Failed to load audio asset: ${file.name}`)}
            />

            {/* Playback bar */}
            <div className="flex flex-col gap-1.5">
              <input
                type="range"
                data-testid="audio-scrubber"
                aria-label="Audio scrubber"
                min="0"
                max={audioDuration > 0 ? audioDuration : 100}
                step="0.01"
                value={audioProgress}
                onChange={e => {
                  const val = Number(e.target.value);
                  if (audioRef.current) audioRef.current.currentTime = val;
                  setAudioProgress(val);
                }}
                className="w-full h-1 bg-stone-700 rounded appearance-none cursor-pointer accent-purple-400"
              />
              <div className="flex justify-between text-[10px] font-mono text-stone-500">
                <span data-testid="audio-current-time">{formatAudioTime(audioProgress)}</span>
                <span data-testid="audio-duration">{formatAudioTime(audioDuration)}</span>
              </div>
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                data-testid="audio-play-pause-btn"
                onClick={togglePlayAudio}
                className="w-10 h-10 rounded-full bg-purple-500 text-white flex items-center justify-center hover:bg-purple-600 transition-colors shadow-lg shadow-purple-500/30"
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
              </button>
            </div>
          </div>
        )}

        {/* 4. Video Player */}
        {file.kind === 'video' && !loadError && (
          <div
            data-testid="video-preview-stage"
            className="max-w-2xl w-full bg-black rounded-xl border border-stone-800 shadow-lg overflow-hidden flex flex-col"
          >
            <video poster="/screenshots/desktop.png" src={mediaSource}
              controls
              playsInline
              preload="metadata"
              crossOrigin="anonymous"
              data-testid="multimodal-video-element"
              onError={() => setLoadError(`Failed to play video asset: ${file.name}`)}
              className="w-full max-h-[70vh] object-contain"
            />
          </div>
        )}

        {/* 5. PDF & Document Preview */}
        {file.kind === 'pdf' && !loadError && (
          <div
            data-testid="pdf-preview-stage"
            className="w-full h-full flex flex-col bg-stone-900 rounded-xl border border-stone-800 overflow-hidden"
          >
            <iframe
              src={mediaSource}
              title={file.name}
              sandbox="allow-scripts allow-forms"
              className="w-full flex-1 border-0"
            />
          </div>
        )}
      </div>

      {/* Safety Notice Footer */}
      <div className="h-7 px-4 bg-stone-950 border-t border-stone-800/80 flex items-center gap-1.5 text-[10px] text-stone-500">
        <ShieldCheck className="w-3 h-3 text-emerald-400" />
        <span>Vector previews use inert images; documents run in an isolated frame.</span>
      </div>
    </div>
  );
};
