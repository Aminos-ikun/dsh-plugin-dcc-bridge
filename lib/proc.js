// Process helpers shared by the desktop agent and the DCC launchers.
//
// Everything here captures child output through FILE DESCRIPTORS rather than
// pipes. That is deliberate: under a confined Windows parent process, creating
// the anonymous pipes behind `stdio: 'pipe'` fails with EPERM, while handing the
// child an already-open file handle works everywhere. The cost is that output is
// only readable once the child exits, which every caller here can live with.

import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Default ceiling on how much of one captured stream is kept, in bytes. */
export const DEFAULT_CAPTURE_LIMIT = 4 * 1024 * 1024;

/**
 * Create a private scratch directory that the caller owns and removes.
 * @param prefix - short identifying prefix for the directory name.
 * @returns the absolute directory path.
 */
export function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Read a UTF-8 file, treating any failure as "no content".
 * @param file - path to read.
 * @returns the file's text, or an empty string.
 */
export function readIfExists(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Write text without a byte-order mark, so a peer that reads it as plain UTF-8
 * does not see a stray U+FEFF.
 * @param file - destination path.
 * @param text - content to write.
 */
export function writeUtf8(file, text) {
  writeFileSync(file, text, { encoding: 'utf8' });
}

/**
 * Remove a scratch directory, ignoring failures: leftovers in the temp area are
 * preferable to masking the real result of a call.
 * @param dir - directory to remove.
 */
export function removeDir(dir) {
  if (dir === undefined) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp area is reclaimed by the OS anyway */
  }
}

/** Truncate captured text and note that it happened. */
function cap(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

/**
 * Run one child process to completion with file-descriptor stdio.
 *
 * A timeout kills the process and resolves with `timedOut: true` rather than
 * rejecting, because "the program ran too long" is a result the caller reports,
 * not an infrastructure failure.
 *
 * @param command - executable path or bare name resolved by the OS.
 * @param args - argument vector, passed without a shell.
 * @param options - capture options.
 * @returns the settled outcome with captured stdout/stderr.
 */
export function runCaptured(command, args, options = {}) {
  const {
    timeoutMs = 120000,
    cwd,
    env,
    captureLimit = DEFAULT_CAPTURE_LIMIT,
    onSpawn,
  } = options;

  const dir = tempDir('dsh-cap-');
  const outPath = path.join(dir, 'stdout.txt');
  const errPath = path.join(dir, 'stderr.txt');
  const outFd = openSync(outPath, 'a');
  const errFd = openSync(errPath, 'a');

  const startedAt = Date.now();

  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      // 'ignore' + two real file handles: no anonymous pipe is ever created.
      stdio: ['ignore', outFd, errFd],
    });
  } catch (error) {
    closeSync(outFd);
    closeSync(errFd);
    removeDir(dir);
    return Promise.resolve({
      code: null,
      signal: null,
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error),
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: Date.now() - startedAt,
      exitPath: null,
      outputDir: dir,
    });
  }

  onSpawn?.(child);

  const finish = (code, signal, timedOut, spawnError) => {
    try {
      closeSync(outFd);
    } catch {
      /* already closed */
    }
    try {
      closeSync(errFd);
    } catch {
      /* already closed */
    }
    const rawOut = readIfExists(outPath);
    const rawErr = readIfExists(errPath);
    const out = cap(rawOut, captureLimit);
    const err = cap(rawErr, captureLimit);
    return {
      code,
      signal,
      timedOut,
      ...(spawnError === undefined ? {} : { spawnError }),
      stdout: out.text,
      stderr: err.text,
      stdoutTruncated: out.truncated,
      stderrTruncated: err.truncated,
      durationMs: Date.now() - startedAt,
      outputDir: dir,
    };
  };

  return new Promise((resolve) => {
    let settled = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            killTree(child);
            // Give the kill a moment to flush the redirected files.
            setTimeout(() => resolve(finish(null, null, true, undefined)), 300);
          }, timeoutMs)
        : undefined;

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(finish(null, null, false, error instanceof Error ? error.message : String(error)));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(finish(code, signal, false, undefined));
    });
  });
}

/**
 * Terminate a process and, on Windows, its whole tree.
 * @param child - the process to stop.
 */
export function killTree(child) {
  if (child === undefined || child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      });
      return;
    } catch {
      /* fall through to the portable kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * Whether a bare executable name resolves on PATH.
 * @param name - executable name including extension.
 * @returns the resolved path, or undefined.
 */
export function whichSync(name) {
  const pathValue = process.env.PATH ?? '';
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const hasExt = exts.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const names = hasExt ? [name] : exts.map((ext) => name + ext.toLowerCase());
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.length === 0) continue;
    for (const candidate of names) {
      const full = path.join(dir, candidate);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}
