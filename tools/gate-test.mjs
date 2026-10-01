// Deterministic tests for the desktop approval gate.
//
// The gate is the one part of this plugin that cannot be exercised by simply
// calling a tool: whether it asks depends on the session, on a prior grant, and
// on whether an approval service is composed at all. So `apply()` is driven here
// against a mock context that records every approval request.
//
// The gate runs *before* the tool body, so this test asserts on the gate only:
// every body call is wrapped in `attempt()`, and a body that fails in a
// restricted environment (a sandbox can refuse `SetCursorPos`) does not affect
// the result. Where a distinction matters, it is made on the error text.
//
//   node tools/gate-test.mjs

import { apply } from '../lib/index.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Build a Cordis-shaped context that records tool registrations and approval
 * traffic.
 */
function makeContext(options = {}) {
  const definitions = new Map();
  const requests = [];
  const { outcome = 'allowed-once', compose = true } = options;

  const service = {
    async request(request) {
      requests.push(request);
      return typeof outcome === 'function' ? outcome(request) : outcome;
    },
  };

  const ctx = {
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return () => definitions.delete(definition.name);
      },
    },
    effect(fn) {
      return fn();
    },
    get(name) {
      return name === 'approval' && compose ? service : undefined;
    },
    inject(services, callback) {
      if (compose && services.includes('approval')) {
        callback({ approval: service, effect: (fn) => fn() });
      }
    },
  };
  return { ctx, definitions, requests };
}

const execFor = (id, callId = 'call-1') => ({ agent: { id, session: { id } }, callId });

