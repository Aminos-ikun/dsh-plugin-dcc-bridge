// dsh-plugin-dcc-bridge — host plugin entry.
//
// Registers two capability groups on `ctx.tools`:
//
//   desktop_*  Windows screen, pointer, keyboard, window, process and clipboard
//              control, carried by a warm PowerShell agent (`lib/ps.js`).
//   dcc_*      3D application discovery, launch, in-app Python over a loopback
//              bridge, and headless batch runs (`lib/dcc.js`).
//
// The plugin deliberately imports nothing from `@deepseek-ai/*`. A plugin that
// lives in a DSH profile cannot resolve those packages — they exist only inside
// the application's own bundle — so every definition here is written in the raw
// registry form instead of going through `defineTool`.

import { DesktopHost } from './ps.js';
import { createDesktopTools } from './desktop.js';
import { createDccTools } from './dcc.js';

/** Named export the loader uses for diagnostics and the profile patch row. */
export const name = 'dcc-bridge';

/** The only service this plugin needs at apply time. */
export const inject = ['tools'];

/** Upper bound on remembered per-session input grants. */
const GRANT_LIMIT = 512;

/**
 * Which argument combinations of a tool actually change the machine.
 *
 * Read-only actions are never gated: listing windows or reading the clipboard
 * happens constantly and asking about it would train the user to approve
 * blindly. Anything that moves the pointer, types, or changes state is.
 */
const MUTATING = {
  desktop_mouse: (args) => args.action !== 'position',
  desktop_keyboard: () => true,
  desktop_clipboard: (args) => args.action !== 'read',
  desktop_process: (args) => args.action !== 'list',
  desktop_window: (args) => args.action !== 'list',
};

/** One-line reason shown in the approval prompt. */
function describeIntent(toolName, args) {
  switch (toolName) {
    case 'desktop_mouse':
      return `take control of the mouse (${args.action})`;
    case 'desktop_keyboard':
      return args.action === 'type' ? 'type text into the focused window' : `press keys (${args.action})`;
    case 'desktop_clipboard':
      return `change the clipboard (${args.action})`;
    case 'desktop_process':
      return `${args.action} a process`;
    case 'desktop_window':
      return `${args.action} a window`;
    default:
      return `use ${toolName}`;
  }
}

/**
 * Register every tool and own the resources behind them.
 * @param ctx - the plugin context.
 * @param config - optional deployment configuration.
 */
export function apply(ctx, config) {
  const settings = config ?? {};
  const logger = ctx.logger ?? console;
  const enableDesktop = settings.enableDesktop !== false;
  const enableDcc = settings.enableDcc !== false;
  const inputApproval = settings.inputApproval ?? 'session';

  /** @type {Map<string, Set<string>>} */
  const grants = new Map();

  /**
   * The approval service, resolved two ways.
   *
   * `ctx.inject` is Cordis's declared-dependency path and is what the official
   * plugins use; the lazy `ctx.get` fallback covers a composition where the
   * callback has not run yet. Either way the gate fails open *only* when there
   * is no service to ask, which is deliberate: a missing service must not make
   * the desktop tools unusable.
   */
  let approval;
  try {
    ctx.inject?.(['approval'], (scoped) => {
      approval = scoped.approval;
      scoped.effect?.(
        () => () => {
          approval = undefined;
        },
        'dcc-bridge.approval',
      );
    });
  } catch {
    /* a context without inject simply uses the lazy lookup below */
  }

  const approvalService = () => {
    if (approval !== undefined) return approval;
    try {
      return ctx.get('approval');
    } catch {
      return undefined;
    }
  };

  /**
   * Ask the user before the first machine-changing action of a session.
   *
   * Fail-closed by construction: any outcome other than `allowed-once` — a
   * rejection, an abort, or a missing answerer — stops the call. Callers with
   * no owning agent (self-checks, scripts) are not gated, because there is no
   * user to ask.
   */
  const gate = async (exec, toolName, args) => {
    if (inputApproval === 'never') return;
    const agent = exec?.agent;
    if (agent === undefined) return;
    const service = approvalService();
    if (service === undefined) return;

    const key = String(agent.session.id);
    if (inputApproval === 'session' && grants.get(key)?.has(toolName) === true) return;

    const outcome = await service.request({
      agent,
      toolName,
      callId: exec.callId,
      reason: `The agent wants to ${describeIntent(toolName, args)}.`,
      signal: exec.signal,
    });
    if (outcome !== 'allowed-once') {
      throw new Error(
        `desktop control was not approved (${outcome}). `
          + 'Approve the prompt to continue, or set the plugin\'s inputApproval to "never" to run these tools unattended.',
      );
    }
    if (inputApproval === 'session') {
      const set = grants.get(key) ?? new Set();
      set.add(toolName);
      if (grants.size > GRANT_LIMIT) grants.delete(grants.keys().next().value);
      grants.set(key, set);
    }
  };

  /** Wrap the mutating tools so the approval gate runs before their body. */
  const guarded = (definition) => {
    const predicate = MUTATING[definition.name];
    if (predicate === undefined || inputApproval === 'never') return definition;
    const run = definition.execute;
    return {
      ...definition,
      execute: async (args, exec) => {
        if (predicate(args ?? {})) await gate(exec, definition.name, args ?? {});
        return run(args, exec);
      },
    };
  };

  const registered = [];

  if (enableDesktop) {
    if (process.platform !== 'win32') {
      logger.warn?.('dcc-bridge: desktop tools are Windows-only and will not be registered on this platform');
    } else {
      const host = new DesktopHost({ logger });
      ctx.effect(() => () => host.dispose(), 'dcc-bridge.desktop-agent');
      const resolveCwd = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();
      for (const definition of createDesktopTools({ host, resolveCwd })) {
        registered.push(guarded(definition));
      }
    }
  }

  if (enableDcc) {
    for (const definition of createDccTools({
      enabledApps: Array.isArray(settings.dccApps) ? settings.dccApps : [],
      extraPaths: settings.extraPaths ?? {},
    })) {
      registered.push(definition);
    }
  }

  for (const definition of registered) {
    ctx.tools.register(definition);
  }

  logger.info?.(
    `dcc-bridge: registered ${registered.length} tool(s) `
      + `(${registered.filter((d) => d.name.startsWith('desktop_')).length} desktop, `
      + `${registered.filter((d) => d.name.startsWith('dcc_')).length} dcc, inputApproval=${inputApproval})`,
  );
}
