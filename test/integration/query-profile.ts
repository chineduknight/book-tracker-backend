import mongoose from 'mongoose';

/** One database operation as MongoDB's profiler recorded it. */
export interface ProfiledOperation {
  op: string;
  collection: string;
  planSummary: string;
  keysExamined: number;
  docsExamined: number;
  nreturned: number;
  hasSortStage: boolean;
}

interface ProfileEntry {
  op: string;
  ns: string;
  command?: Record<string, unknown>;
  planSummary?: string;
  keysExamined?: number;
  docsExamined?: number;
  nreturned?: number;
  hasSortStage?: boolean;
}

function databaseOf(connection: mongoose.Connection) {
  const { db } = connection;
  if (!db) throw new Error('the test database is not connected');
  return db;
}

/*
 * Records every operation `run` sends to the test database with the profiler (level 2), which sees
 * exactly the queries the services issue, so nothing has to be re-written in the test.
 */
export async function profileOperations(run: () => Promise<unknown>): Promise<ProfiledOperation[]> {
  const db = databaseOf(mongoose.connection);
  await db.command({ profile: 0 });
  await db.dropCollection('system.profile').catch(() => undefined);
  await db.command({ profile: 2 });
  try {
    await run();
  } finally {
    await db.command({ profile: 0 });
  }
  const entries = await db
    .collection<ProfileEntry>('system.profile')
    .find({
      ns: { $not: /\.system\./ },
      op: { $in: ['query', 'command', 'getmore'] },
      'command.killCursors': { $exists: false },
    })
    .sort({ ts: 1 })
    .toArray();
  return entries.map((entry) => ({
    op: entry.op,
    collection: entry.ns.slice(entry.ns.indexOf('.') + 1),
    planSummary: entry.planSummary ?? '',
    keysExamined: entry.keysExamined ?? 0,
    docsExamined: entry.docsExamined ?? 0,
    nreturned: entry.nreturned ?? 0,
    hasSortStage: entry.hasSortStage ?? false,
  }));
}
