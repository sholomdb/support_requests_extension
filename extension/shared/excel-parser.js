import { normalizeText, normalizeCity, excelDateToString, normalizeIdNumber, normalizeBirthDate } from './utils.js';

/** Column letters → field names (row 6 = headers, data from row 7) */
const COLUMN_MAP = {
  A: 'budgetType',
  B: 'city',
  C: 'idNumber',
  E: 'lastName',
  F: 'firstName',
  G: 'gender',
  H: 'sector',
  I: 'maritalStatus',
  J: 'householdSize',
  K: 'birthCountry',
  L: 'birthDate',
  M: 'holocaustSurvivor',
  N: 'phone',
  O: 'street',
  P: 'building',
  Q: 'settlement',
  R: 'item',
  S: 'itemCategory',
  T: 'amount',
  U: 'justification',
  V: 'cardNumber1',
};

const HEADER_ROW = 6;
const DATA_START_ROW = 7;

function cellRef(col, row) {
  return `${col}${row}`;
}

function getCellValue(sheet, col, row) {
  const cell = sheet[cellRef(col, row)];
  if (!cell) return '';
  if (cell.w !== undefined) return normalizeText(cell.w);
  if (cell.v !== undefined) return normalizeText(cell.v);
  return '';
}

function parseRow(sheet, rowIndex, excelRowNum) {
  const row = {};
  for (const [col, field] of Object.entries(COLUMN_MAP)) {
    row[field] = getCellValue(sheet, col, excelRowNum);
  }

  if (!row.idNumber) return null;

  row.rowIndex = rowIndex;
  row.excelRow = excelRowNum;
  row.city = normalizeCity(row.city);
  row.idNumber = normalizeIdNumber(row.idNumber);
  row.amount = Number(String(row.amount).replace(/[^\d.-]/g, '')) || 0;
  row.birthDate = normalizeBirthDate(row.birthDate);
  row.budgetType = normalizeText(row.budgetType);
  row.item = normalizeText(row.item);
  row.itemCategory = normalizeText(row.itemCategory);

  return row;
}

/**
 * Parse workbook ArrayBuffer from uploaded .xlsx file.
 * Returns { rows, city, totalAmount, fileName }
 */
export function parseExcelBuffer(arrayBuffer, fileName = '') {
  const workbook = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    throw new Error('לא נמצא גיליון בקובץ');
  }

  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
  const rows = [];
  let dataIndex = 0;

  for (let r = DATA_START_ROW; r <= range.e.r + 1; r++) {
    const parsed = parseRow(sheet, dataIndex, r);
    if (parsed) {
      rows.push(parsed);
      dataIndex += 1;
    }
  }

  if (rows.length === 0) {
    throw new Error(`לא נמצאו שורות נתונים (שורה ${DATA_START_ROW}+ עם ת.ז.)`);
  }

  const cities = [...new Set(rows.map((row) => row.city))];
  const city = cities.length === 1 ? cities[0] : cities.join(', ');

  if (cities.length > 1) {
    console.warn('Multiple cities in file:', cities);
  }

  const totalAmount = rows.reduce((sum, row) => sum + row.amount, 0);

  return {
    rows,
    city: cities.length === 1 ? cities[0] : null,
    cities,
    totalAmount,
    fileName,
    parsedAt: new Date().toISOString(),
  };
}

export { HEADER_ROW, DATA_START_ROW, COLUMN_MAP };
