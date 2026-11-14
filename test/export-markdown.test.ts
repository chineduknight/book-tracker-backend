import { describe, expect, it } from 'vitest';
import {
  noteSection,
  notesDocumentHeader,
  toMarkdownCodeBlock,
  toMarkdownInline,
} from '../src/modules/export/export.markdown.js';
import type { NoteExportDto } from '../src/modules/notes/note.dto.js';
import { markdownStructure } from './export-formats.js';

const NOTE: NoteExportDto = {
  id: '64b7f0c2a1b2c3d4e5f60718',
  bookId: '64b7f0c2a1b2c3d4e5f60719',
  readingSessionId: null,
  kind: 'note',
  content: 'Body',
  createdAt: '2026-11-14T10:00:00.000Z',
  updatedAt: '2026-11-14T10:00:00.000Z',
  deletedAt: null,
};

describe('toMarkdownInline', () => {
  it('escapes every ASCII punctuation character and flattens line breaks', () => {
    expect(toMarkdownInline('# Title | <b>x</b> [a](b)\r\nnext')).toBe(
      '\\# Title \\| \\<b\\>x\\<\\/b\\> \\[a\\]\\(b\\) next',
    );
    expect(toMarkdownInline('Café — 紅樓夢')).toBe('Café — 紅樓夢');
  });
});

describe('toMarkdownCodeBlock', () => {
  it.each([
    ['no backticks', 'plain', '```'],
    ['a triple run', '```\ncode\n```', '````'],
    ['a long run', 'x `````` y', '```````'],
  ])('uses a fence longer than any backtick run for %s', (_label, text, fence) => {
    const block = toMarkdownCodeBlock(text);

    expect(block.startsWith(`${fence}text\n`)).toBe(true);
    expect(markdownStructure(block).codeBlocks).toEqual([text]);
  });
});

describe('notes document', () => {
  it('states the export time and entry count, and an empty state', () => {
    expect(notesDocumentHeader('2026-11-14T10:00:00.000Z', 0)).toBe(
      '# Book Tracker notes and highlights\n\n- Exported at: 2026-11-14T10:00:00.000Z\n- Entries: 0\n\nNo notes or highlights yet.\n',
    );
    expect(notesDocumentHeader('2026-11-14T10:00:00.000Z', 2)).not.toContain('No notes');
  });

  it('shows the book id when the book is not one of the reader’s', () => {
    expect(noteSection(NOTE, 1, undefined)).toContain('- Book: `64b7f0c2a1b2c3d4e5f60719`');
  });

  it('marks deleted notes and deleted books and omits unset metadata', () => {
    const section = noteSection(
      { ...NOTE, kind: 'highlight', deletedAt: '2026-11-15T00:00:00.000Z' },
      2,
      { bookId: NOTE.bookId, title: 'Dune', isDeleted: true },
    );

    expect(section).toContain('## 2. Highlight');
    expect(section).toContain('- Book: Dune (deleted) (`64b7f0c2a1b2c3d4e5f60719`)');
    expect(section).toContain('- Deleted: yes, 2026-11-15T00:00:00.000Z');
    expect(section).not.toContain('Reading session');
    expect(section).not.toContain('Commentary');
  });
});
