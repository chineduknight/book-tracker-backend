import type { ArchivedBookTitle } from '../books/book.service.js';
import type { NoteExportDto } from '../notes/note.dto.js';

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
const LINE_BREAKS = /\r\n|\r|\n/g;
const BACKTICK_RUNS = /`+/g;

/**
 * User text for one line of Markdown: line breaks become spaces and every ASCII punctuation
 * character is backslash-escaped, so headings, lists, links, emphasis and raw HTML stay literal.
 */
export function toMarkdownInline(text: string): string {
  return text.replace(LINE_BREAKS, ' ').replace(ASCII_PUNCTUATION, '\\$&');
}

/**
 * User text as a fenced code block, shown verbatim and never interpreted. The fence is longer
 * than any run of backticks in the text, so nothing inside can close it.
 */
export function toMarkdownCodeBlock(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...text.matchAll(BACKTICK_RUNS)].map(([run]) => run.length),
  );
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}text\n${text}\n${fence}\n`;
}

export function notesDocumentHeader(exportedAt: string, entries: number): string {
  const summary = entries === 0 ? '\nNo notes or highlights yet.\n' : '';
  return (
    [
      '# Book Tracker notes and highlights',
      '',
      `- Exported at: ${exportedAt}`,
      `- Entries: ${entries}`,
      '',
    ].join('\n') + summary
  );
}

function bookLine(bookId: string, book: ArchivedBookTitle | undefined): string {
  if (!book) return `- Book: \`${bookId}\``;
  const deleted = book.isDeleted ? ' (deleted)' : '';
  return `- Book: ${toMarkdownInline(book.title)}${deleted} (\`${bookId}\`)`;
}

/** One note or highlight; `book` is the owner's own book, when it exists. */
export function noteSection(
  note: NoteExportDto,
  position: number,
  book: ArchivedBookTitle | undefined,
): string {
  const kind = note.kind === 'note' ? 'Note' : 'Highlight';
  const metadata = [
    `- Note id: \`${note.id}\``,
    bookLine(note.bookId, book),
    ...(note.readingSessionId === null ? [] : [`- Reading session: \`${note.readingSessionId}\``]),
    ...(note.title === undefined ? [] : [`- Title: ${toMarkdownInline(note.title)}`]),
    ...(note.chapter === undefined ? [] : [`- Chapter: ${toMarkdownInline(note.chapter)}`]),
    ...(note.pageNumber === undefined ? [] : [`- Page: ${note.pageNumber}`]),
    `- Created: ${note.createdAt}`,
    `- Updated: ${note.updatedAt}`,
    `- Deleted: ${note.deletedAt === null ? 'no' : `yes, ${note.deletedAt}`}`,
  ];
  const commentary =
    note.commentary === undefined
      ? ''
      : `\n**Commentary**\n\n${toMarkdownCodeBlock(note.commentary)}`;
  return (
    [
      '',
      `## ${position}. ${kind}`,
      '',
      ...metadata,
      '',
      '**Content**',
      '',
      toMarkdownCodeBlock(note.content),
    ].join('\n') + commentary
  );
}
