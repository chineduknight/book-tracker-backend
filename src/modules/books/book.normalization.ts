export function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function normalizeTitleForMatching(title: string): string {
  return collapseWhitespace(title).normalize('NFC').toLowerCase();
}

export function normalizeIsbnForMatching(isbn: string): string {
  return isbn.replace(/[\s-]/g, '').toUpperCase();
}

// Quotes and hyphens are MongoDB $text phrase and negation operators; searches use plain words.
export function toTextSearchWords(searchText: string): string {
  return collapseWhitespace(searchText.replace(/["-]/g, ' '));
}

export function containsLetterOrDigit(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}
