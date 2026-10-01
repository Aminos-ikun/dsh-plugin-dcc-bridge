# Security policy

This plugin hands an AI agent real control over a Windows desktop and over the
scripting interface of 3D applications. That is the point of it, and it is also
the reason to read this file before installing it.

## Reporting a vulnerability

Open a private security advisory on the repository (GitHub → **Security** →
**Advisories** → **Report a vulnerability**). Please do not open a public issue
for anything that lets a non-owner process reach the bridge, escape the approval
gate, or run code outside the session that asked for it.

## What the plugin can do

| Capability | Reach |
| --- | --- |
| `desktop_mouse`, `desktop_keyboard` | Synthesises real input on the interactive desktop, to whatever window has focus |
| `desktop_process` | Starts programs, terminates processes by pid |
| `desktop_clipboard` | Reads and writes the shared clipboard |
| `desktop_screenshot` | Writes a PNG of the screen or of a named window |
| `dcc_run` | Executes Python inside a 3D application, with that application's privileges |

There is no sandbox of its own. The plugin runs in the DSH host process and the
PowerShell agent it starts is an ordinary process owned by your user. Whatever
your user can do, a tool call can do.

## The controls that do exist

- **Approval gate.** Machine-changing desktop actions ask once per tool per
  session by default. Read-only actions never ask. See `inputApproval` in the
  README. Note the deliberate failure mode: if the composed approval service is
  unreachable, or the caller has no owning agent, the gate does not ask — it
  cannot prompt a user who is not there, and refusing outright would make the
  tools unusable. Set `inputApproval: "never"` if you would rather have no
  prompts at all.
- **Loopback only.** The 3D bridge binds `127.0.0.1`. It never listens on an
  external interface.
- **Per-start token.** Every bridge generates a random token at startup and
  rejects any request that does not carry it. The token is stored in a discovery
  file readable only by your user, so the trust boundary is your own account.
- **Discovery files are not code.** A bridge advertisement is read as data. It
  names a port, a pid and a token; it never causes anything to be executed.
- **No network egress.** The plugin makes no outbound connection of its own. Its
  only sockets are loopback connections to bridges it discovered.

## Operational guidance

- Run the plugin only in a profile you are willing to let an agent drive.
- Do not set `inputApproval: "never"` on a machine that is not disposable or
  supervised.
- Treat `dcc_run` exactly as you would treat a terminal open inside the 3D
  application: the code is the agent's, executed with your privileges.
- The bridge lives as long as the 3D application session (and exits after an
  idle period by default). Nothing is installed as a service, and nothing
  survives a reboot.
