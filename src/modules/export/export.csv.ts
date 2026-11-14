export type CsvValue = string | number | null | undefined;

const CSV_RECORD_SEPARATOR = '\r\n';
const NEEDS_QUOTES = /[",\r\n]/;

/*
 * Spreadsheets evaluate a cell that starts with =, +, - or @ (also after leading whitespace or
 * control characters) or with a tab or carriage return as a formula. Such cells get a leading
 * apostrophe in the CSV only; the stored data and the JSON archive keep the original text.
 */
const FORMULA_TRIGGER = /^(?:[\t\r]|[\s\p{Cc}]*[=+\-@])/u;

function neutralizeFormula(text: string): string {
  return FORMULA_TRIGGER.test(text) ? `'${text}` : text;
}

/** One RFC 4180 field: empty for missing values, quoted when it holds quotes, commas or breaks. */
export function toCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  const text = neutralizeFormula(value);
  return NEEDS_QUOTES.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsvRecord(values: readonly CsvValue[]): string {
  return values.map(toCsvField).join(',') + CSV_RECORD_SEPARATOR;
}
