/**
 * Read-only starter suggestions in a fixed order. They are never stored: a reader materializes a
 * category only through an explicit create, and the list never depends on the account's data.
 */
export const CATEGORY_PRESET_NAMES: readonly string[] = [
  'Fiction',
  'Nonfiction',
  'Biography',
  'History',
  'Philosophy',
  'Psychology',
  'Science',
  'Technology',
  'Religion',
  'Personal Development',
];
