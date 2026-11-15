export interface ClosableCursor<Row> extends AsyncIterable<Row> {
  close(): Promise<unknown>;
}

/**
 * Yields every row of a database cursor and closes the cursor however iteration ends. A Mongoose
 * cursor's async iterator has no `return()`, so a `for await` that stops early (an export reaching
 * its limit) would otherwise leave the server-side cursor, and any sorted result it holds, open
 * until MongoDB's idle timeout.
 */
export async function* closingWhenDone<Row>(cursor: ClosableCursor<Row>): AsyncGenerator<Row> {
  try {
    for await (const row of cursor) yield row;
  } finally {
    await cursor.close();
  }
}
