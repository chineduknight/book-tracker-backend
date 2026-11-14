import { describe, expect, it } from 'vitest';
import { NoteModel } from '../../src/modules/notes/note.model.js';
import { markdownStructure, parseCsv } from '../export-formats.js';
import { createAuthTestApp } from './auth-fixtures.js';
import { addBook } from './book-fixtures.js';
import { addRichLibrary, archiveFrom } from './export-fixtures.js';
import { addNote, addPhysicalBook, signInLibraryReader } from './library-fixtures.js';

const BOOK_COLUMNS =
  'id,title,authors,format,isbn,edition,description,coverUrl,pageCount,chapterCount,publicationYear,createdAt,updatedAt,deletedAt';
const SESSION_COLUMNS =
  'id,bookId,status,progressUnit,progressValue,startedOn,completedOn,rating,summary,createdAt,updatedAt';
const LOAN_COLUMNS =
  'id,copyId,bookId,borrowerName,borrowerContact,lentOn,dueOn,returnedOn,note,createdAt,updatedAt';

function expectDownload(
  res: { status: number; headers: Record<string, string> },
  contentType: string,
  filename: RegExp,
) {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe(contentType);
  expect(res.headers['content-disposition']).toMatch(filename);
  expect(res.headers['cache-control']).toBe('no-store');
}

describe('CSV exports', () => {
  it('send only the header line for a new reader', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const books = await reader.exports.booksCsv();
    const sessions = await reader.exports.readingSessionsCsv();
    const loans = await reader.exports.loansCsv();

    expectDownload(
      books,
      'text/csv; charset=utf-8',
      /filename="book-tracker-books-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expectDownload(
      sessions,
      'text/csv; charset=utf-8',
      /filename="book-tracker-reading-sessions-[\d-]+\.csv"$/,
    );
    expectDownload(loans, 'text/csv; charset=utf-8', /filename="book-tracker-loans-[\d-]+\.csv"$/);
    expect(books.text).toBe(`${BOOK_COLUMNS}\r\n`);
    expect(sessions.text).toBe(`${SESSION_COLUMNS}\r\n`);
    expect(loans.text).toBe(`${LOAN_COLUMNS}\r\n`);
  });

  it('write one RFC 4180 record per book, deleted ones included, with quoting and JSON authors', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const library = await addRichLibrary(reader);
    await reader.books.remove(library.ebook.id);

    const res = await reader.exports.booksCsv();
    const archive = archiveFrom(await reader.exports.archive());

    const [header, ...rows] = parseCsv(res.text);
    expect(header?.join(',')).toBe(BOOK_COLUMNS);
    expect(rows).toHaveLength(archive.books.length);
    expect(rows.map((row) => row[0])).toEqual(archive.books.map((book) => book.id));
    expect(rows[0]).toEqual([
      library.paper.id,
      'Café "Society", part 1',
      '["Ana Ñúñez","Bo \\"B\\" Lee"]',
      'physical',
      '978-0-441-47812-5',
      '',
      'Line one\nLine two — ünïcödé',
      '',
      '310',
      '12',
      '1969',
      archive.books[0]?.createdAt,
      archive.books[0]?.updatedAt,
      '',
    ]);
    expect(rows[1]?.[13]).toBe(archive.books[1]?.deletedAt);
    expect(res.text).toContain('"Café ""Society"", part 1"');
  });

  it('neutralizes spreadsheet formulas in cells only, leaving the archive unchanged', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const titles = [
      '=HYPERLINK("x")',
      '+1+1',
      '-2',
      '@SUM(A1)',
      '  =1+1',
      '\t=cmd',
      'Plain - title',
    ];
    for (const title of titles)
      await addBook(reader.books, { title, format: 'ebook', description: '=evil' });

    const [, ...rows] = parseCsv((await reader.exports.booksCsv()).text);
    const archive = archiveFrom(await reader.exports.archive());

    expect(rows.map((row) => row[1])).toEqual([
      `'=HYPERLINK("x")`,
      "'+1+1",
      "'-2",
      "'@SUM(A1)",
      "'=1+1",
      "'=cmd",
      'Plain - title',
    ]);
    expect(rows.every((row) => row[6] === "'=evil")).toBe(true);
    for (const row of rows) {
      for (const cell of row) expect(cell).not.toMatch(/^[\s\p{Cc}]*[=+\-@]/u);
    }
    expect(archive.books.map((book) => book.title)).toEqual(titles.map((title) => title.trim()));
  });

  it('exports reading sessions, deleted books included, with empty progress when none', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const library = await addRichLibrary(reader);
    await reader.books.remove(library.paper.id);

    const [header, ...rows] = parseCsv((await reader.exports.readingSessionsCsv()).text);

    expect(header?.join(',')).toBe(SESSION_COLUMNS);
    expect(rows.map((row) => row.slice(0, 9))).toEqual([
      [
        library.firstRead.id,
        library.paper.id,
        'completed',
        '',
        '',
        '2025-12-31',
        '2026-01-02',
        '5',
        'Loved it',
      ],
      [library.reread.id, library.paper.id, 'in_progress', 'pages', '42', '', '', '', ''],
    ]);
  });

  it('exports every loan with borrower details, empty returnedOn while active', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const library = await addRichLibrary(reader);
    await reader.books.remove(library.paper.id);

    const [header, ...rows] = parseCsv((await reader.exports.loansCsv()).text);

    expect(header?.join(',')).toBe(LOAN_COLUMNS);
    expect(rows.map((row) => row.slice(0, 9))).toEqual([
      [
        library.activeLoan.id,
        library.hardback.id,
        library.paper.id,
        'Ada Okafor',
        "'+234 800 000 0000",
        '2026-01-01',
        '2026-01-10',
        '',
        '',
      ],
      [
        library.returnedLoan.id,
        library.paperback.id,
        library.paper.id,
        'Bode',
        '',
        '2025-12-01',
        '',
        '2025-12-20',
        '',
      ],
    ]);
  });
});

