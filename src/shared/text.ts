export function collapseWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

export function toCaseInsensitiveKey(text: string): string {
  return collapseWhitespace(text).normalize('NFC').toLowerCase();
}

export function containsLetterOrDigit(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

// Quotes and hyphens are MongoDB $text phrase and negation operators; searches use plain words.
export function toTextSearchWords(searchText: string): string {
  return collapseWhitespace(searchText.replace(/["-]/g, ' '));
}
