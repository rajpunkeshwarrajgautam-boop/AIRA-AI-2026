import React, { useState, useMemo, useCallback } from 'react';
import type { SpreadsheetWorkbook } from '../../../packages/contracts/src/artifacts.js';
import {
  recalculateSpreadsheet,
  exportSpreadsheetToCsv,
  colIndexToLetter,
} from '../../utils/spreadsheetEngine.js';
import { generateXlsxArchive } from '../../utils/officeDocumentExporter.js';

interface GenUISheetEditorProps {
  workbook: SpreadsheetWorkbook;
  onChange?: (updated: SpreadsheetWorkbook) => void;
  isDark?: boolean;
}

export const GenUISheetEditor: React.FC<GenUISheetEditorProps> = ({
  workbook: initialWorkbook,
  onChange,
  isDark = false,
}) => {
  const [workbook, setWorkbook] = useState<SpreadsheetWorkbook>(() => recalculateSpreadsheet(initialWorkbook));
  const [selectedCoord, setSelectedCoord] = useState<string>('A1');
  const [editingValue, setEditingValue] = useState<string>('');
  const [activeSheetName, setActiveSheetName] = useState<string>(workbook.activeSheet || workbook.sheets[0]?.name || 'Sheet1');

  const activeSheet = useMemo(() => {
    return workbook.sheets.find((s) => s.name === activeSheetName) || workbook.sheets[0] || { name: 'Sheet1', rowCount: 20, colCount: 10, cells: {} };
  }, [workbook, activeSheetName]);

  const selectedCell = activeSheet.cells?.[selectedCoord];

  const handleSelectCell = useCallback((coord: string) => {
    setSelectedCoord(coord);
    const cell = activeSheet.cells?.[coord];
    setEditingValue(cell?.raw !== undefined ? String(cell.raw) : '');
  }, [activeSheet]);

  const handleFormulaChange = useCallback((newRaw: string) => {
    setEditingValue(newRaw);
    const updatedSheets = workbook.sheets.map((s) => {
      if (s.name === activeSheet.name) {
        return {
          ...s,
          cells: {
            ...(s.cells || {}),
            [selectedCoord]: {
              raw: newRaw,
              computed: newRaw,
            },
          },
        };
      }
      return s;
    });

    const nextWb = recalculateSpreadsheet({
      ...workbook,
      sheets: updatedSheets,
    });
    setWorkbook(nextWb);
    onChange?.(nextWb);
  }, [workbook, activeSheet, selectedCoord, onChange]);

  const handleExportCsv = useCallback(() => {
    const csvContent = exportSpreadsheetToCsv(workbook, activeSheet.name);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSheet.name.toLowerCase()}_export.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [workbook, activeSheet]);

  const handleExportXlsx = useCallback(() => {
    const bytes = generateXlsxArchive(workbook);
    const blob = new Blob([bytes as any], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSheet.name.toLowerCase()}_export.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }, [workbook, activeSheet]);

  const rowCount = activeSheet.rowCount || 20;
  const colCount = activeSheet.colCount || 10;

  return (
    <div className={`flex flex-col h-full w-full select-none text-xs ${isDark ? 'bg-[#18181B] text-zinc-100' : 'bg-white text-zinc-800'}`}>
      {/* Formula Bar & Action Toolbar */}
      <div className={`flex items-center gap-2 p-2 border-b ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-zinc-50'}`}>
        <div className={`px-2 py-1 font-mono font-semibold rounded text-center min-w-[50px] border ${isDark ? 'bg-zinc-800 border-zinc-700 text-amber-400' : 'bg-white border-zinc-300 text-amber-700'}`}>
          {selectedCoord}
        </div>
        <span className="font-semibold text-zinc-400">fx</span>
        <input
          type="text"
          value={editingValue}
          onChange={(e) => handleFormulaChange(e.target.value)}
          placeholder="Enter a value or formula (e.g. =SUM(A1:A5))"
          className={`flex-1 px-3 py-1 font-mono text-xs rounded border outline-none focus:ring-1 focus:ring-amber-500 ${
            isDark ? 'bg-zinc-800 border-zinc-700 text-zinc-100' : 'bg-white border-zinc-300 text-zinc-900'
          }`}
        />
        <button
          onClick={handleExportCsv}
          className="px-2.5 py-1 text-xs font-medium rounded border border-zinc-300 hover:bg-zinc-200 dark:border-zinc-700 dark:hover:bg-zinc-800 transition"
          title="Export sanitized CSV"
        >
          CSV
        </button>
        <button
          onClick={handleExportXlsx}
          className="px-2.5 py-1 text-xs font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700 transition"
          title="Export true XLSX workbook"
        >
          XLSX
        </button>
      </div>

      {/* Spreadsheet Grid Viewport */}
      <div className="flex-1 overflow-auto relative">
        <table className="border-collapse table-fixed w-max min-w-full">
          <thead>
            <tr className={`sticky top-0 z-10 ${isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500'}`}>
              <th className="w-12 h-6 border border-zinc-300 dark:border-zinc-700 text-center font-normal text-[11px]">#</th>
              {Array.from({ length: colCount }, (_, c) => {
                const colLetter = colIndexToLetter(c + 1);
                return (
                  <th key={colLetter} className="w-24 h-6 border border-zinc-300 dark:border-zinc-700 text-center font-normal text-[11px]">
                    {colLetter}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowCount }, (_, r) => {
              const rowNum = r + 1;
              return (
                <tr key={rowNum}>
                  <td className={`w-12 h-6 border border-zinc-300 dark:border-zinc-700 text-center font-normal text-[11px] select-none ${
                    isDark ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-100 text-zinc-500'
                  }`}>
                    {rowNum}
                  </td>
                  {Array.from({ length: colCount }, (_, c) => {
                    const coord = `${colIndexToLetter(c + 1)}${rowNum}`;
                    const cell = activeSheet.cells?.[coord];
                    const isSelected = selectedCoord === coord;
                    const displayValue = cell?.computed !== undefined ? String(cell.computed) : (cell?.raw ?? '');
                    const isError = typeof cell?.computed === 'string' && cell.computed.startsWith('#');

                    return (
                      <td
                        key={coord}
                        onClick={() => handleSelectCell(coord)}
                        className={`w-24 h-6 px-1.5 border border-zinc-300 dark:border-zinc-700 truncate font-mono text-[11px] cursor-cell ${
                          isSelected
                            ? isDark
                              ? 'bg-amber-950/40 ring-2 ring-amber-500'
                              : 'bg-amber-50 ring-2 ring-amber-500'
                            : isDark
                            ? 'hover:bg-zinc-800'
                            : 'hover:bg-zinc-50'
                        } ${isError ? 'text-red-500 font-semibold' : ''}`}
                      >
                        {displayValue}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Sheet Tabs */}
      <div className={`flex items-center gap-1 px-2 py-1 border-t text-xs ${isDark ? 'border-zinc-800 bg-zinc-900' : 'border-zinc-200 bg-zinc-100'}`}>
        {workbook.sheets.map((s) => (
          <button
            key={s.name}
            onClick={() => {
              setActiveSheetName(s.name);
              handleSelectCell('A1');
            }}
            className={`px-3 py-1 font-medium rounded-t border-b-2 transition ${
              s.name === activeSheet.name
                ? 'border-amber-500 text-amber-500 font-bold bg-white dark:bg-zinc-800'
                : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>
    </div>
  );
};
