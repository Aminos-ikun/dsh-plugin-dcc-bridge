// Desktop-control tools: screen capture, pointer, keyboard, windows, processes
// and clipboard, all through the Windows agent hosted in `./ps.js`.
//
// Every tool here is a thin, strict shim: it validates the argument combination
// the model asked for, resolves paths against the session workspace, forwards one
// action to the agent, and renders the reply. The interesting logic lives in the
// agent, which is where the native calls are.

import { condense, fileStamp, resolveOutputPath, text, tool } from './tool.js';

/** Card-free text output schema for tools that only report success. */
const OK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean', description: 'Whether the action was carried out.' },
    detail: { type: 'string', description: 'One-line description of what happened.' },
  },
};

/** Render an `OK_SCHEMA` value. */
const renderOk = (_args, value) => text(value.detail ?? (value.ok ? 'ok' : 'failed'));

const SCREENSHOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'target', 'width', 'height', 'bytes'],
  properties: {
    path: { type: 'string', description: 'Absolute path of the written PNG.' },
    target: { type: 'string', description: 'What was captured: virtual-screen, monitor, window or region.' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    bytes: { type: 'integer' },
    method: { type: 'string', description: 'Capture path used: printwindow or screen-region.' },
    monitor: { type: 'integer' },
    window: { type: 'string', description: 'Title of the captured window, when one was targeted.' },
  },
};

const WINDOW_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string' },
    count: { type: 'integer' },
    windows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          handle: { type: 'string' },
          pid: { type: 'integer' },
          process: { type: 'string' },
          title: { type: 'string' },
          class: { type: 'string' },
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          minimized: { type: 'boolean' },
          foreground: { type: 'boolean' },
        },
      },
    },
    match: { type: 'string' },
    result: { type: 'string' },
    handle: { type: 'string' },
  },
};

const PROCESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string' },
    total: { type: 'integer' },
    processes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pid: { type: 'integer' },
          name: { type: 'string' },
          title: { type: 'string' },
          path: { type: 'string' },
          memoryMB: { type: 'number' },
        },
      },
    },
    pid: { type: 'integer' },
    name: { type: 'string' },
    killed: { type: 'boolean' },
    detail: { type: 'string' },
  },
};

/**
 * Format a window row for the model.
 * @param w - one window record from the agent.
 * @returns a single line.
 */
function windowLine(w) {
  const marks = [w.foreground ? 'ACTIVE' : undefined, w.minimized ? 'minimized' : undefined]
    .filter(Boolean)
    .join(',');
  const owner = w.process === undefined || w.process === null ? `pid ${w.pid}` : `pid ${w.pid} ${w.process}`;
  return `- "${w.title}" [handle ${w.handle}, ${owner}${marks.length > 0 ? `, ${marks}` : ''}] ${w.width}x${w.height} at (${w.x},${w.y})`;
}

/**
 * Create the desktop-control tool set.
 * @param options - wiring.
 * @param options.host - the desktop agent host.
 * @param options.resolveCwd - maps one tool execution to its session workspace.
 * @returns registry-ready tool definitions.
 */
