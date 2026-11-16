import mongoose from 'mongoose';
import { connectionOptionsFor } from '../src/db/mongo.js';
import {
  blockingDiscrepanciesOf,
  inspectIndexes,
  type IndexReport,
} from '../src/db/index-verification.js';
import { formatSafeError } from '../src/shared/safe-error.js';
import { buildMissingIndexes, ConflictingIndexesError } from './indexes/build-missing-indexes.js';

/*
 * Operator tool for MongoDB indexes; see docs/index-operations.md.
 *   npm run db:indexes                                        read-only check (default)
 *   npm run db:indexes -- --apply --confirm-database=<name>   build missing indexes only
 * It reads MONGODB_URI from the environment, never from .env, and never prints it.
 */

class UsageError extends Error {
  override readonly name = 'UsageError';
}

interface Command {
  apply: boolean;
  confirmedDatabase: string | undefined;
}

function report(message: string): void {
  process.stdout.write(`[db:indexes] ${message}\n`);
}

function parseCommand(argv: readonly string[]): Command {
  let apply = false;
  let confirmedDatabase: string | undefined;
  for (const argument of argv) {
    if (argument === '--apply') apply = true;
    else if (argument.startsWith('--confirm-database=')) {
      confirmedDatabase = argument.slice('--confirm-database='.length);
    } else throw new UsageError(`unknown argument ${JSON.stringify(argument)}`);
  }
  if (apply && !confirmedDatabase) {
    throw new UsageError('--apply requires --confirm-database=<database name>');
  }
  return { apply, confirmedDatabase };
}

function requiredUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new UsageError('MONGODB_URI is required');
  return uri;
}

function printReport({ discrepancies }: IndexReport): void {
  if (discrepancies.length === 0) report('every required index is present; no unexpected indexes');
  for (const { collection, index, problem } of discrepancies) {
    report(`${problem.padEnd(11)} ${collection}.${index}`);
  }
}

async function run(command: Command, connection: mongoose.Connection): Promise<boolean> {
  const databaseName = connection.name;
  if (databaseName === 'test') {
    throw new UsageError('MONGODB_URI must name the application database explicitly');
  }
  report(`database ${databaseName}`);

  if (!command.apply) {
    const indexReport = await inspectIndexes(connection);
    printReport(indexReport);
    return blockingDiscrepanciesOf(indexReport).length === 0;
  }

  if (command.confirmedDatabase !== databaseName) {
    throw new UsageError('--confirm-database does not match the database named by MONGODB_URI');
  }
  const { failures, report: indexReport } = await buildMissingIndexes(connection);
  for (const { collection, reason, error } of failures) {
    report(`not built  ${collection}: ${reason} (${formatSafeError(error)})`);
  }
  printReport(indexReport);
  return failures.length === 0 && blockingDiscrepanciesOf(indexReport).length === 0;
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  const connection = mongoose.createConnection(
    requiredUri(),
    connectionOptionsFor({ buildIndexesOnConnect: false }),
  );
  try {
    await connection.asPromise();
    process.exitCode = (await run(command, connection)) ? 0 : 1;
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) report(`refused: ${error.message}`);
  else if (error instanceof ConflictingIndexesError) {
    report(`refused: ${error.message}`);
    for (const { collection, index } of error.conflicts)
      report(`conflicting ${collection}.${index}`);
  } else report(`failed: ${formatSafeError(error)}`);
  process.exitCode = 1;
});
