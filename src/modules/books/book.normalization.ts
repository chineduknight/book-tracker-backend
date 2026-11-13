import { toCaseInsensitiveKey } from '../../shared/text.js';

export function normalizeTitleForMatching(title: string): string {
  return toCaseInsensitiveKey(title);
}

export function normalizeIsbnForMatching(isbn: string): string {
  return isbn.replace(/[\s-]/g, '').toUpperCase();
}
