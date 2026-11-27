import React, { useMemo } from 'react';
import { renderDiagramToSvg } from '../../utils/diagramRenderer.js';

interface GenUIDiagramProps {
  source: string;
  isDark?: boolean;
}

export const GenUIDiagram: React.FC<GenUIDiagramProps> = ({
  source,
  isDark = false,
}) => {
  const svgMarkup = useMemo(() => {
    return renderDiagramToSvg(source, { isDark });
  }, [source, isDark]);

  const handleDownloadSvg = () => {
    const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagram_${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`flex flex-col h-full w-full ${isDark ? 'bg-zinc-950' : 'bg-zinc-50'}`}>
      <div className={`flex items-center justify-between px-3 py-2 border-b text-xs ${
        isDark ? 'border-zinc-800 bg-zinc-900 text-zinc-300' : 'border-zinc-200 bg-white text-zinc-700'
      }`}>
        <span className="font-semibold text-amber-600 dark:text-amber-400">Declarative Diagram View</span>
        <button
          onClick={handleDownloadSvg}
          className="px-2.5 py-1 text-xs font-medium rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition"
        >
          Download SVG
        </button>
      </div>
      <div
        className="flex-1 p-6 flex items-center justify-center overflow-auto"
        dangerouslySetInnerHTML={{ __html: svgMarkup }}
      />
    </div>
  );
};
