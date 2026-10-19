/**
 * One CSV cell, RFC 4180 quoted and safe to open in a spreadsheet. Shared by the
 * server report exports and the client list exports so both behave the same.
 *
 * Spreadsheets execute cells that start with `=`, `+`, `-`, `@` (and treat a
 * leading tab or carriage return as a prefix to one). Bank descriptions, memos
 * and contact names are chosen by outsiders, so such cells are prefixed with an
 * apostrophe, which Excel, LibreOffice and Numbers all show as literal text.
 * Plain numbers (including negatives such as "-12.50") are left alone.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