describe('GET /api/v1/export/notes.md', () => {
  it('sends a short valid document for a reader without notes', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());

    const res = await reader.exports.notesMarkdown();

    expectDownload(
      res,
      'text/markdown; charset=utf-8',
      /filename="book-tracker-notes-[\d-]+\.md"$/,
    );
    expect(res.text).toMatch(
      /^# Book Tracker notes and highlights\n\n- Exported at: \S+\n- Entries: 0\n/,
    );
    expect(res.text).toContain('No notes or highlights yet.');
  });

  it('keeps every note verbatim inside fences that hostile content cannot break', async () => {
    const reader = await signInLibraryReader(createAuthTestApp());
    const book = await addPhysicalBook(reader, '# Not a | heading <b>');
    const hostile = [
      '```\n# injected heading\n```',
      '`````` six\n<script>alert(1)</script>\n````',
      '## Fake section\n\n<img src=x onerror=alert(1)>\n\n| a | b |',
      'Ὀδύσσεια — 《紅樓夢》 — مرحبا 🎉',
    ];
    for (const [index, content] of hostile.entries()) {
      await addNote(reader, book.id, {
        kind: index % 2 === 0 ? 'note' : 'highlight',
        content,
        title: `## title ${index} <i>`,
        chapter: '[link](http://example.test)',
        commentary: index === 1 ? '```commentary```' : undefined,
      });
    }

    const markdown = (await reader.exports.notesMarkdown()).text;
    const { interpretedLines, codeBlocks } = markdownStructure(markdown);

    expect(codeBlocks).toEqual([
      hostile[0],
      hostile[1],
      '```commentary```',
      hostile[2],
      hostile[3],
    ]);
    const headings = interpretedLines.filter((line) => line.startsWith('#'));
    expect(headings).toEqual([
      '# Book Tracker notes and highlights',
      '## 1. Note',
      '## 2. Highlight',
      '## 3. Note',
      '## 4. Highlight',
    ]);
    for (const line of interpretedLines) {
      expect(line).not.toMatch(/(^|[^\\])[<>]/);
      expect(line).not.toMatch(/(^|[^\\])\[/);
    }
    expect(markdown).toContain('- Entries: 4');
    expect(markdown).toContain('- Book: \\# Not a \\| heading \\<b\\> (`');
  });

  it('includes metadata, deleted notes and notes of deleted books, never a foreign book title', async () => {
    const app = createAuthTestApp();
    const reader = await signInLibraryReader(app);
    const other = await signInLibraryReader(app);
    const library = await addRichLibrary(reader);
    const foreignBook = await addPhysicalBook(other, 'Foreign Secret Title');
    await NoteModel.create({
      ownerId: reader.userId,
      bookId: foreignBook.id,
      kind: 'note',
      content: 'planted',
    });
    await reader.notes.remove(library.highlight.id);
    await reader.books.remove(library.paper.id);

    const markdown = (await reader.exports.notesMarkdown()).text;

    expect(markdown).toContain('- Entries: 3');
    expect(markdown).toContain(`- Note id: \`${library.note.id}\``);
    expect(markdown).toContain(`- Reading session: \`${library.reread.id}\``);
    expect(markdown).toContain('Society\\"\\, part 1 (deleted)');
    expect(markdown).toMatch(/- Deleted: yes, \d{4}-/);
    expect(markdown).toContain('- Chapter: Chapter 1');
    expect(markdown).toContain('- Page: 8');
    expect(markdown).toContain('**Commentary**');
    expect(markdown).toContain(`- Book: \`${foreignBook.id}\``);
    expect(markdown).not.toContain('Foreign Secret Title');
    expect(markdownStructure(markdown).codeBlocks).toContain('# Thoughts\n\n- *on* rereading');
  });
});
