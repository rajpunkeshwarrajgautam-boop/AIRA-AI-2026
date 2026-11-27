import React, { useState, useCallback } from 'react';
import type { PresentationDeck, Slide, SlideLayout } from '../../../packages/contracts/src/artifacts.js';
import {
  addSlideToDeck,
  removeSlideFromDeck,
  reorderDeckSlides,
  updateDeckSlide,
  getSlideThemeStyles,
} from '../../utils/presentationEngine.js';
import { generatePptxArchive } from '../../utils/officeDocumentExporter.js';

interface GenUISlideEditorProps {
  deck: PresentationDeck;
  onChange?: (updated: PresentationDeck) => void;
  isDark?: boolean;
}

export const GenUISlideEditor: React.FC<GenUISlideEditorProps> = ({
  deck: initialDeck,
  onChange,
  isDark = false,
}) => {
  const [deck, setDeck] = useState<PresentationDeck>(initialDeck);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [showNotes, setShowNotes] = useState<boolean>(false);

  const activeSlide: Slide | undefined = deck.slides[activeIndex] || deck.slides[0];
  const themeStyles = getSlideThemeStyles(deck.theme);

  const handleUpdateActiveSlide = useCallback((updates: Partial<Omit<Slide, 'id'>>) => {
    if (!activeSlide) return;
    const updated = updateDeckSlide(deck, activeSlide.id, updates);
    setDeck(updated);
    onChange?.(updated);
  }, [deck, activeSlide, onChange]);

  const handleAddSlide = useCallback(() => {
    const newSlide: Slide = {
      id: `slide-${Date.now()}`,
      title: 'New Slide',
      subtitle: 'Slide Subtitle',
      layout: 'content',
      bullets: ['Key talking point 1', 'Key talking point 2'],
      notes: '',
    };
    const updated = addSlideToDeck(deck, newSlide, activeIndex + 1);
    setDeck(updated);
    setActiveIndex(activeIndex + 1);
    onChange?.(updated);
  }, [deck, activeIndex, onChange]);

  const handleDeleteSlide = useCallback(() => {
    if (deck.slides.length <= 1 || !activeSlide) return;
    const updated = removeSlideFromDeck(deck, activeSlide.id);
    setDeck(updated);
    setActiveIndex(Math.max(0, activeIndex - 1));
    onChange?.(updated);
  }, [deck, activeIndex, activeSlide, onChange]);

  const handleMoveSlide = useCallback((direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? activeIndex - 1 : activeIndex + 1;
    if (targetIdx < 0 || targetIdx >= deck.slides.length) return;
    const updated = reorderDeckSlides(deck, activeIndex, targetIdx);
    setDeck(updated);
    setActiveIndex(targetIdx);
    onChange?.(updated);
  }, [deck, activeIndex, onChange]);

  const handleExportPptx = useCallback(() => {
    const bytes = generatePptxArchive(deck);
    const blob = new Blob([bytes as any], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(deck.title || 'presentation').toLowerCase().replace(/\s+/g, '_')}.pptx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [deck]);

  if (!activeSlide) {
    return <div className="p-4 text-center text-zinc-500">No slides in presentation.</div>;
  }

  return (
    <div className={`flex flex-col h-full w-full ${isDark ? 'bg-zinc-950 text-zinc-100' : 'bg-zinc-50 text-zinc-800'}`}>
      {/* Top Controls Toolbar */}
      <div className={`flex items-center justify-between p-2 border-b text-xs ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-white'}`}>
        <div className="flex items-center gap-2">
          <span className="font-semibold px-2 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
            Slide {activeIndex + 1} of {deck.slides.length}
          </span>
          <select
            value={activeSlide.layout}
            onChange={(e) => handleUpdateActiveSlide({ layout: e.target.value as SlideLayout })}
            className={`px-2 py-1 rounded border text-xs outline-none ${
              isDark ? 'bg-zinc-800 border-zinc-700 text-zinc-100' : 'bg-white border-zinc-300 text-zinc-800'
            }`}
          >
            <option value="title-slide">Title Layout</option>
            <option value="content">Content Layout</option>
            <option value="split">Split Layout</option>
            <option value="stats">Stats / KPI Layout</option>
            <option value="quote">Quote Layout</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => handleMoveSlide('up')}
            disabled={activeIndex === 0}
            className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
            title="Move slide earlier"
          >
            ▲
          </button>
          <button
            onClick={() => handleMoveSlide('down')}
            disabled={activeIndex === deck.slides.length - 1}
            className="px-2 py-1 rounded border border-zinc-300 dark:border-zinc-700 disabled:opacity-40 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
            title="Move slide later"
          >
            ▼
          </button>
          <button
            onClick={handleAddSlide}
            className="px-2.5 py-1 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 transition"
          >
            + Add Slide
          </button>
          <button
            onClick={handleDeleteSlide}
            disabled={deck.slides.length <= 1}
            className="px-2 py-1 rounded border border-red-300 text-red-600 dark:border-red-800 dark:text-red-400 disabled:opacity-40 hover:bg-red-50 dark:hover:bg-red-950 transition"
          >
            Delete
          </button>
          <button
            onClick={handleExportPptx}
            className="px-3 py-1 rounded bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition"
          >
            Export PPTX
          </button>
        </div>
      </div>

      {/* Main Slide Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Slide Thumbnail Rail */}
        <div className={`w-48 overflow-y-auto p-3 flex flex-col gap-2.5 border-r ${isDark ? 'border-zinc-800 bg-zinc-900/60' : 'border-zinc-200 bg-zinc-100'}`}>
          {deck.slides.map((s, idx) => (
            <div
              key={s.id}
              onClick={() => setActiveIndex(idx)}
              className={`p-2 rounded border cursor-pointer transition text-left ${
                idx === activeIndex
                  ? 'border-amber-500 ring-2 ring-amber-500/20 bg-white dark:bg-zinc-800 font-medium'
                  : 'border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-600 opacity-80'
              }`}
            >
              <div className="text-[10px] text-zinc-400 font-mono mb-1">#{idx + 1} • {s.layout}</div>
              <div className="text-xs truncate font-semibold">{s.title || 'Untitled Slide'}</div>
            </div>
          ))}
        </div>

        {/* 16:9 Slide Canvas */}
        <div className="flex-1 flex flex-col items-center justify-center p-6 overflow-auto">
          <div
            className="w-full max-w-4xl aspect-[16/9] rounded-xl shadow-xl p-8 flex flex-col justify-between border transition-all"
            style={{
              backgroundColor: themeStyles.bg,
              color: themeStyles.text,
              borderColor: themeStyles.border,
            }}
          >
            {/* Slide Header */}
            <div>
              <input
                type="text"
                value={activeSlide.title}
                onChange={(e) => handleUpdateActiveSlide({ title: e.target.value })}
                className="w-full text-2xl font-bold bg-transparent outline-none border-b border-transparent hover:border-dashed hover:border-zinc-400 focus:border-amber-500"
                placeholder="Slide Title"
              />
              <input
                type="text"
                value={activeSlide.subtitle || ''}
                onChange={(e) => handleUpdateActiveSlide({ subtitle: e.target.value })}
                className="w-full text-sm mt-1 opacity-70 bg-transparent outline-none border-b border-transparent hover:border-dashed hover:border-zinc-400 focus:border-amber-500"
                placeholder="Subtitle or descriptive header"
              />
            </div>

            {/* Slide Body */}
            <div className="my-auto py-4">
              <div className="space-y-2">
                {(activeSlide.bullets || []).map((bullet, bIdx) => (
                  <div key={bIdx} className="flex items-center gap-2">
                    <span className="text-amber-500 font-bold">•</span>
                    <input
                      type="text"
                      value={bullet}
                      onChange={(e) => {
                        const nextBullets = [...(activeSlide.bullets || [])];
                        nextBullets[bIdx] = e.target.value;
                        handleUpdateActiveSlide({ bullets: nextBullets });
                      }}
                      className="flex-1 bg-transparent text-base outline-none border-b border-transparent hover:border-dashed hover:border-zinc-400 focus:border-amber-500"
                    />
                    <button
                      onClick={() => {
                        const nextBullets = (activeSlide.bullets || []).filter((_, i) => i !== bIdx);
                        handleUpdateActiveSlide({ bullets: nextBullets });
                      }}
                      className="text-zinc-400 hover:text-red-500 text-xs px-1"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => {
                    const nextBullets = [...(activeSlide.bullets || []), 'New point'];
                    handleUpdateActiveSlide({ bullets: nextBullets });
                  }}
                  className="text-xs text-amber-500 hover:underline mt-2 font-medium"
                >
                  + Add bullet point
                </button>
              </div>
            </div>

            {/* Slide Footer */}
            <div className="flex items-center justify-between text-xs opacity-50 border-t pt-2" style={{ borderColor: themeStyles.border }}>
              <span>AIRA Multimodal Presentation</span>
              <span>{activeIndex + 1} / {deck.slides.length}</span>
            </div>
          </div>

          {/* Speaker Notes Drawer */}
          <div className="w-full max-w-4xl mt-4">
            <button
              onClick={() => setShowNotes(!showNotes)}
              className="text-xs font-semibold text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
            >
              {showNotes ? '▼ Hide Speaker Notes' : '▶ Show Speaker Notes'}
            </button>
            {showNotes && (
              <textarea
                value={activeSlide.notes || ''}
                onChange={(e) => handleUpdateActiveSlide({ notes: e.target.value })}
                placeholder="Add presenter notes here..."
                rows={3}
                className={`w-full mt-2 p-2.5 rounded-lg border text-xs font-mono outline-none ${
                  isDark ? 'bg-zinc-900 border-zinc-800 text-zinc-200' : 'bg-white border-zinc-300 text-zinc-800'
                }`}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
