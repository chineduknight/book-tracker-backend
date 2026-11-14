/** A strict RFC 4180 reader for tests: records end with CRLF, quotes escape by doubling. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') inQuotes = false;
      else field += character;
    } else if (character === '"') inQuotes = true;
    else if (character === ',') {
      record.push(field);
      field = '';
    } else if (character === '\r' && text[index + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 1;
    } else field += character;
  }
  if (inQuotes || field !== '' || record.length > 0) throw new Error('CSV does not end with CRLF');
  return records;
}

export interface MarkdownStructure {
  /** Lines outside fenced code blocks, which a renderer would interpret. */
  interpretedLines: string[];
  /** The verbatim contents of each fenced code block, in order. */
  codeBlocks: string[];
}

/** Splits Markdown the way a CommonMark renderer does for backtick fences. */
export function markdownStructure(text: string): MarkdownStructure {
  const interpretedLines: string[] = [];
  const codeBlocks: string[] = [];
  let fence: string | null = null;
  let block: string[] = [];
  for (const line of text.split('\n')) {
    if (fence === null) {
      const opening = /^(`{3,})/.exec(line);
      if (opening?.[1]) {
        fence = opening[1];
        block = [];
      } else interpretedLines.push(line);
    } else if (
      line.startsWith(fence) &&
      /^`+\s*$/.test(line) &&
      line.trim().length >= fence.length
    ) {
      codeBlocks.push(block.join('\n'));
      fence = null;
    } else block.push(line);
  }
  if (fence !== null) throw new Error('unclosed code block');
  return { interpretedLines, codeBlocks };
}
