// End-to-end self-check for dsh-plugin-dcc-bridge.
//
// Runs outside DSH, with no agent and no approval service, so it exercises the
// tool bodies, the PowerShell agent, the DCC catalog and — when Blender is
// installed — a real bridge round trip. Anything it cannot verify is reported
// as skipped rather than passed, which is what makes this usable as a CI step
// on an operating system that has neither a desktop nor a 3D application.
//
//   node tools/selfcheck.mjs [--definitions-only] [--keep-blender]
//
// `--definitions-only` stops after the schema checks. Those need no operating
// system support at all, so they are the part worth running everywhere.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DesktopHost } from '../lib/ps.js';
import { createDesktopTools } from '../lib/desktop.js';
import { BridgeConnection, BRIDGE_SCRIPT, DCC_APPS, createDccTools, findInstallations, liveBridges } from '../lib/dcc.js';
import { removeDir, whichSync } from '../lib/proc.js';

/**
 * Locate a CPython for the protocol-only bridge test.
 *
 * Prefers an explicit override, then whatever the DSH runtime ships (which is
 * where a DSH user is most likely to already have one), then PATH.
 */
function findPython() {
  const override = process.env.DSH_PYTHON ?? process.env.PYTHON;
  if (override !== undefined && existsSync(override)) return override;
  const home = os.homedir();
  const shipped = path.join(
    home,
    '.dsh',
    'dsh-runtimes',
    'dsh-primary-runtime',
    'dependencies',
    'python',
    process.platform === 'win32' ? 'python.exe' : 'bin/python3',
  );
  if (existsSync(shipped)) return shipped;
  return (
    whichSync('python.exe') ?? whichSync('python3.exe') ?? whichSync('python3') ?? whichSync('python')
  );
}

const results = [];
const keepBlender = process.argv.includes('--keep-blender');
const definitionsOnly = process.argv.includes('--definitions-only');

function record(name, status, detail) {
  results.push({ name, status, detail });
  const mark = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function step(name, fn) {
  try {
    const detail = await fn();
    record(name, 'pass', detail);
    return true;
  } catch (error) {
    record(name, 'fail', error instanceof Error ? error.message : String(error));
    return false;
  }
}

function skip(name, detail) {
  record(name, 'skip', detail);
}

// --------------------------------------------------------------- schema check
// The registry enforces a deliberately small JSON Schema subset. This mirrors
// just enough of it to catch a definition that would be rejected at load time.

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples']);
const KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);

function checkSchema(node, pathLabel, violations) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${pathLabel} must be a schema object`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) violations.push(`${pathLabel}.${key} is not a supported keyword`);
  }
  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (hasType && hasOneOf) {
    violations.push(`${pathLabel} cannot declare both type and oneOf`);
    return;
  }
  if (!hasType && !hasOneOf) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) violations.push(`${pathLabel}.${key} requires type or oneOf`);
    }
    return;
  }
  if (hasOneOf) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${pathLabel}.oneOf must list at least two schemas`);
    else node.oneOf.forEach((child, index) => checkSchema(child, `${pathLabel}.oneOf[${index}]`, violations));
    return;
  }
  if (!SCHEMA_TYPES.includes(node.type)) {
    violations.push(`${pathLabel}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    return;
  }
  if (node.type === 'object') {
    if (Object.hasOwn(node, 'properties')) {
      for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${pathLabel}.properties.${key}`, violations);
    }
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${pathLabel}.required must be an array of strings`);
      } else {
        for (const key of node.required) {
          if (!Object.hasOwn(node.properties ?? {}, key)) violations.push(`${pathLabel}.required names "${key}" which is not declared`);
        }
      }
    }
  }
  if (node.type === 'array' && Object.hasOwn(node, 'items')) checkSchema(node.items, `${pathLabel}.items`, violations);
}

function validateValue(schema, value, pathLabel, violations) {
  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.some((child) => {
      const local = [];
      validateValue(child, value, pathLabel, local);
      return local.length === 0;
    });
    if (!matched) violations.push(`${pathLabel} matches none of the oneOf branches`);
    return;
  }
  const type = schema.type;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const ok =
    (type === 'object' && actual === 'object')
    || (type === 'array' && actual === 'array')
    || (type === 'string' && actual === 'string')
    || (type === 'boolean' && actual === 'boolean')
    || (type === 'number' && actual === 'number' && Number.isFinite(value))
    || (type === 'integer' && actual === 'number' && Number.isInteger(value))
    || (type === 'null' && actual === 'null');
  if (!ok) {
    violations.push(`${pathLabel} should be ${type} but is ${actual}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) violations.push(`${pathLabel} is not one of the enum values`);
  if (type === 'object') {
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) violations.push(`${pathLabel}.${key} is not declared`);
        continue;
      }
      validateValue(properties[key], value[key], `${pathLabel}.${key}`, violations);
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`${pathLabel}.${key} is required`);
    }
  }
  if (type === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => validateValue(schema.items, item, `${pathLabel}[${index}]`, violations));
  }
}

