import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface ScriptRun {
  exitCode: number | null;
  output: string;
}

/** Runs a TypeScript entry point in a child process with exactly the given environment. */
export async function runScript(
  scriptPath: string,
  args: readonly string[],
  environment: Record<string, string>,
): Promise<ScriptRun> {
  const child = spawn(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
    env: { PATH: process.env.PATH ?? '', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
  const [exitCode] = (await once(child, 'exit')) as [number | null];
  return { exitCode, output: Buffer.concat(chunks).toString('utf8') };
}
