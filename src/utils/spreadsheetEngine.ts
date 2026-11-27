import type { SpreadsheetWorkbook, SpreadsheetWorksheet } from '../../packages/contracts/src/artifacts.js';

export type CellValue = string | number | boolean;

/**
 * Sanitizes cell values for CSV export to prevent Formula Injection (CSV Injection).
 * If a cell begins with '=', '+', '-', or '@', prepends a single quote (').
 */
export function sanitizeSpreadsheetCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  let sanitized = str;
  if (/^[=+\-@]/.test(str)) {
    sanitized = `'${str}`;
  }
  if (sanitized.includes('"') || sanitized.includes(',') || sanitized.includes('\n') || sanitized.includes('\r')) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

/**
 * Exports a spreadsheet worksheet to sanitized CSV format.
 */
export function exportSpreadsheetToCsv(workbook: SpreadsheetWorkbook, targetSheetName?: string): string {
  const sheetName = targetSheetName || workbook.activeSheet || workbook.sheets[0]?.name;
  const sheet = workbook.sheets.find((s) => s.name === sheetName) || workbook.sheets[0];
  if (!sheet) return '';

  const cells = sheet.cells || {};
  let maxRow = sheet.rowCount || 1;
  let maxCol = sheet.colCount || 1;

  // Determine actual bounds from cell keys (e.g. A1, B10)
  for (const key of Object.keys(cells)) {
    const m = key.match(/^([A-Z]+)([0-9]+)$/);
    if (m) {
      const col = colLetterToIndex(m[1]);
      const row = parseInt(m[2], 10);
      if (col > maxCol) maxCol = col;
      if (row > maxRow) maxRow = row;
    }
  }

  const rows: string[] = [];
  for (let r = 1; r <= maxRow; r++) {
    const rowVals: string[] = [];
    for (let c = 1; c <= maxCol; c++) {
      const key = `${colIndexToLetter(c)}${r}`;
      const cell = cells[key];
      const val = cell?.computed !== undefined ? cell.computed : (cell?.raw ?? '');
      rowVals.push(sanitizeSpreadsheetCsvCell(val));
    }
    rows.push(rowVals.join(','));
  }
  return rows.join('\n');
}

export function colLetterToIndex(colStr: string): number {
  let result = 0;
  for (let i = 0; i < colStr.length; i++) {
    result = result * 26 + (colStr.charCodeAt(i) - 64);
  }
  return result;
}

export function colIndexToLetter(colIndex: number): string {
  let temp = colIndex;
  let letter = '';
  while (temp > 0) {
    const rem = (temp - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    temp = Math.floor((temp - 1) / 26);
  }
  return letter;
}

/**
 * Expands a range like "A1:A3" or "A1:B2" into an array of cell coordinates.
 */
export function expandCellRange(rangeStr: string): string[] {
  const parts = rangeStr.split(':');
  if (parts.length === 1) return [parts[0].trim().toUpperCase()];
  if (parts.length !== 2) return [];

  const m1 = parts[0].trim().toUpperCase().match(/^([A-Z]+)([0-9]+)$/);
  const m2 = parts[1].trim().toUpperCase().match(/^([A-Z]+)([0-9]+)$/);
  if (!m1 || !m2) return [];

  const col1 = colLetterToIndex(m1[1]);
  const row1 = parseInt(m1[2], 10);
  const col2 = colLetterToIndex(m2[1]);
  const row2 = parseInt(m2[2], 10);

  const startCol = Math.min(col1, col2);
  const endCol = Math.max(col1, col2);
  const startRow = Math.min(row1, row2);
  const endRow = Math.max(row1, row2);

  const result: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    for (let c = startCol; c <= endCol; c++) {
      result.push(`${colIndexToLetter(c)}${r}`);
    }
  }
  return result;
}

/**
 * Extracts all cell dependencies from a raw formula (e.g. "=A1+SUM(B1:B3)" -> ["A1", "B1", "B2", "B3"])
 */
