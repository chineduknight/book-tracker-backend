import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class BackupRefusedError extends Error {
  override readonly name = 'BackupRefusedError';
}

/** A tool failure whose message is ours, never the tool's output, and safe to print. */
export class DatabaseToolFailedError extends Error {
  override readonly name = 'DatabaseToolFailedError';
}

export type DatabaseTool = 'mongodump' | 'mongorestore';

/**
 * Runs mongodump or mongorestore with the connection string in a private config file, never on
 * the command line where other local users could read it from the process list. The tool's own
 * output is withheld because it can name hosts and users; only the exit status is reported.
 */
export async function runDatabaseTool(
  tool: DatabaseTool,
  uri: string,
  args: readonly string[],
): Promise<void> {
  const configDirectory = await mkdtemp(join(tmpdir(), 'book-tracker-db-tool-'));
  try {
    const configFile = join(configDirectory, 'tool.yaml');
    // A JSON string is a valid YAML double-quoted scalar, so any URI is escaped correctly.
    await writeFile(configFile, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600, flag: 'wx' });
    const child = spawn(tool, [`--config=${configFile}`, '--quiet', ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const [exitCode] = (await Promise.race([
      once(child, 'exit'),
      once(child, 'error').then(() => [null]),
    ])) as [number | null];
    if (exitCode !== 0) {
      throw new DatabaseToolFailedError(
        exitCode === null
          ? `${tool} could not be started; install the MongoDB Database Tools`
          : `${tool} failed with exit code ${exitCode}; its output is withheld because it can include connection details`,
      );
    }
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
}

export async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
