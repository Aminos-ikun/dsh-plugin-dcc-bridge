// 3D content-creation software: discovery, launch, in-app scripting, and
// headless batch runs.
//
// Three ideas carry the whole module:
//
//  * **Catalog + filesystem search.** Every supported application is described
//    once (executable names, the install layouts it uses, its scripting
//    flavour). Nothing is installed by this plugin and no registry key is
//    required, because DCC installations are routinely portable or on a drive
//    other than C:.
//  * **A loopback JSON bridge.** An application that runs the shipped bridge
//    script advertises itself in a per-user rendezvous directory. `dcc_run`
//    finds the advertisement, connects, and executes Python on the
//    application's own main thread.
//  * **A headless fallback.** `dcc_batch` drives any application with a batch
//    mode (`blender -b -P`, `mayapy`, `hython`, …) for work that needs no open
//    GUI session.

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { condense, text, tool } from './tool.js';
import { removeDir, runCaptured, tempDir, whichSync } from './proc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');
/** Absolute path of the shipped in-app bridge script. */
export const BRIDGE_SCRIPT = path.join(ASSETS, 'blender_dsh_bridge.py');

/** Default lowest loopback port for the in-app bridge. */
const DEFAULT_BASE_PORT = 47810;
/** How long `dcc_launch` waits for a bridge advertisement by default. */
const DEFAULT_BRIDGE_WAIT_MS = 45000;
/** Per-call budget for a bridge round trip. */
const DEFAULT_RUN_TIMEOUT_MS = 60000;

/**
 * The application catalog.
 *
 * `search` entries are path segments relative to a root directory, where a
 * segment containing `*` matches any directory name at that level. `roots`
 * selects which roots a search applies to.
 */