// ------------------------------------------------------------------ tool runs

const HOST = new DesktopHost({ logger: { warn: (m) => console.log(`      (warn: ${m})`) } });

function toolsFor(options = {}) {
  const list = [
    ...createDesktopTools({ host: HOST, resolveCwd: () => process.cwd() }),
    ...createDccTools(options),
  ];
  return new Map(list.map((definition) => [definition.name, definition]));
}

const TOOLS = toolsFor();

/** Execute a tool definition the way the registry would, and validate its value. */
async function call(name, args, options = {}) {
  const definition = TOOLS.get(name);
  if (definition === undefined) throw new Error(`no such tool: ${name}`);
  const value = await definition.execute(args ?? {}, { signal: options.signal });
  const violations = [];
  validateValue(definition.output.schema, value, 'value', violations);
  if (violations.length > 0) throw new Error(`output does not satisfy its schema: ${violations.join('; ')}`);
  const blocks = definition.output.render(args ?? {}, value);
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.some((b) => b.type !== 'text' || typeof b.text !== 'string')) {
    throw new Error('output.render did not return text content blocks');
  }
  return { value, text: blocks.map((b) => b.text).join('\n') };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log('dsh-plugin-dcc-bridge self-check');
  console.log(`node ${process.version} on ${process.platform}, temp ${os.tmpdir()}`);
  console.log('');

  console.log('— definitions —');
  await step('every tool declares a registry-valid schema', () => {
    const violations = [];
    for (const definition of TOOLS.values()) {
      if (typeof definition.name !== 'string' || definition.name.length === 0) violations.push('a tool has no name');
      if (typeof definition.description !== 'string' || definition.description.length < 20) {
        violations.push(`${definition.name} has a thin description`);
      }
      if (typeof definition.execute !== 'function') violations.push(`${definition.name} has no execute`);
      if (typeof definition.output?.render !== 'function') violations.push(`${definition.name} has no output.render`);
      checkSchema(definition.parameters, `${definition.name}.parameters`, violations);
      checkSchema(definition.output?.schema, `${definition.name}.output.schema`, violations);
    }
    if (violations.length > 0) throw new Error(violations.join('; '));
    return `${TOOLS.size} tools validated`;
  });

  if (definitionsOnly) {
    return report();
  }

  console.log('\n— desktop control —');
  if (process.platform !== 'win32') {
    // The definitions still exist off Windows so the schema check above is
    // meaningful, but nothing behind them can run: the agent is Win32 P/Invoke.
    skip('desktop_screenshot captures the virtual screen', 'Windows only');
    skip('desktop_window lists top-level windows', 'Windows only');
    skip('desktop_screenshot captures one window it just enumerated', 'Windows only');
    skip('desktop_mouse reports the cursor position', 'Windows only');
    skip('desktop_process lists processes', 'Windows only');
    skip('desktop_clipboard reads the clipboard', 'Windows only');
  } else {
    await desktopChecks();
  }

  async function desktopChecks() {
  await step('desktop_screenshot captures the virtual screen', async () => {
    const { value } = await call('desktop_screenshot', { target: 'screen' });
    if (!existsSync(value.path)) throw new Error(`no file at ${value.path}`);
    const size = statSync(value.path).size;
    if (size < 10000) throw new Error(`suspiciously small PNG (${size} bytes)`);
    if (value.width < 200 || value.height < 200) throw new Error(`implausible size ${value.width}x${value.height}`);
    return `${value.width}x${value.height}, ${size} bytes → ${value.path}`;
  });

  await step('desktop_window lists top-level windows', async () => {
    const { value } = await call('desktop_window', { action: 'list' });
    if (value.count === 0) throw new Error('no visible windows were enumerated');
    return `${value.count} windows, active "${value.windows.find((w) => w.foreground)?.title ?? '?'}"`;
  });

  await step('desktop_screenshot captures one window it just enumerated', async () => {
    const { value: listed } = await call('desktop_window', { action: 'list', exclude_minimized: true });
    const target = listed.windows.find((w) => w.width > 300 && w.height > 200);
    if (target === undefined) return 'no suitably sized window; nothing to capture';
    const { value } = await call('desktop_screenshot', {
      target: 'window',
      window: target.title,
      path: path.join(process.cwd(), '.dsh-screenshots', 'selfcheck-window.png'),
    });
    if (!existsSync(value.path)) throw new Error(`no file at ${value.path}`);
    return `"${target.title}" via ${value.method} (${value.width}x${value.height})`;
  });

  await step('desktop_mouse reports the cursor position', async () => {
    const { value } = await call('desktop_mouse', { action: 'position' });
    if (!Number.isInteger(value.x) || !Number.isInteger(value.y)) throw new Error('cursor position was not numeric');
    return `(${value.x}, ${value.y})`;
  });

  await step('desktop_process lists processes', async () => {
    const { value } = await call('desktop_process', { action: 'list', limit: 25 });
    if (!Number.isInteger(value.total)) throw new Error('total was not an integer');
    return `${value.total} visible process(es)`;
  });

  await step('desktop_clipboard reads the clipboard', async () => {
    const { value } = await call('desktop_clipboard', { action: 'read' });
    if (typeof value.text !== 'string') throw new Error('clipboard text was not a string');
    return `${value.text.length} character(s)`;
  });

  console.log(`\n      agent transport: ${HOST.transport}${HOST.transportNote ? ` (${HOST.transportNote})` : ''}`);
  }

  console.log('\n— 3D application bridge —');
  let blender;
  await step('dcc_list finds installed applications', async () => {
    const { value } = await call('dcc_list', {});
    const installed = value.apps.filter((a) => a.installed);
    blender = installed.find((a) => a.id === 'blender');
    if (installed.length === 0) return 'no supported DCC found on this machine (detection still ran cleanly)';
    return installed.map((a) => `${a.label}${a.path ? ` at ${a.path}` : ''}`).join('; ');
  });

  // ---- protocol round trip, with or without a DCC -------------------------
  //
  // The bridge's `--standalone` mode runs the identical server under plain
  // CPython. Every wire-level behaviour below is shared with the Blender host,
  // so this verifies the protocol even on a machine with no 3D software.
  const python = findPython();
  const bridgeScript = BRIDGE_SCRIPT;
  let standalone;
  if (python === undefined) {
    skip('bridge protocol round trips', 'no CPython was found for the protocol-only bridge');
  } else {
    const { spawn } = await import('node:child_process');
    standalone = spawn(python, [bridgeScript, '--', '--standalone', '--port', '47920', '--idle-seconds', '300'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    standalone.unref();
    await sleep(800);

    let advertisement;
    await step('the bridge advertises itself and accepts a connection', async () => {
      const deadline = Date.now() + 30000;
      for (;;) {
        const bridges = await liveBridges();
        const mine = bridges.find((b) => b.pid === standalone.pid);
        if (mine !== undefined) {
          advertisement = mine;
          return `port ${mine.port}, pid ${mine.pid}, discovered in ${JSON.stringify(path.basename(mine.discoveryFile))}`;
        }
        if (Date.now() > deadline) {
          const dirs = (await import('../lib/dcc.js')).discoveryDirs();
          throw new Error(`no live bridge advertisement appeared within the budget; searched ${JSON.stringify(dirs)}`);
        }
        await sleep(500);
      }
    });

    if (advertisement !== undefined) {
      // The bridge serves one client at a time, so the wrong-token case is
      // checked while nothing else holds it; otherwise the refused connection
      // would merely queue behind the good one.
      await step('bridge refuses a request carrying the wrong token', async () => {
        const rogue = await BridgeConnection.connect({ ...advertisement, token: 'not-the-token' }, 8000).catch(
          (error) => error,
        );
        if (rogue instanceof Error) return `handshake rejected: ${rogue.message.slice(0, 100)}`;
        rogue.close();
        throw new Error('a wrong token was accepted');
      });

      const connection = await BridgeConnection.connect(advertisement, 10000);
      try {
        await step('bridge captures stdout from executed code', async () => {
          const response = await connection.call('exec', { code: 'print("hello", 1 + 1)', mode: 'exec', timeout_ms: 20000 });
          if (response.ok !== true) throw new Error(`bridge error: ${response.error}`);
          if (response.stdout.trim() !== 'hello 2') throw new Error(`unexpected stdout: ${JSON.stringify(response.stdout)}`);
          return JSON.stringify(response.stdout.trim());
        });

        await step('bridge keeps state between calls and evaluates expressions', async () => {
          await connection.call('exec', { code: 'dsh_marker = 41', mode: 'exec', timeout_ms: 20000 });
          const response = await connection.call('eval', { code: 'dsh_marker + 1', mode: 'eval', timeout_ms: 20000 });
          if (response.result !== '42') throw new Error(`expected 42, got ${JSON.stringify(response.result)}`);
          return 'namespace persists across calls';
        });

        await step('bridge reports script failures as data, not transport errors', async () => {
          const response = await connection.call('exec', { code: 'raise ValueError("boom")', mode: 'exec', timeout_ms: 20000 });
          if (response.ok !== true) throw new Error('a script error was reported as a transport failure');
          if (!String(response.error ?? '').includes('ValueError')) throw new Error(`no ValueError in ${JSON.stringify(response.error)}`);
          return 'traceback came back in the response payload';
        });

        await step('bridge answers ping with its own status', async () => {
          const response = await connection.call('ping', {}, 20000);
          if (response.ok !== true || typeof response.status?.port !== 'number') throw new Error(`unexpected ping reply: ${JSON.stringify(response)}`);
          return `processed ${response.status.processed} request(s)`;
        });
      } finally {
        connection.close();
      }
    } else {
      skip('bridge protocol round trips', 'the standalone bridge never came up');
    }

    if (!keepBlender) {
      try {
        process.kill(standalone.pid);
      } catch {
        /* already gone */
      }
      // Let the advertisement disappear, so the Blender section cannot pick up
      // this protocol-only bridge when it asks for a live `blender` bridge.
      await sleep(1200);
    } else {
      console.log(`      (left the standalone bridge pid ${standalone.pid} running)`);
    }
  }

  // ---- the real Blender integration --------------------------------------
  if (blender?.path === undefined) {
    skip('dcc_batch runs Python inside headless Blender', 'no Blender installation was detected');
    skip('dcc_launch starts Blender with a live bridge attached', 'no Blender installation was detected');
    skip('dcc_run executes bpy inside the launched session', 'no Blender installation was detected');
  } else {
    await step('dcc_batch runs Python inside headless Blender', async () => {
      const { value } = await call('dcc_batch', {
        app: 'blender',
        timeoutMs: 180000,
        code: [
          'import bpy',
          'bpy.ops.mesh.primitive_cube_add(size=2)',
          'print("SELFCHECK_VERSION", bpy.app.version_string)',
          'print("SELFCHECK_HAS_CUBE", any(o.name.startswith("Cube") for o in bpy.data.objects))',
        ].join('\n'),
      });
      if (value.timedOut) throw new Error('headless Blender timed out');
      if (!value.stdout?.includes('SELFCHECK_HAS_CUBE True')) {
        throw new Error(`unexpected output: ${JSON.stringify((value.stdout ?? '').slice(-400))}`);
      }
      const version = /SELFCHECK_VERSION (\S+)/.exec(value.stdout)?.[1];
      return `exit ${value.exitCode} in ${value.durationMs}ms; bpy ${version} ran a real operator`;
    });

    let launchedPid;
    let launchedPort;
    await step('dcc_launch starts Blender with a live bridge attached', async () => {
      // `-b` is passed through as a caller argument, so Blender runs headless:
      // the launch path is exercised without opening a window on the desktop.
      const { value } = await call('dcc_launch', {
        app: 'blender',
        bridge: true,
        port: 47930,
        waitMs: 90000,
        extraArgs: ['-b'],
      });
      launchedPid = value.pid;
      launchedPort = value.port;
      if (value.port === undefined) throw new Error(`no live bridge was reported: ${value.bridge}`);
      return `pid ${value.pid} → ${value.bridge}`;
    });

    if (launchedPort === undefined) {
      skip('dcc_run executes bpy inside the launched session', 'dcc_launch did not produce a live bridge');
    } else {
      await step('dcc_run executes bpy inside the launched session', async () => {
        const { value } = await call('dcc_run', {
          app: 'blender',
          port: launchedPort,
          timeoutMs: 60000,
          code: [
            'import bpy',
            'bpy.ops.mesh.primitive_cube_add(size=2)',
            'print("RUN_CUBE", any(o.name.startswith("Cube") for o in bpy.data.objects))',
            'bpy.app.version_string',
          ].join('\n'),
        });
        if (value.ok !== true) throw new Error(`dcc_run reported failure: ${value.error}`);
        if (value.error !== undefined) throw new Error(`script error: ${value.error}`);
        if (!value.stdout?.includes('RUN_CUBE True')) throw new Error(`unexpected stdout: ${JSON.stringify(value.stdout)}`);
        return `bpy operator ran; version ${value.result ?? 'unknown'}`;
      });

      await step('dcc_run surfaces a script traceback', async () => {
        const { value } = await call('dcc_run', {
          app: 'blender',
          port: launchedPort,
          timeoutMs: 30000,
          code: 'raise RuntimeError("deliberate")',
        });
        if (value.ok !== false) throw new Error('a failing script was reported as success');
        if (!String(value.error ?? '').includes('deliberate')) throw new Error(`no traceback in ${JSON.stringify(value.error)}`);
        return 'failure reported without throwing';
      });
    }

    if (launchedPid !== undefined && !keepBlender) {
      try {
        process.kill(launchedPid);
      } catch {
        /* already gone */
      }
    } else if (launchedPid !== undefined) {
      console.log(`      (left Blender pid ${launchedPid} running)`);
    }
  }

  // ------------------------------------------------------------------- report
  return report();
}

/** Print the tally, release the agent, and answer with the exit code. */
function report() {
  const failed = results.filter((r) => r.status === 'fail');
  const passed = results.filter((r) => r.status === 'pass');
  const skipped = results.filter((r) => r.status === 'skip');
  console.log('');
  console.log(`summary: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  if (failed.length > 0) {
    console.log('failures:');
    for (const failure of failed) console.log(`  - ${failure.name}: ${failure.detail}`);
  }
  HOST.dispose();
  removeDir(path.join(process.cwd(), '.dsh-screenshots'));
  return failed.length === 0 ? 0 : 1;
}

const code = await main();
process.exit(code);