export function createDesktopTools({ host, resolveCwd }) {
  const screenCapture = tool({
    name: 'desktop_screenshot',
    description:
      'Capture the Windows desktop and write it to a PNG file, returning the path. Use `target` to choose the whole virtual screen, one monitor, a single window (by title substring, captured even when it is behind other windows), or an explicit pixel region. '
      + 'The file is written where you ask; call read_image on the returned path to actually look at it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['screen', 'monitor', 'window', 'region'],
          description: 'What to capture. Defaults to `screen` (the whole virtual desktop across all monitors).',
        },
        window: { type: 'string', description: 'With target `window`: a substring of the window title. The first visible match wins.' },
        handle: { type: 'string', description: 'With target `window`: an exact window handle from desktop_window.' },
        monitor: { type: 'integer', description: 'With target `monitor`: zero-based monitor index.' },
        x: { type: 'integer', description: 'With target `region`: left edge in screen pixels.' },
        y: { type: 'integer', description: 'With target `region`: top edge in screen pixels.' },
        width: { type: 'integer', description: 'With target `region`: region width.' },
        height: { type: 'integer', description: 'With target `region`: region height.' },
        path: { type: 'string', description: 'Output PNG path. Relative paths resolve against the session workspace. Defaults to .dsh-screenshots/screen-<timestamp>.png.' },
        method: {
          type: 'string',
          enum: ['auto', 'printwindow', 'screen'],
          description: 'Window capture strategy. `printwindow` works on occluded windows; `screen` copies the on-screen pixels instead. Defaults to `auto`.',
        },
      },
    },
    output: {
      schema: SCREENSHOT_SCHEMA,
      render: (_args, value) =>
        text(
          `Captured ${value.target}${value.window === undefined ? '' : ` "${value.window}"`} (${value.width}x${value.height}, ${
            value.bytes
          } bytes${value.method === undefined ? '' : `, ${value.method}`}) to:\n${value.path}\nCall read_image on that path to view it.`,
        ),
    },
    async execute(args, exec) {
      const target = args.target ?? 'screen';
      const cwd = resolveCwd(exec);
      const outPath = resolveOutputPath(args.path, cwd, `screen-${fileStamp()}.png`);
      const params = { path: outPath, method: args.method ?? 'auto' };
      if (target === 'window') {
        if (args.window === undefined && args.handle === undefined) {
          throw new Error('desktop_screenshot with target "window" needs either `window` (title substring) or `handle`');
        }
        params.match = args.window;
        params.handle = args.handle;
      } else if (target === 'monitor') {
        params.monitor = args.monitor ?? 0;
      } else if (target === 'region') {
        for (const key of ['x', 'y', 'width', 'height']) {
          if (args[key] === undefined) throw new Error(`desktop_screenshot with target "region" needs \`${key}\``);
        }
        params.x = args.x;
        params.y = args.y;
        params.width = args.width;
        params.height = args.height;
      } else if (target !== 'screen') {
        throw new Error(`desktop_screenshot: unknown target ${JSON.stringify(target)}`);
      }

      const data = await host.request('screen.capture', params, { timeoutMs: 60000, signal: exec.signal });
      return {
        path: data.path,
        target: data.target,
        width: data.width,
        height: data.height,
        bytes: data.bytes,
        ...(data.method === undefined ? {} : { method: data.method }),
        ...(data.monitor === undefined ? {} : { monitor: data.monitor }),
        ...(data.window?.title === undefined ? {} : { window: data.window.title }),
      };
    },
  });

  const mouse = tool({
    name: 'desktop_mouse',
    description:
      'Drive the mouse: read the cursor position, move it, click, double-click, right/middle-click, drag from one point to another, or scroll the wheel. '
      + 'Coordinates are absolute screen pixels. A drag interpolates intermediate positions so 3D viewports and sliders register it as a real gesture.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['position', 'move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll'],
          description: 'What to do. `position` only reads the cursor.',
        },
        x: { type: 'integer', description: 'Target X. For `drag` this is the drop point. Optional for clicks (current position is used).' },
        y: { type: 'integer', description: 'Target Y. For `drag` this is the drop point.' },
        from_x: { type: 'integer', description: 'For `drag`: press point X. Defaults to the current cursor position.' },
        from_y: { type: 'integer', description: 'For `drag`: press point Y.' },
        from_window: { type: 'string', description: 'For `drag`: press at the centre of the first window whose title contains this text.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Defaults to `left`.' },
        count: { type: 'integer', description: 'Click count (1-3). Defaults to 1; `double_click` implies 2.' },
        amount: { type: 'integer', description: 'For `scroll`: wheel notches. Positive scrolls up/away, negative scrolls down/toward. Defaults to 1.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          detail: { type: 'string' },
          x: { type: 'integer' },
          y: { type: 'integer' },
        },
      },
      render: (_args, value) => text(value.detail ?? 'ok'),
    },
    async execute(args, exec) {
      const data = await host.request('mouse', args, { timeoutMs: 30000, signal: exec.signal });
      const x = data.x;
      const y = data.y;
      if (args.action === 'position') {
        return { ok: true, detail: `Cursor is at (${x},${y}).`, x, y };
      }
      const describe = {
        move: `Moved the cursor to (${x},${y}).`,
        click: `Clicked ${data.button ?? 'left'} at (${x},${y}).`,
        double_click: `Double-clicked at (${x},${y}).`,
        right_click: `Right-clicked at (${x},${y}).`,
        middle_click: `Middle-clicked at (${x},${y}).`,
        drag: `Dragged from (${data.from_x},${data.from_y}) to (${x},${y}).`,
        scroll: `Scrolled ${data.amount} notch(es) at (${x},${y}).`,
      };
      return { ok: true, detail: describe[args.action] ?? `Done at (${x},${y}).`, x, y };
    },
  });

  const keyboard = tool({
    name: 'desktop_keyboard',
    description:
      'Type text or press keys on the focused window: `type` sends literal characters (any Unicode, including CJK, via KEYEVENTF_UNICODE), `key` presses one named key, `hotkey` holds several modifiers/keys together. '
      + 'Focus the target window first with desktop_window.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['type', 'key', 'hotkey'], description: 'What to do.' },
        text: { type: 'string', description: 'For `type`: the literal text to enter.' },
        key: { type: 'string', description: 'For `key`: a key name such as `enter`, `tab`, `esc`, `f1`, `left`, `space`, `delete`, or a single character.' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'For `hotkey`: key names pressed in order and released in reverse, e.g. ["ctrl","shift","s"].',
        },
        interval_ms: { type: 'integer', description: 'Delay between key events for `hotkey`. Defaults to 0.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          detail: { type: 'string' },
          count: { type: 'integer' },
        },
      },
      render: (_args, value) => text(value.detail ?? 'ok'),
    },
    async execute(args, exec) {
      const data = await host.request('keyboard', args, { timeoutMs: 30000, signal: exec.signal });
      if (args.action === 'type') {
        return { ok: true, detail: `Typed ${data.typed} character(s).`, count: data.typed };
      }
      if (args.action === 'key') {
        return { ok: true, detail: `Pressed ${data.key}.`, count: 1 };
      }
      return { ok: true, detail: `Pressed ${data.keys.join('+')}.`, count: data.keys.length };
    },
  });

  const window_ = tool({
    name: 'desktop_window',
    description:
      'Enumerate and manipulate top-level windows. Use `list` to discover windows (title, process, geometry, which one is active), then `focus`, `minimize`, `maximize`, `restore`, `close` or `move` one by title substring or exact handle. '
      + 'Focusing is the normal first step before typing or screenshotting a specific application.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'hide', 'close', 'move'],
          description: 'What to do.',
        },
        match: { type: 'string', description: 'Window title substring (case-insensitive). The first visible match wins.' },
        handle: { type: 'string', description: 'Exact window handle, from a previous `list`.' },
        x: { type: 'integer', description: 'For `move`: new left edge. Omit to keep the current value.' },
        y: { type: 'integer', description: 'For `move`: new top edge.' },
        width: { type: 'integer', description: 'For `move`: new width.' },
        height: { type: 'integer', description: 'For `move`: new height.' },
        exclude_minimized: { type: 'boolean', description: 'For `list`: skip minimized windows.' },
      },
    },
    output: { schema: WINDOW_LIST_SCHEMA, render: (_args, value) => {
      if (value.action !== 'list') {
        return text(`${value.action} → ${value.result ?? 'ok'}${value.handle === undefined ? '' : ` (handle ${value.handle})`}`);
      }
      if (value.count === 0) return text('No visible top-level windows matched.');
      return text(`${value.count} window(s):\n${value.windows.map(windowLine).join('\n')}`);
    } },
    async execute(args, exec) {
      if (args.action === 'list') {
        const data = await host.request('window.list', { match: args.match, exclude_minimized: args.exclude_minimized }, { timeoutMs: 30000, signal: exec.signal });
        return { action: 'list', count: data.count, windows: data.windows };
      }
      const data = await host.request('window.action', args, { timeoutMs: 30000, signal: exec.signal });
      return {
        action: args.action,
        handle: String(data.window?.handle ?? ''),
        ...(data.window?.title ? { match: data.window.title } : {}),
        result: data.result ?? 'ok',
      };
    },
  });

  const process_ = tool({
    name: 'desktop_process',
    description:
      'List running processes, launch a program, or terminate one. '
      + 'Process visibility depends on the privileges the DSH host itself runs with, so a short list is a permissions fact, not a bug.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'launch', 'kill'], description: 'What to do.' },
        match: { type: 'string', description: 'For `list`: keep only process names containing this text.' },
        limit: { type: 'integer', description: 'For `list`: maximum rows returned. Defaults to 200.' },
        path: { type: 'string', description: 'For `launch`: executable path.' },
        args: { type: 'array', items: { type: 'string' }, description: 'For `launch`: argument vector.' },
        workdir: { type: 'string', description: 'For `launch`: working directory.' },
        pid: { type: 'integer', description: 'For `kill`: process id.' },
      },
    },
    output: {
      schema: PROCESS_SCHEMA,
      render: (_args, value) => {
        if (value.action === 'list') {
          if (value.total === 0) return text('No matching processes were visible to the DSH host.');
          const rows = value.processes
            .map((p) => `- ${p.name} (pid ${p.pid}${p.title ? `, "${p.title}"` : ''})`)
            .join('\n');
          return text(`${value.total} process(es)${value.total > value.processes.length ? `, showing ${value.processes.length}` : ''}:\n${rows}`);
        }
        return text(value.detail ?? 'ok');
      },
    },
    async execute(args, exec) {
      if (args.action === 'list') {
        const data = await host.request('process.list', { match: args.match, limit: args.limit }, { timeoutMs: 30000, signal: exec.signal });
        return { action: 'list', total: data.total, processes: data.processes };
      }
      if (args.action === 'launch') {
        if (args.path === undefined) throw new Error('desktop_process launch needs `path`');
        const data = await host.request('process.launch', { path: args.path, args: args.args, workdir: args.workdir }, { timeoutMs: 30000, signal: exec.signal });
        return { action: 'launch', pid: data.pid, detail: `Launched ${data.path} (pid ${data.pid}).` };
      }
      if (args.pid === undefined) throw new Error('desktop_process kill needs `pid`');
      const data = await host.request('process.kill', { pid: args.pid }, { timeoutMs: 30000, signal: exec.signal });
      return { action: 'kill', pid: data.pid, name: data.name, killed: true, detail: `Terminated ${data.name} (pid ${data.pid}).` };
    },
  });

  const clipboard = tool({
    name: 'desktop_clipboard',
    description:
      'Read or write the Windows clipboard as text. Useful for moving data in and out of applications that have no scripting bridge.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'write', 'clear'], description: 'What to do.' },
        text: { type: 'string', description: 'For `write`: the text to place on the clipboard.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          detail: { type: 'string' },
          text: { type: 'string' },
          length: { type: 'integer' },
        },
      },
      render: (_args, value) =>
        value.text === undefined
          ? text(value.detail ?? 'ok')
          : text(value.text.length === 0 ? 'The clipboard is empty (no text).' : condense(value.text, 4000)),
    },
    async execute(args, exec) {
      if (args.action === 'read') {
        const data = await host.request('clipboard.read', {}, { timeoutMs: 30000, signal: exec.signal });
        return { ok: true, text: data.text, length: data.text.length };
      }
      if (args.action === 'write') {
        if (args.text === undefined) throw new Error('desktop_clipboard write needs `text`');
        const data = await host.request('clipboard.write', { text: args.text }, { timeoutMs: 30000, signal: exec.signal });
        return { ok: true, length: data.length, detail: `Wrote ${data.length} character(s) to the clipboard.` };
      }
      await host.request('clipboard.clear', {}, { timeoutMs: 30000, signal: exec.signal });
      return { ok: true, detail: 'Cleared the clipboard.' };
    },
  });

  return [screenCapture, mouse, keyboard, window_, process_, clipboard];
}