/** Run one registered tool, capturing rather than propagating its body failure. */
async function attempt(definitions, name, args, exec) {
  const definition = definitions.get(name);
  if (definition === undefined) return { ok: false, error: new Error(`tool ${name} was not registered`) };
  try {
    return { ok: true, value: await definition.execute(args, exec) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The cursor position, so a `move` body is a no-op where the environment allows it. */
async function cursor(definitions, exec) {
  const outcome = await attempt(definitions, 'desktop_mouse', { action: 'position' }, exec);
  return outcome.ok ? { x: outcome.value.x, y: outcome.value.y } : { x: 0, y: 0 };
}

async function main() {
  console.log('dsh-plugin-dcc-bridge — approval gate tests\n');

  // --- read-only actions are never gated ---------------------------------
  {
    const { ctx, definitions, requests } = makeContext();
    apply(ctx, {});
    await attempt(definitions, 'desktop_window', { action: 'list' }, execFor('s-read'));
    check('read-only window listing is not gated', requests.length === 0, `${requests.length} approval request(s)`);
  }

  // --- a mutating action asks once, then is remembered for the session ----
  {
    const { ctx, definitions, requests } = makeContext();
    apply(ctx, {});
    const exec = execFor('s-memo');
    const at = await cursor(definitions, exec);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, exec);
    const afterFirst = requests.length;
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, exec);
    const afterSecond = requests.length;

    check('a mutating action asks for approval', afterFirst === 1, `${afterFirst} request(s)`);
    check('the same action is not asked again in one session', afterSecond === 1, `${afterSecond} request(s)`);
    check(
      'the request names the tool, the agent and a reason',
      requests[0]?.toolName === 'desktop_mouse'
        && requests[0]?.agent?.session?.id === 's-memo'
        && typeof requests[0]?.reason === 'string',
      JSON.stringify(requests[0]?.reason),
    );
  }

  // --- another session is asked again ------------------------------------
  {
    const { ctx, definitions, requests } = makeContext();
    apply(ctx, {});
    const first = execFor('session-one');
    const second = execFor('session-two');
    const at = await cursor(definitions, first);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, first);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, second);
    check('a different session is asked separately', requests.length === 2, `${requests.length} request(s)`);
  }

  // --- a rejection stops the call before the body runs --------------------
  {
    const { ctx, definitions, requests } = makeContext({ outcome: 'rejected' });
    apply(ctx, {});
    const outcome = await attempt(definitions, 'desktop_mouse', { action: 'move', x: 10, y: 10 }, execFor('s-deny'));
    check('a rejected approval throws', outcome.ok === false, outcome.error?.message?.slice(0, 80));
    check('a rejection is reported to the caller', /not approved \(rejected\)/.test(String(outcome.error?.message)), undefined);
    check('exactly one approval was requested', requests.length === 1, `${requests.length} request(s)`);
  }

  // --- an absent answerer fails closed ------------------------------------
  {
    const { ctx, definitions } = makeContext({ outcome: 'unavailable' });
    apply(ctx, {});
    const outcome = await attempt(definitions, 'desktop_mouse', { action: 'move', x: 10, y: 10 }, execFor('s-unavail'));
    check(
      'an unavailable answerer fails closed',
      /not approved \(unavailable\)/.test(String(outcome.error?.message)),
      outcome.error?.message?.slice(0, 80),
    );
  }

  // --- no agent, or no approval service: the call proceeds ----------------
  {
    const { ctx, definitions, requests } = makeContext();
    apply(ctx, {});
    const outcome = await attempt(definitions, 'desktop_mouse', { action: 'position' }, {});
    // `position` is read-only, so a gate probe needs a mutating action.
    const moved = await attempt(definitions, 'desktop_mouse', { action: 'move', x: 0, y: 0 }, {});
    check(
      'a caller with no owning agent is not gated',
      requests.length === 0 && (outcome.ok || moved.ok || moved.error !== undefined),
      `${requests.length} request(s)`,
    );
  }
  {
    const { ctx, definitions, requests } = makeContext({ compose: false });
    apply(ctx, {});
    const exec = execFor('s-noservice');
    const at = await cursor(definitions, exec);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, exec);
    check('a composition without an approval service is not gated', requests.length === 0, `${requests.length} request(s)`);
  }

  // --- inputApproval: never / always --------------------------------------
  {
    const { ctx, definitions, requests } = makeContext();
    apply(ctx, { inputApproval: 'never' });
    const exec = execFor('s-never');
    const at = await cursor(definitions, exec);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, exec);
    check('inputApproval "never" disables the gate', requests.length === 0, `${requests.length} request(s)`);
  }
  {
    const { ctx, definitions, requests } = makeContext();
    apply(ctx, { inputApproval: 'always' });
    const exec = execFor('s-always');
    const at = await cursor(definitions, exec);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, exec);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, exec);
    check('inputApproval "always" asks every time', requests.length === 2, `${requests.length} request(s)`);
  }

  // --- the Cordis inject path alone is enough ------------------------------
  {
    const { ctx, definitions, requests } = makeContext();
    ctx.get = () => undefined; // only the injected reference can satisfy the gate
    apply(ctx, {});
    const exec = execFor('s-inject');
    const at = await cursor(definitions, exec);
    await attempt(definitions, 'desktop_mouse', { action: 'move', x: at.x, y: at.y }, exec);
    check('the injected approval service alone satisfies the gate', requests.length === 1, `${requests.length} request(s)`);
  }

  // --- coverage across the mutating surface --------------------------------
  {
    const { ctx, definitions, requests } = makeContext();
    apply(ctx, {});
    const exec = execFor('s-cover');
    const cases = [
      ['desktop_keyboard', { action: 'key', key: 'shift' }, true],
      ['desktop_clipboard', { action: 'clear' }, true],
      ['desktop_process', { action: 'list' }, false],
      ['desktop_window', { action: 'list' }, false],
    ];
    for (const [name, args, shouldAsk] of cases) {
      const before = requests.length;
      await attempt(definitions, name, args, exec);
      const asked = requests.length > before;
      check(
        `${name} ${JSON.stringify(args)} ${shouldAsk ? 'is' : 'is not'} gated`,
        asked === shouldAsk,
        asked !== shouldAsk ? `asked=${asked}` : undefined,
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nsummary: ${results.length - failed.length} passed, ${failed.length} failed`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
