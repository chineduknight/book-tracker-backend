import { collapseWhitespace, toCaseInsensitiveKey } from '../../shared/text.js';

export function normalizeTitleForMatching(title: string): string {
  return toCaseInsensitiveKey(title);
}

export function normalizeIsbnForMatching(isbn: string): string {
  return isbn.replace(/[\s-]/g, '').toUpperCase();
}

// Quotes and hyphens are MongoDB $text phrase and negation operators; searches use plain words.
export function toTextSearchWords(searchText: string): string {
  return collapseWhitespace(searchText.replace(/["-]/g, ' '));
}