export const DCC_APPS = [
  {
    id: 'blender',
    label: 'Blender',
    scripting: 'python',
    executables: ['blender.exe', 'blender'],
    versionArgs: ['--version'],
    versionPattern: 'Blender\\s+([0-9][0-9.]*)',
    search: [
      { roots: ['programFiles'], segments: ['Blender Foundation', 'Blender *', 'blender.exe'] },
      { roots: ['programFiles'], segments: ['Blender *', 'blender.exe'] },
      { roots: ['drives'], segments: ['Blender *', 'blender.exe'] },
      { roots: ['localAppData'], segments: ['Programs', 'Blender Foundation', 'Blender *', 'blender.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Blender Foundation', 'Blender *', 'blender.exe'] },
    ],
    bridge: {
      kind: 'python-socket',
      script: BRIDGE_SCRIPT,
      basePort: DEFAULT_BASE_PORT,
      /**
       * The complete argv, in the order Blender needs it: the file first,
       * caller arguments next (so `-b` really reaches Blender), and only then
       * the `--python bridge -- <bridge args>` tail, because everything after
       * `--` is delivered to the script rather than to Blender.
       */
      args: ({ port, idleSeconds, file, extraArgs }) => [
        ...(file === undefined ? [] : [file]),
        ...extraArgs,
        '--python',
        BRIDGE_SCRIPT,
        '--',
        '--port',
        String(port),
        '--idle-seconds',
        String(idleSeconds),
      ],
      /** Where the file goes for `scripts/addons`, relative to the user config root. */
      addonTarget: (configRoot) => path.join(configRoot, 'scripts', 'addons', 'blender_dsh_bridge.py'),
    },
    batch: {
      /** `blender -b [file] -P script -- extra...` */
      args: ({ scriptPath, file, extraArgs }) => [
        '-b',
        ...(file === undefined ? [] : [file]),
        '--python',
        scriptPath,
        ...(extraArgs.length > 0 ? ['--', ...extraArgs] : []),
      ],
      scriptExtension: '.py',
    },
  },
  {
    id: 'maya',
    label: 'Autodesk Maya',
    scripting: 'python',
    executables: ['maya.exe', 'maya'],
    versionArgs: ['-v'],
    versionPattern: 'maya version\\s+([0-9.]+)',
    search: [
      { roots: ['programFiles'], segments: ['Autodesk', 'Maya *', 'bin', 'maya.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Autodesk', 'Maya *', 'bin', 'maya.exe'] },
    ],
    batch: {
      // mayapy runs standalone Python with the maya libraries importable.
      interpreterNames: ['mayapy.exe'],
      interpreterSearch: [
        { roots: ['programFiles'], segments: ['Autodesk', 'Maya *', 'bin', 'mayapy.exe'] },
      ],
      args: ({ scriptPath }) => [scriptPath],
      scriptExtension: '.py',
    },
  },
  {
    id: '3dsmax',
    label: 'Autodesk 3ds Max',
    scripting: 'maxscript',
    executables: ['3dsmax.exe'],
    search: [
      { roots: ['programFiles'], segments: ['Autodesk', '3ds Max *', '3dsmax.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Autodesk', '3ds Max *', '3dsmax.exe'] },
    ],
    batch: {
      interpreterNames: ['3dsmaxbatch.exe'],
      interpreterSearch: [
        { roots: ['programFiles'], segments: ['Autodesk', '3ds Max *', '3dsmaxbatch.exe'] },
      ],
      args: ({ scriptPath }) => ['-script', scriptPath],
      scriptExtension: '.ms',
    },
  },
  {
    id: 'houdini',
    label: 'SideFX Houdini',
    scripting: 'python',
    executables: ['houdini.exe', 'houdinifx.exe'],
    search: [
      { roots: ['programFiles'], segments: ['Side Effects Software', 'Houdini *', 'bin', 'houdini.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Side Effects Software', 'Houdini *', 'bin', 'houdini.exe'] },
    ],
    batch: {
      interpreterNames: ['hython.exe'],
      interpreterSearch: [
        { roots: ['programFiles'], segments: ['Side Effects Software', 'Houdini *', 'bin', 'hython.exe'] },
      ],
      args: ({ scriptPath }) => [scriptPath],
      scriptExtension: '.py',
    },
  },
  {
    id: 'c4d',
    label: 'Maxon Cinema 4D',
    scripting: 'python',
    executables: ['Cinema 4D.exe'],
    search: [
      { roots: ['programFiles'], segments: ['Maxon Cinema 4D *', 'Cinema 4D.exe'] },
      { roots: ['programFiles'], segments: ['Maxon', 'Cinema 4D *', 'Cinema 4D.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Maxon Cinema 4D *', 'Cinema 4D.exe'] },
    ],
    batch: {
      args: ({ file, scriptPath, extraArgs }) => [
        ...(file === undefined ? [] : [file]),
        '-nogui',
        '-c',
        'python',
        scriptPath,
        ...extraArgs,
      ],
      scriptExtension: '.py',
    },
  },
  {
    id: 'unreal',
    label: 'Unreal Engine',
    scripting: 'python',
    executables: ['UnrealEditor.exe'],
    search: [
      { roots: ['programFiles'], segments: ['Epic Games', 'UE_*', 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Epic Games', 'UE_*', 'Engine', 'Binaries', 'Win64', 'UnrealEditor.exe'] },
    ],
    batch: {
      args: ({ file, scriptPath }) => [
        ...(file === undefined ? [] : [file]),
        '-run=pythonscript',
        `-script=${scriptPath}`,
        '-unattended',
        '-nosplash',
      ],
      scriptExtension: '.py',
    },
  },
  {
    id: 'unity',
    label: 'Unity',
    scripting: 'csharp',
    executables: ['Unity.exe'],
    search: [
      { roots: ['programFiles'], segments: ['Unity', 'Hub', 'Editor', '*', 'Editor', 'Unity.exe'] },
      { roots: ['programFiles'], segments: ['Unity', 'Editor', 'Unity.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Unity', 'Hub', 'Editor', '*', 'Editor', 'Unity.exe'] },
    ],
    batch: {
      args: ({ file, scriptPath }) => [
        '-batchmode',
        '-quit',
        ...(file === undefined ? [] : ['-projectPath', file]),
        '-executeMethod',
        path.basename(scriptPath, path.extname(scriptPath)),
      ],
      scriptExtension: '.cs',
    },
  },
  {
    id: 'godot',
    label: 'Godot',
    scripting: 'gdscript',
    executables: ['Godot_v4.exe', 'godot.exe', 'Godot.exe'],
    search: [
      { roots: ['drives'], segments: ['Godot*', 'Godot*.exe'] },
      { roots: ['programFiles'], segments: ['Godot*', 'Godot*.exe'] },
      { roots: ['localAppData'], segments: ['Programs', 'Godot*', 'Godot*.exe'] },
      { roots: ['drives'], segments: ['Godot*.exe'] },
    ],
    batch: {
      args: ({ file, scriptPath }) => [
        '--headless',
        ...(file === undefined ? [] : ['--path', file]),
        '--script',
        scriptPath,
      ],
      scriptExtension: '.gd',
    },
  },
  {
    id: 'sketchup',
    label: 'SketchUp',
    scripting: 'ruby',
    executables: ['SketchUp.exe'],
    search: [
      { roots: ['programFiles'], segments: ['SketchUp', 'SketchUp *', 'SketchUp.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'SketchUp', 'SketchUp *', 'SketchUp.exe'] },
    ],
  },
  {
    id: 'rhino',
    label: 'Rhino',
    scripting: 'python',
    executables: ['Rhino.exe'],
    search: [
      { roots: ['programFiles'], segments: ['Rhino *', 'System', 'Rhino.exe'] },
      { roots: ['drives'], segments: ['Program Files', 'Rhino *', 'System', 'Rhino.exe'] },
    ],
    batch: {
      args: ({ scriptPath }) => [`/runscript=${scriptPath}`],
      scriptExtension: '.py',
    },
  },
];

/** Fast lookup by catalog id. */
const APP_BY_ID = new Map(DCC_APPS.map((app) => [app.id, app]));

/** Every fixed drive root that currently exists, e.g. `C:\`. */
function driveRoots() {
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (existsSync(root)) roots.push(root);
    } catch {
      /* an absent or unreadable drive is simply not a root */
    }
  }
  return roots;
}

/** Map a catalog root name to its concrete directory, or undefined. */
function resolveRoot(name) {
  if (name === 'programFiles') return process.env.ProgramFiles ?? 'C:\\Program Files';
  if (name === 'localAppData') return process.env.LOCALAPPDATA;
  if (name === 'appData') return process.env.APPDATA;
  return undefined;
}

/**
 * Expand a segment list that may contain `*` into concrete file paths.
 * @param base - directory the first segment is resolved against.
 * @param segments - remaining path segments, `*` allowed in any of them.
 * @returns matching file paths.
 */
function expandSegments(base, segments) {
  let frontier = [base];
  for (const segment of segments) {
    const next = [];
    const wildcard = segment.includes('*');
    const matcher = wildcard
      ? new RegExp(`^${segment.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')
      : undefined;
    for (const current of frontier) {
      if (!wildcard) {
        next.push(path.join(current, segment));
        continue;
      }
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (matcher.test(entry.name)) next.push(path.join(current, entry.name));
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return frontier.filter((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Find every installation of one catalog entry.
 * @param app - the catalog entry.
 * @param options - search options.
 * @returns `{ path, source }` records, deduplicated by path.
 */
export function findInstallations(app, options = {}) {
  const found = new Map();
  const add = (candidate, source) => {
    if (candidate === undefined || candidate === null) return;
    const key = candidate.toLowerCase();
    if (!found.has(key)) found.set(key, { path: candidate, source });
  };

  if (options.overridePath) add(options.overridePath, 'provided');

  const envKey = `DSH_DCC_${app.id.toUpperCase().replace(/[^A-Z0-9]/g, '')}_PATH`;
  add(process.env[envKey], `env:${envKey}`);

  for (const executable of app.executables ?? []) {
    add(whichSync(executable), 'path');
  }

  const drives = options.drives ?? driveRoots();
  for (const entry of app.search ?? []) {
    for (const rootName of entry.roots) {
      if (rootName === 'drives') {
        for (const drive of drives) {
          for (const hit of expandSegments(drive, entry.segments)) add(hit, `drive ${drive}`);
        }
        continue;
      }
      const root = resolveRoot(rootName);
      if (root === undefined) continue;
      for (const hit of expandSegments(root, entry.segments)) add(hit, rootName);
    }
  }
  return [...found.values()];
}

/**
 * Read an application's version by running its own `--version` style switch.
 * @param app - catalog entry.
 * @param executable - the resolved executable path.
 * @param timeoutMs - budget for the probe.
 * @returns the version string when recognized.
 */
export async function probeVersion(app, executable, timeoutMs = 20000) {
  if (app.versionPattern === undefined || app.versionArgs === undefined) return undefined;
  const result = await runCaptured(executable, app.versionArgs, { timeoutMs, captureLimit: 20000 });
  removeDir(result.outputDir);
  const haystack = `${result.stdout}\n${result.stderr}`;
  const match = new RegExp(app.versionPattern, 'i').exec(haystack);
  return match?.[1];
}

/**
 * The per-user rendezvous directories a bridge advertises itself in, most
 * preferred first. `DSH_DCC_BRIDGE_DIR` replaces the list outright.
 * @returns absolute directory paths.
 */
export function discoveryDirs() {
  const override = process.env.DSH_DCC_BRIDGE_DIR;
  if (override) return [override];
  const dirs = [];
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA, os.tmpdir()]) {
    if (base) dirs.push(path.join(base, 'dsh-dcc-bridge'));
  }
  dirs.push(path.join(os.homedir(), '.dsh', 'dcc-bridge'));
  return [...new Set(dirs)];
}

/** Read every bridge advertisement on disk, ignoring unreadable entries. */
export function readAdvertisements() {
  const found = [];
  for (const directory of discoveryDirs()) {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(directory, name);
      try {
        const info = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof info?.port !== 'number' || typeof info?.token !== 'string') continue;
        found.push({ ...info, discoveryFile: file });
      } catch {
        /* a half-written or unrelated file is not an advertisement */
      }
    }
  }
  return found;
}

/** One connect attempt against an advertised bridge. */
function probePort(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const settle = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

/**
 * Every advertised bridge that actually accepts a connection.
 *
 * Dead advertisements are deleted on the way past. A bridge writes its
 * advertisement only after it is listening, so a file whose port refuses a
 * connection belongs to a process that is gone — and an application killed
 * abruptly (Blender's `quit_blender`, a Task Manager kill, a crash) never gets
 * to remove its own. Leaving those files behind would make a human reading the
 * directory believe a bridge exists. Files younger than a few seconds are left
 * alone, so a bridge that is mid-start is never mistaken for a stale one.
 *
 * @returns live advertisement records.
 */
export async function liveBridges() {
  const advertisements = readAdvertisements();
  const checked = await Promise.all(
    advertisements.map(async (info) => {
      if (await probePort(info.host ?? '127.0.0.1', info.port)) return info;
      const startedAt = (info.started ?? 0) * 1000;
      const age = Date.now() - (Number.isFinite(startedAt) && startedAt > 0 ? startedAt : 0);
      if (age > 3000) {
        try {
          rmSync(info.discoveryFile, { force: true });
        } catch {
          /* a file we cannot remove is not worth failing a listing over */
        }
      }
      return undefined;
    }),
  );
  return checked.filter(Boolean);
}

/**
 * A connected bridge: line-framed JSON over one loopback socket.
 */
export class BridgeConnection {
  #socket;
  #buffer = '';
  #pending = new Map();
  #closed = false;

  constructor(socket, info) {
    this.info = info;
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('error', () => this.#fail(new Error('bridge connection error')));
    socket.on('close', () => this.#fail(new Error('bridge connection closed')));
  }

  /**
   * Connect to one advertised bridge and complete the `hello` handshake.
   * @param info - the advertisement.
   * @param timeoutMs - handshake budget.
   * @returns the connected bridge.
   */
  static async connect(info, timeoutMs = 5000) {
    const socket = await new Promise((resolve, reject) => {
      const candidate = net.connect({ host: info.host ?? '127.0.0.1', port: info.port });
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new Error(`timed out connecting to ${info.app} on port ${info.port}`));
      }, timeoutMs);
      candidate.once('connect', () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${info.app} on port ${info.port}: ${error.message}`));
      });
    });
    const connection = new BridgeConnection(socket, info);
    try {
      const hello = await connection.call('hello', {}, timeoutMs);
      // A bridge that answers `ok: false` — a stale advertisement whose token no
      // longer matches, most often — must fail here rather than surface as a
      // confusing error on the first real request.
      if (hello.ok !== true) throw new Error(String(hello.error ?? 'the bridge rejected the handshake'));
      connection.hello = hello;
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  /** Close the socket and reject everything still waiting. */
  close() {
    this.#closed = true;
    this.#socket.destroy();
    this.#fail(new Error('bridge connection closed'));
  }

  #fail(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.#pending.clear();
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          message = undefined;
        }
        if (message !== undefined) {
          const entry = this.#pending.get(String(message.id));
          if (entry !== undefined) {
            this.#pending.delete(String(message.id));
            clearTimeout(entry.timer);
            entry.resolve(message);
          }
        }
      }
      index = this.#buffer.indexOf('\n');
    }
  }

  /**
   * Send one request and await its response.
   * @param op - `hello`, `ping`, `exec` or `eval`.
   * @param payload - extra request fields (`code`, `mode`, `timeout_ms`).
   * @param timeoutMs - response budget.
   * @returns the raw response object.
   */
  call(op, payload = {}, timeoutMs = DEFAULT_RUN_TIMEOUT_MS) {
    if (this.#closed) return Promise.reject(new Error('bridge connection is closed'));
    const id = randomUUID();
    const frame = { id, token: this.info.token, op, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`bridge timed out after ${timeoutMs}ms handling ${op}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error === undefined || error === null) return;
        const entry = this.#pending.get(id);
        if (entry === undefined) return;
        this.#pending.delete(id);
        clearTimeout(entry.timer);
        reject(new Error(`bridge write failed: ${error.message}`));
      });
    });
  }
}

/**
 * Wait for an advertisement from a specific application to appear and accept.
 * @param options - selection and budget.
 * @returns the live advertisement, or undefined on timeout.
 */
export async function waitForBridge(options = {}) {
  const { app, since = 0, timeoutMs = DEFAULT_BRIDGE_WAIT_MS, pid } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidates = readAdvertisements().filter((info) => {
      if (app !== undefined && info.app !== app) return false;
      if (pid !== undefined && info.pid !== pid) return false;
      return (info.started ?? 0) * 1000 >= since - 5000;
    });
    for (const info of candidates) {
      if (await probePort(info.host ?? '127.0.0.1', info.port)) return info;
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Launch a GUI application without waiting for it. */
function launchDetached(executable, args, options = {}) {
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    cwd: options.cwd,
  });
  child.unref();
  return child.pid;
}

// ---------------------------------------------------------------- tool set

const APP_ENUM = DCC_APPS.map((app) => app.id);

const APP_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'label', 'installed'],
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    installed: { type: 'boolean' },
    path: { type: 'string' },
    source: { type: 'string' },
    version: { type: 'string' },
    scripting: { type: 'string' },
    bridgeCapable: { type: 'boolean' },
    batchCapable: { type: 'boolean' },
  },
};

const BRIDGE_ROW = {
  type: 'object',
  additionalProperties: false,
  required: ['app', 'port'],
  properties: {
    app: { type: 'string' },
    label: { type: 'string' },
    version: { type: 'string' },
    port: { type: 'integer' },
    pid: { type: 'integer' },
    host: { type: 'string' },
    background: { type: 'boolean' },
    file: { type: 'string' },
  },
};

/**
 * Create the DCC tool set.
 * @param options - wiring.
 * @param options.enabledApps - catalog ids to expose; empty means all.
 * @param options.extraPaths - `{ appId: executablePath }` pinned overrides.
 * @returns registry-ready tool definitions.
 */
export function createDccTools(options = {}) {
  const allowed = new Set(options.enabledApps?.length ? options.enabledApps : APP_ENUM);
  const pinned = options.extraPaths ?? {};
  const apps = DCC_APPS.filter((app) => allowed.has(app.id));

  /** Resolve one app to its executable, honouring pinned overrides. */
  const resolveApp = (id) => {
    const app = APP_BY_ID.get(id);
    if (app === undefined) throw new Error(`unknown 3D application ${JSON.stringify(id)}; known: ${APP_ENUM.join(', ')}`);
    const hits = findInstallations(app, { overridePath: pinned[id] });
    if (hits.length === 0) return { app, hit: undefined, hits };
    return { app, hit: hits[0], hits };
  };

  const list = tool({
    name: 'dcc_list',
    description:
      'Report which supported 3D applications are installed and which ones are currently reachable over a live bridge. '
      + 'Call this first: it tells you the exact `app` id, executable path and live port to use with dcc_run, dcc_launch and dcc_batch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probeVersions: {
          type: 'boolean',
          description: 'Also run each application to read its version. Slower (a few seconds per app) but resolves exact versions.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['apps', 'bridges'],
        properties: {
          apps: { type: 'array', items: APP_ROW },
          bridges: { type: 'array', items: BRIDGE_ROW },
          discoveryDirs: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => {
        const lines = [];
        if (value.apps.length === 0) lines.push('No supported 3D applications are enabled in this deployment.');
        for (const app of value.apps) {
          if (app.installed) {
            lines.push(
              `- ${app.label} (${app.id}) — installed at ${app.path}${app.version === undefined ? '' : `, version ${app.version}`}`
              + `${app.bridgeCapable ? ', bridge-capable' : ''}${app.batchCapable ? ', batch-capable' : ''}`,
            );
          } else {
            lines.push(`- ${app.label} (${app.id}) — not found`);
          }
        }
        lines.push('');
        if (value.bridges.length === 0) {
          lines.push('No live bridges. Use dcc_launch with bridge: true to start one.');
        } else {
          lines.push('Live bridges (usable with dcc_run):');
          for (const bridge of value.bridges) {
            lines.push(
              `- ${bridge.label ?? bridge.app} on 127.0.0.1:${bridge.port} (pid ${bridge.pid}${bridge.version === undefined ? '' : `, ${bridge.version}`}${
                bridge.background ? ', background' : ''
              }${bridge.file ? `, file ${bridge.file}` : ''})`,
            );
          }
        }
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      const rows = [];
      for (const app of apps) {
        const { hit, hits } = resolveApp(app.id);
        let version;
        if (hit !== undefined && args.probeVersions === true) {
          try {
            version = await probeVersion(app, hit.path, 30000);
          } catch {
            version = undefined;
          }
        }
        if (exec.signal?.aborted) throw new Error('aborted');
        rows.push({
          id: app.id,
          label: app.label,
          installed: hit !== undefined,
          ...(hit === undefined ? {} : { path: hit.path, source: hit.source }),
          ...(version === undefined ? {} : { version }),
          scripting: app.scripting,
          bridgeCapable: app.bridge !== undefined,
          batchCapable: app.batch !== undefined,
        });
      }
      const bridges = await liveBridges();
      return {
        apps: rows,
        bridges: bridges.map((info) => ({
          app: info.app,
          ...(info.label === undefined ? {} : { label: info.label }),
          ...(info.version === undefined ? {} : { version: info.version }),
          port: info.port,
          ...(info.pid === undefined ? {} : { pid: info.pid }),
          host: info.host ?? '127.0.0.1',
          ...(info.background === undefined ? {} : { background: info.background }),
          ...(info.file ? { file: info.file } : {}),
        })),
        discoveryDirs: discoveryDirs(),
      };
    },
  });

  const launch = tool({
    name: 'dcc_launch',
    description:
      'Start a 3D application. With `bridge: true` (the default for bridge-capable applications) the application is started with the DSH bridge attached, so dcc_run can immediately run Python inside it; '
      + 'the call waits until that bridge answers and reports its port. Use `file` to open a scene or project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['app'],
      properties: {
        app: { type: 'string', enum: APP_ENUM, description: 'Catalog id, as reported by dcc_list.' },
        path: { type: 'string', description: 'Explicit executable path, overriding detection.' },
        file: { type: 'string', description: 'Scene, project or document to open.' },
        bridge: { type: 'boolean', description: 'Attach the DSH bridge. Defaults to true for bridge-capable applications.' },
        port: { type: 'integer', description: 'Lowest loopback port the bridge may bind. Defaults to 47810.' },
        waitMs: { type: 'integer', description: 'How long to wait for the bridge to answer. Defaults to 45000.' },
        extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra command-line arguments appended verbatim.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'app', 'pid', 'path', 'bridge'],
        properties: {
          ok: { type: 'boolean' },
          app: { type: 'string' },
          pid: { type: 'integer' },
          path: { type: 'string' },
          bridge: { type: 'string', description: 'Human-readable bridge status.' },
          port: { type: 'integer' },
          version: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.detail}\n\n${value.bridge}`),
    },
    async execute(args, exec) {
      const { app, hit } = resolveApp(args.app);
      const executable = args.path ?? hit?.path;
      if (executable === undefined) {
        throw new Error(
          `could not find ${app.label}. Install it, or pass an explicit \`path\`, or pin one with the plugin's extraPaths config.`,
        );
      }
      const bridgeWanted = args.bridge ?? app.bridge !== undefined;
      if (bridgeWanted && app.bridge === undefined) {
        throw new Error(`${app.label} has no bundled bridge adapter yet; pass bridge: false to launch it anyway`);
      }

      const extraArgs = Array.isArray(args.extraArgs) ? args.extraArgs : [];
      const startedAt = Date.now();
      let argsVector;
      if (bridgeWanted) {
        argsVector = app.bridge.args({
          port: args.port ?? app.bridge.basePort,
          idleSeconds: 900,
          file: args.file,
          extraArgs,
        });
      } else {
        argsVector = [...(args.file === undefined ? [] : [args.file]), ...extraArgs];
      }

      const pid = launchDetached(executable, argsVector);
      if (!bridgeWanted) {
        return {
          ok: true,
          app: app.id,
          pid,
          path: executable,
          bridge: 'Bridge not requested; drive this application with dcc_batch instead.',
          detail: `Started ${app.label} (pid ${pid}).`,
        };
      }

      const info = await waitForBridge({
        app: app.id,
        since: startedAt,
        timeoutMs: args.waitMs ?? DEFAULT_BRIDGE_WAIT_MS,
      });
      if (info === undefined) {
        return {
          ok: true,
          app: app.id,
          pid,
          path: executable,
          bridge:
            'The bridge did not answer in time. The application may still be starting; re-check with dcc_list. If it stays silent, the bridge script may not have run — check the application console.',
          detail: `Started ${app.label} (pid ${pid}), bridge not confirmed.`,
        };
      }
      return {
        ok: true,
        app: app.id,
        pid,
        path: executable,
        port: info.port,
        ...(info.version === undefined ? {} : { version: info.version }),
        bridge: `Bridge live on 127.0.0.1:${info.port} — call dcc_run with app "${app.id}".`,
        detail: `Started ${app.label} (pid ${pid}) with the DSH bridge attached.`,
      };
    },
  });

  const run = tool({
    name: 'dcc_run',
    description:
      'Run Python inside an already-running 3D application through the DSH bridge, and return what it printed plus the value of the final expression. '
      + 'The code executes on the application main thread with `bpy` (Blender) already imported, and a namespace that persists between calls. '
      + 'Use `mode: "eval"` to get a value back. Safer and far faster than driving the GUI when the application exposes a scripting API.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string', description: 'Python source. With mode "eval" it must be a single expression.' },
        app: { type: 'string', enum: APP_ENUM, description: 'Restrict to a live bridge for this application.' },
        port: { type: 'integer', description: 'Target one exact live bridge port.' },
        mode: { type: 'string', enum: ['exec', 'eval'], description: 'Execute statements (default) or evaluate one expression.' },
        timeoutMs: { type: 'integer', description: 'Bridge budget in milliseconds. Defaults to 60000.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'app', 'port'],
        properties: {
          ok: { type: 'boolean' },
          app: { type: 'string' },
          port: { type: 'integer' },
          version: { type: 'string' },
          stdout: { type: 'string' },
          result: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const parts = [];
        if (value.stdout && value.stdout.trim().length > 0) parts.push(condense(value.stdout, 12000));
        if (value.result !== undefined) parts.push(`⇒ ${value.result}`);
        if (value.error !== undefined) parts.push(`[error]\n${condense(value.error, 12000)}`);
        if (parts.length === 0) parts.push('(no output)');
        return text(parts.join('\n'));
      },
    },
    async execute(args, exec) {
      const bridges = await liveBridges();
      const wanted = bridges.filter((info) => {
        if (args.app !== undefined && info.app !== args.app) return false;
        if (args.port !== undefined && info.port !== args.port) return false;
        return true;
      });
      if (wanted.length === 0) {
        const seen = bridges.length === 0 ? 'none are running' : `running: ${bridges.map((b) => `${b.app}@${b.port}`).join(', ')}`;
        throw new Error(`no live DSH bridge matches that request (${seen}); start one with dcc_launch bridge: true`);
      }
      const info = wanted[0];
      const connection = await BridgeConnection.connect(info, 8000);
      try {
        const timeoutMs = args.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
        const response = await connection.call(
          args.mode === 'eval' ? 'eval' : 'exec',
          { code: args.code, mode: args.mode ?? 'exec', timeout_ms: timeoutMs },
          timeoutMs + 5000,
        );
        if (response.ok !== true) {
          return {
            ok: false,
            app: info.app,
            port: info.port,
            ...(info.version === undefined ? {} : { version: info.version }),
            ...(response.stdout ? { stdout: response.stdout } : {}),
            error: String(response.error ?? 'bridge reported failure'),
          };
        }
        return {
          ok: response.error === null || response.error === undefined,
          app: info.app,
          port: info.port,
          ...(info.version === undefined ? {} : { version: info.version }),
          ...(response.stdout ? { stdout: response.stdout } : {}),
          ...(response.result === null || response.result === undefined ? {} : { result: response.result }),
          ...(response.error ? { error: String(response.error) } : {}),
        };
      } finally {
        connection.close();
      }
    },
  });

  const batch = tool({
    name: 'dcc_batch',
    description:
      'Run a script with a 3D application in headless batch mode and return its console output. '
      + 'This needs no open GUI session and no bridge: it launches the application (or its bundled interpreter such as mayapy/hython/3dsmaxbatch) with a script file, waits for it to exit, and captures stdout/stderr. '
      + 'Best for automation, file conversion, renders and CI-style checks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['app'],
      properties: {
        app: { type: 'string', enum: APP_ENUM, description: 'Catalog id, as reported by dcc_list.' },
        code: { type: 'string', description: 'Script source to run. Written to a temporary file with the right extension.' },
        script: { type: 'string', description: 'Path to an existing script file, used instead of `code`.' },
        file: { type: 'string', description: 'Scene or project to open first.' },
        extraArgs: { type: 'array', items: { type: 'string' }, description: 'Extra arguments appended verbatim.' },
        timeoutMs: { type: 'integer', description: 'Wall-clock budget. Defaults to 300000.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['app', 'ok'],
        properties: {
          app: { type: 'string' },
          ok: { type: 'boolean' },
          exitCode: { type: 'integer' },
          timedOut: { type: 'boolean' },
          durationMs: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          command: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const parts = [`$ ${value.command}`];
        if (value.timedOut) parts.push(`[timed out after ${value.durationMs}ms]`);
        if (value.stdout && value.stdout.trim().length > 0) parts.push(condense(value.stdout, 12000));
        if (value.stderr && value.stderr.trim().length > 0) parts.push(`[stderr]\n${condense(value.stderr, 8000)}`);
        if (parts.length === 1) parts.push('(no output)');
        if (!value.timedOut && value.exitCode !== 0) parts.push(`[exit code: ${value.exitCode}]`);
        return text(parts.join('\n'));
      },
    },
    async execute(args, exec) {
      const { app, hit } = resolveApp(args.app);
      if (app.batch === undefined) throw new Error(`${app.label} has no headless batch recipe in this plugin`);
      if (args.code === undefined && args.script === undefined) {
        throw new Error('dcc_batch needs either `code` (inline source) or `script` (an existing file)');
      }

      // Prefer the application's own scripting interpreter when it has one:
      // mayapy/hython start in a fraction of the time the full GUI binary needs.
      let executable = hit?.path;
      let note;
      if (app.batch.interpreterSearch !== undefined) {
        for (const entry of app.batch.interpreterSearch) {
          for (const rootName of entry.roots) {
            const root = resolveRoot(rootName);
            if (root === undefined) continue;
            const found = expandSegments(root, entry.segments);
            if (found.length > 0) {
              executable = found[0];
              note = `using ${path.basename(found[0])}`;
            }
          }
        }
      }
      if (executable === undefined) {
        throw new Error(`could not find ${app.label}; install it or pin a path in config`);
      }

      const workDir = tempDir('dsh-dcc-batch-');
      let scriptPath = args.script;
      if (args.code !== undefined) {
        scriptPath = path.join(workDir, `dsh-script${app.batch.scriptExtension}`);
        writeFileSync(scriptPath, args.code, 'utf8');
      }
      const extraArgs = Array.isArray(args.extraArgs) ? args.extraArgs : [];
      const argv = app.batch.args({ scriptPath, file: args.file, extraArgs });
      const result = await runCaptured(executable, argv, {
        timeoutMs: args.timeoutMs ?? 300000,
        captureLimit: 2 * 1024 * 1024,
      });
      removeDir(workDir);
      removeDir(result.outputDir);
      const command = [executable, ...argv].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
      return {
        app: app.id,
        ok: !result.timedOut && (result.code === 0 || result.code === null),
        ...(result.code === null ? {} : { exitCode: result.code }),
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        ...(result.stdout.length > 0 ? { stdout: result.stdout } : {}),
        ...(result.stderr.length > 0 ? { stderr: result.stderr } : {}),
        command: note === undefined ? command : `${command}  (${note})`,
      };
    },
  });

  const installBridge = tool({
    name: 'dcc_bridge_install',
    description:
      'Install the DSH bridge as an add-on inside a 3D application, so a session the user started by hand is also reachable by dcc_run. '
      + 'For Blender this copies the bridge into the user scripts/addons directory and reports the exact path.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['app'],
      properties: {
        app: { type: 'string', enum: APP_ENUM },
        dir: { type: 'string', description: 'Override the destination directory.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['app', 'installed', 'instructions'],
        properties: {
          app: { type: 'string' },
          installed: { type: 'array', items: { type: 'string' } },
          instructions: { type: 'string' },
        },
      },
      render: (_args, value) => text(`${value.instructions}\n\nFiles:\n${value.installed.map((f) => `- ${f}`).join('\n')}`),
    },
    async execute(args) {
      const { app } = resolveApp(args.app);
      if (app.bridge === undefined) throw new Error(`${app.label} has no bundled bridge adapter yet`);
      const source = app.bridge.script;
      if (!existsSync(source)) throw new Error(`bridge asset is missing from the plugin: ${source}`);

      const targets = [];
      if (args.dir !== undefined) {
        targets.push(path.join(args.dir, path.basename(source)));
      } else {
        // Blender keeps user add-ons under each versioned config directory.
        const base = process.env.APPDATA ? path.join(process.env.APPDATA, 'Blender Foundation', 'Blender') : undefined;
        if (base !== undefined && existsSync(base)) {
          for (const version of readdirSync(base)) {
            const configRoot = path.join(base, version);
            if (!existsSync(path.join(configRoot, 'config'))) continue;
            targets.push(app.bridge.addonTarget(configRoot));
          }
        }
        // Always offer the version-independent location as well.
        if (process.env.APPDATA) {
          targets.push(app.bridge.addonTarget(path.join(process.env.APPDATA, 'Blender Foundation', 'Blender')));
        }
      }
      const installed = [];
      for (const target of targets) {
        try {
          mkdirSync(path.dirname(target), { recursive: true });
          copyFileSync(source, target);
          installed.push(target);
        } catch {
          /* an unwritable location is reported by omission */
        }
      }
      if (installed.length === 0) {
        throw new Error(
          `could not write the bridge add-on anywhere writable. Pass an explicit \`dir\` (for example a folder inside the workspace) and install it manually.`,
        );
      }
      return {
        app: app.id,
        installed,
        instructions:
          `Installed the DSH bridge for ${app.label}. Enable it as an add-on (Blender: Edit ▸ Preferences ▸ Add-ons ▸ search "DSH"), or start Blender with --python pointing at the file. `
          + 'Once enabled, the bridge starts automatically and dcc_list will show it as a live bridge.',
      };
    },
  });

  return [list, launch, run, batch, installBridge];
}

export { DEFAULT_BASE_PORT };