export function extractFormulaDependencies(formula: string): string[] {
  if (!formula.startsWith('=')) return [];
  const text = formula.slice(1);
  const deps = new Set<string>();

  // Match ranges like A1:B10 first
  const rangeRegex = /\b([A-Z]+[0-9]+):([A-Z]+[0-9]+)\b/gi;
  let rm: RegExpExecArray | null;
  while ((rm = rangeRegex.exec(text)) !== null) {
    const expanded = expandCellRange(rm[0]);
    for (const c of expanded) deps.add(c);
  }

  // Match individual cells like A1
  const cellRegex = /\b([A-Z]+[0-9]+)\b/gi;
  let cm: RegExpExecArray | null;
  while ((cm = cellRegex.exec(text)) !== null) {
    // If followed by ':', it was part of a range
    const pos = cm.index + cm[0].length;
    if (text[pos] === ':' || (cm.index > 0 && text[cm.index - 1] === ':')) continue;
    deps.add(cm[0].toUpperCase());
  }

  return Array.from(deps);
}

/**
 * Deterministically evaluates a single spreadsheet formula without eval() or new Function().
 */
export function evaluateFormulaExpression(
  expression: string,
  getCellValue: (coord: string) => CellValue
): CellValue {
  let pos = 0;
  const s = expression.trim();

  function peek(): string {
    return s[pos] || '';
  }

  function skipWhitespace() {
    while (pos < s.length && /\s/.test(s[pos])) {
      pos++;
    }
  }

  function parsePrimary(): CellValue {
    skipWhitespace();
    if (pos >= s.length) return 0;

    // String literal "..."
    if (s[pos] === '"' || s[pos] === "'") {
      const quote = s[pos++];
      let str = '';
      while (pos < s.length && s[pos] !== quote) {
        if (s[pos] === '\\' && pos + 1 < s.length) {
          pos++;
        }
        str += s[pos++];
      }
      if (pos < s.length) pos++; // skip closing quote
      return str;
    }

    // Parenthesized sub-expression
    if (s[pos] === '(') {
      pos++; // consume '('
      const val = parseExpression();
      skipWhitespace();
      if (s[pos] === ')') pos++; // consume ')'
      return val;
    }

    // Unary plus/minus
    if (s[pos] === '-') {
      pos++;
      const val = parsePrimary();
      return typeof val === 'number' ? -val : '#VALUE!';
    }
    if (s[pos] === '+') {
      pos++;
      return parsePrimary();
    }

    // Number literal
    if (/[0-9.]/.test(s[pos])) {
      let numStr = '';
      while (pos < s.length && /[0-9.]/.test(s[pos])) {
        numStr += s[pos++];
      }
      const parsed = parseFloat(numStr);
      return isNaN(parsed) ? '#VALUE!' : parsed;
    }

    // Function call or cell coordinate or range or boolean
    if (/[A-Za-z]/.test(s[pos])) {
      let ident = '';
      while (pos < s.length && /[A-Za-z0-9_]/.test(s[pos])) {
        ident += s[pos++];
      }
      ident = ident.toUpperCase();

      skipWhitespace();

      // Function call: IDENT(...)
      if (peek() === '(') {
        pos++; // consume '('
        const args: (CellValue | CellValue[])[] = [];
        skipWhitespace();
        if (peek() !== ')') {
          while (pos < s.length) {
            skipWhitespace();
            // Check for range argument like A1:B10
            const rangeMatch = s.slice(pos).match(/^([A-Za-z]+[0-9]+):([A-Za-z]+[0-9]+)/);
            if (rangeMatch) {
              pos += rangeMatch[0].length;
              const cells = expandCellRange(rangeMatch[0]);
              const vals = cells.map((c) => getCellValue(c));
              args.push(vals);
            } else {
              args.push(parseExpression());
            }

            skipWhitespace();
            if (peek() === ',') {
              pos++; // consume ','
            } else {
              break;
            }
          }
        }
        if (peek() === ')') pos++; // consume ')'

        return evaluateFunction(ident, args);
      }

      // Boolean literals
      if (ident === 'TRUE') return true;
      if (ident === 'FALSE') return false;

      // Range outside function like A1:B2 (evaluate to first cell or array)
      if (peek() === ':') {
        pos++;
        let endCoord = '';
        while (pos < s.length && /[A-Za-z0-9]/.test(s[pos])) {
          endCoord += s[pos++];
        }
        return getCellValue(ident);
      }

      // Single Cell reference like A1
      return getCellValue(ident);
    }

    return '#VALUE!';
  }

  function evaluateFunction(name: string, rawArgs: (CellValue | CellValue[])[]): CellValue {
    // Flatten arguments for aggregate functions
    const flattenNumbers = (): number[] => {
      const numbers: number[] = [];
      for (const a of rawArgs) {
        if (Array.isArray(a)) {
          for (const item of a) {
            const n = typeof item === 'number' ? item : parseFloat(String(item));
            if (!isNaN(n)) numbers.push(n);
          }
        } else {
          const n = typeof a === 'number' ? a : parseFloat(String(a));
          if (!isNaN(n)) numbers.push(n);
        }
      }
      return numbers;
    };

    switch (name) {
      case 'SUM': {
        const nums = flattenNumbers();
        return nums.reduce((sum, v) => sum + v, 0);
      }
      case 'AVERAGE': {
        const nums = flattenNumbers();
        if (nums.length === 0) return '#DIV/0!';
        return nums.reduce((sum, v) => sum + v, 0) / nums.length;
      }
      case 'MAX': {
        const nums = flattenNumbers();
        return nums.length === 0 ? 0 : Math.max(...nums);
      }
      case 'MIN': {
        const nums = flattenNumbers();
        return nums.length === 0 ? 0 : Math.min(...nums);
      }
      case 'COUNT': {
        const nums = flattenNumbers();
        return nums.length;
      }
      case 'PRODUCT': {
        const nums = flattenNumbers();
        return nums.length === 0 ? 0 : nums.reduce((p, v) => p * v, 1);
      }
      case 'ABS': {
        const v = rawArgs[0];
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        return isNaN(n) ? '#VALUE!' : Math.abs(n);
      }
      case 'ROUND': {
        const v = rawArgs[0];
        const decimals = (rawArgs[1] !== undefined ? Number(rawArgs[1]) : 0) || 0;
        const n = typeof v === 'number' ? v : parseFloat(String(v));
        if (isNaN(n)) return '#VALUE!';
        const f = Math.pow(10, decimals);
        return Math.round(n * f) / f;
      }
      case 'IF': {
        const cond = rawArgs[0];
        const isTrue = cond === true || (typeof cond === 'number' && cond !== 0) || (typeof cond === 'string' && cond.length > 0 && cond !== 'false' && cond !== '0');
        return isTrue ? (rawArgs[1] as CellValue) : (rawArgs[2] as CellValue);
      }
      case 'CONCAT': {
        let str = '';
        for (const a of rawArgs) {
          if (Array.isArray(a)) {
            str += a.join('');
          } else {
            str += String(a);
          }
        }
        return str;
      }
      default:
        return '#NAME?';
    }
  }

function isErrorCode(val: unknown): boolean {
  return typeof val === 'string' && val.startsWith('#') && val.endsWith('!');
}

  function parseFactor(): CellValue {
    let left = parsePrimary();
    if (isErrorCode(left)) return left;
    skipWhitespace();
    while (peek() === '^') {
      pos++;
      const right = parsePrimary();
      if (isErrorCode(right)) return right;
      if (typeof left === 'number' && typeof right === 'number') {
        left = Math.pow(left, right);
      } else {
        return '#VALUE!';
      }
      skipWhitespace();
    }
    return left;
  }

  function parseTerm(): CellValue {
    let left = parseFactor();
    if (isErrorCode(left)) return left;
    skipWhitespace();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = s[pos++];
      const right = parseFactor();
      if (isErrorCode(right)) return right;
      if (typeof left === 'number' && typeof right === 'number') {
        if (op === '*') left = left * right;
        else if (op === '/') {
          if (right === 0) return '#DIV/0!';
          left = left / right;
        } else if (op === '%') {
          if (right === 0) return '#DIV/0!';
          left = left % right;
        }
      } else {
        return '#VALUE!';
      }
      skipWhitespace();
    }
    return left;
  }

  function parseAdditive(): CellValue {
    let left = parseTerm();
    if (isErrorCode(left)) return left;
    skipWhitespace();
    while (peek() === '+' || peek() === '-') {
      const op = s[pos++];
      const right = parseTerm();
      if (isErrorCode(right)) return right;
      if (typeof left === 'number' && typeof right === 'number') {
        if (op === '+') left = left + right;
        else left = left - right;
      } else if (typeof left === 'string' || typeof right === 'string') {
        if (op === '+') left = `${left}${right}`;
        else return '#VALUE!';
      } else {
        return '#VALUE!';
      }
      skipWhitespace();
    }
    return left;
  }

  function parseComparison(): CellValue {
    let left = parseAdditive();
    if (isErrorCode(left)) return left;
    skipWhitespace();
    const remaining = s.slice(pos);

    if (remaining.startsWith('>=') || remaining.startsWith('<=') || remaining.startsWith('<>') || remaining.startsWith('!=') || remaining.startsWith('==')) {
      const op = remaining.slice(0, 2);
      pos += 2;
      const right = parseAdditive();
      if (isErrorCode(right)) return right;
      if (op === '>=') return Number(left) >= Number(right);
      if (op === '<=') return Number(left) <= Number(right);
      if (op === '<>' || op === '!=') return left !== right;
      if (op === '==') return left === right;
    } else if (remaining.startsWith('>') || remaining.startsWith('<') || remaining.startsWith('=')) {
      const op = remaining[0];
      pos += 1;
      const right = parseAdditive();
      if (isErrorCode(right)) return right;
      if (op === '>') return Number(left) > Number(right);
      if (op === '<') return Number(left) < Number(right);
      if (op === '=') return left === right;
    }

    return left;
  }

  function parseExpression(): CellValue {
    return parseComparison();
  }

  return parseExpression();
}

