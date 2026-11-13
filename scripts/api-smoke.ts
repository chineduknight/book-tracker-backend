import { spawn } from 'node:child_process';
import { once } from 'node:events';
import mongoose from 'mongoose';
import {
  ensurePortIsFree,
  startApi,
  stopApi,
  waitUntilApiListens,
  waitUntilReady,
} from './smoke/smoke-api-process.js';
import { describeSmokeFailure } from './smoke/smoke-errors.js';
import { SMOKE_DATABASE_NAME, toLocalSmokeDatabaseUri, toSmokePort } from './smoke/smoke-target.js';

function report(message: string): void {
  process.stdout.write(`[api:smoke] ${message}\n`);
}

async function resetSmokeDatabase(databaseUri: string): Promise<void> {
  await mongoose.connect(databaseUri, {
    dbName: SMOKE_DATABASE_NAME,
    serverSelectionTimeoutMS: 5_000,
  });
  try {
    await mongoose.connection.dropDatabase();
  } finally {
    await mongoose.disconnect();
  }
}

async function runBrunoCollection(baseUrl: string): Promise<number> {
  const bruno = spawn('npm', ['run', 'api:test', '--', '--env-var', `baseUrl=${baseUrl}`], {
    stdio: 'inherit',
  });
  const [exitCode] = (await once(bruno, 'exit')) as [number | null];
  return exitCode ?? 1;
}

async function main(): Promise<void> {
  const databaseUri = toLocalSmokeDatabaseUri(
    process.env.MONGODB_SMOKE_URI ?? `mongodb://127.0.0.1:27017/${SMOKE_DATABASE_NAME}`,
  );
  const port = toSmokePort(process.env.SMOKE_PORT ?? '3100');
  const baseUrl = `http://127.0.0.1:${port}/api/v1`;

  await ensurePortIsFree(port);
  report(`resetting ${SMOKE_DATABASE_NAME}`);
  await resetSmokeDatabase(databaseUri);

  const api = startApi(port, databaseUri);
  try {
    await waitUntilApiListens(api, port);
    await waitUntilReady(api, `${baseUrl}/ready`);
    report(`API ready at ${baseUrl}; running the Bruno collection`);
    process.exitCode = await runBrunoCollection(baseUrl);
  } finally {
    await stopApi(api);
  }
}

main().catch((error: unknown) => {
  report(`failed: ${describeSmokeFailure(error)}`);
  process.exitCode = 1;
});
