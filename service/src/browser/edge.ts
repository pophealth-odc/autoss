import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { EdgeInfo } from '../shared/contract.js';

const execFileAsync = promisify(execFile);

export interface EdgeDetectOptions {
  /** Explicit path from the EDGE_PATH setting. */
  explicitPath?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const INSTALL_HINT =
  'Microsoft Edge was not found. Install or repair it from https://www.microsoft.com/edge, ' +
  'or set EDGE_PATH in service/.env to the full path of msedge.exe.';

function candidatePaths(env: NodeJS.ProcessEnv): string[] {
  const roots = [env['PROGRAMFILES(X86)'], env['PROGRAMFILES'], env['LOCALAPPDATA']].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  return roots.map((root) => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
}

/** Reads the file version of an executable through PowerShell. Returns null when it cannot be determined. */
async function readFileVersion(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        // The path is passed through an environment variable, never interpolated into the command text.
        '(Get-Item -LiteralPath $env:SS3_EXE_PATH).VersionInfo.ProductVersion',
      ],
      { env: { ...env, SS3_EXE_PATH: file }, timeout: 8_000, windowsHide: true },
    );
    const version = stdout.trim();
    return /^\d+(\.\d+){1,3}$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/**
 * Locates the installed Microsoft Edge without starting it. Playwright's "msedge" channel finds the same installation;
 * this check exists so the UI can show a precise, friendly message before a run is attempted.
 */
export async function detectEdge(options: EdgeDetectOptions = {}): Promise<EdgeInfo> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  if (options.explicitPath) {
    if (existsSync(options.explicitPath)) {
      return {
        found: true,
        executablePath: options.explicitPath,
        version: platform === 'win32' ? await readFileVersion(options.explicitPath, env) : null,
        source: 'env',
      };
    }
    return {
      found: false,
      executablePath: null,
      version: null,
      source: 'none',
      hint: `EDGE_PATH points to a file that does not exist: ${options.explicitPath}`,
    };
  }

  if (platform !== 'win32') {
    return { found: false, executablePath: null, version: null, source: 'none', hint: INSTALL_HINT };
  }

  for (const candidate of candidatePaths(env)) {
    if (existsSync(candidate)) {
      return { found: true, executablePath: candidate, version: await readFileVersion(candidate, env), source: 'standard-path' };
    }
  }
  return { found: false, executablePath: null, version: null, source: 'none', hint: INSTALL_HINT };
}

/** Whether a Playwright launch error means the browser itself is missing (as opposed to a profile or sandbox problem). */
export function isMissingBrowserError(message: string): boolean {
  return /distribution 'msedge' is not found|executable doesn't exist|Failed to find|ENOENT/i.test(message);
}
