import { AppError } from '../../shared/errors.js';

/** Operational guards for one download in V1, not a promise to export libraries of any size. */
export interface ExportLimits {
  maxRecords: number;
  maxBytes: number;
}

export const EXPORT_LIMITS: ExportLimits = {
  maxRecords: 20_000,
  maxBytes: 32 * 1024 * 1024,
};

export function exportTooLargeError(): AppError {
  return new AppError(
    413,
    'EXPORT_TOO_LARGE',
    'This export is larger than a single download allows; please contact support',
  );
}

/**
 * Collects a download in memory while checking both limits on every write, so an oversized
 * export stops as soon as it crosses a limit and is never sent, partially or otherwise.
 */
export class BoundedExportWriter {
  readonly #limits: ExportLimits;
  readonly #chunks: string[] = [];
  #bytes = 0;
  #records = 0;

  constructor(limits: ExportLimits) {
    this.#limits = limits;
  }

  get records(): number {
    return this.#records;
  }

  countRecord(): void {
    this.#records += 1;
    if (this.#records > this.#limits.maxRecords) throw exportTooLargeError();
  }

  write(text: string): void {
    this.#addBytes(text);
    this.#chunks.push(text);
  }

  /** Adds text in front, for headers that depend on what was written after them. */
  prepend(text: string): void {
    this.#addBytes(text);
    this.#chunks.unshift(text);
  }

  toString(): string {
    return this.#chunks.join('');
  }

  #addBytes(text: string): void {
    this.#bytes += Buffer.byteLength(text, 'utf8');
    if (this.#bytes > this.#limits.maxBytes) throw exportTooLargeError();
  }
}