/**
 * Evaluates a single cell given its raw value and access to resolved dependency values.
 */
export function evaluateSpreadsheetCell(
  raw: string,
  getCellValue: (coord: string) => CellValue
): CellValue {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('=')) {
    const num = parseFloat(trimmed);
    if (!isNaN(num) && /^-?[0-9]+(\.[0-9]+)?$/.test(trimmed)) {
      return num;
    }
    return raw;
  }
  return evaluateFormulaExpression(trimmed.slice(1), getCellValue);
}

/**
 * Topologically recalculates all cells across worksheets in a workbook.
 * Detects cycles and resolves dependent calculations deterministically.
 */
export function recalculateSpreadsheet(workbook: SpreadsheetWorkbook): SpreadsheetWorkbook {
  const nextSheets: SpreadsheetWorksheet[] = [];

  for (const sheet of workbook.sheets) {
    const cells = { ...(sheet.cells || {}) };
    const computedValues: Record<string, CellValue> = {};
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const getCellValue = (coord: string): CellValue => {
      const key = coord.toUpperCase();
      if (computedValues[key] !== undefined) {
        return computedValues[key];
      }
      const cell = cells[key];
      if (!cell || cell.raw === undefined || cell.raw === '') {
        return 0;
      }
      computeCell(key);
      return computedValues[key] !== undefined ? computedValues[key] : 0;
    };

    const computeCell = (key: string): CellValue => {
      if (visited.has(key)) return computedValues[key];
      if (visiting.has(key)) {
        computedValues[key] = '#CYCLE!';
        return '#CYCLE!';
      }

      const cell = cells[key];
      if (!cell || cell.raw === undefined) {
        computedValues[key] = 0;
        visited.add(key);
        return 0;
      }

      const raw = String(cell.raw).trim();
      if (!raw.startsWith('=')) {
        const num = parseFloat(raw);
        const val = !isNaN(num) && /^-?[0-9]+(\.[0-9]+)?$/.test(raw) ? num : raw;
        computedValues[key] = val;
        visited.add(key);
        return val;
      }

      visiting.add(key);
      const val = evaluateFormulaExpression(raw.slice(1), (coord) => {
        return getCellValue(coord);
      });
      visiting.delete(key);
      visited.add(key);

      // Propagate cycle marker
      if (visiting.size > 0 && val === '#CYCLE!') {
        computedValues[key] = '#CYCLE!';
      } else {
        computedValues[key] = val;
      }
      return computedValues[key];
    };

    // Calculate all cells
    for (const key of Object.keys(cells)) {
      computeCell(key);
    }

    const updatedCells: Record<string, { raw: string; computed: CellValue; format?: string }> = {};
    for (const [key, cell] of Object.entries(cells)) {
      updatedCells[key] = {
        raw: cell.raw,
        computed: computedValues[key] !== undefined ? computedValues[key] : (cell.computed ?? ''),
        format: cell.format,
      };
    }

    nextSheets.push({
      ...sheet,
      cells: updatedCells,
    });
  }

  return {
    ...workbook,
    sheets: nextSheets,
  };
}

/**
 * Safely parses a spreadsheet workbook JSON payload, falling back to a default workbook if invalid.
 */
export function parseSpreadsheetWorkbook(content: string, title = 'Workbook'): SpreadsheetWorkbook {
  try {
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.sheets) && parsed.sheets.length > 0) return parsed;
  } catch {}
  return {
    activeSheet: 'Sheet1',
    sheets: [
      {
        name: 'Sheet1',
        rowCount: 20,
        colCount: 10,
        cells: { A1: { raw: title || 'Title', computed: title || 'Title' } },
      },
    ],
  };
}

