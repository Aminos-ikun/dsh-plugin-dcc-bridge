"""DSH bridge for Blender — serve a loopback JSON bridge into a live Blender session.

This one file plays two roles:

* **Installed add-on.**  Copied into Blender's user ``scripts/addons`` directory,
  it registers a Start/Stop operator and a Viewport sidebar panel, and starts the
  bridge as soon as Blender enables it.
* **Bootstrap script.**  Run as ``blender --python blender_dsh_bridge.py -- --serve``
  it starts the bridge without installing anything.  With ``--background`` the
  script drives the request pump itself, because timers never fire without an
  event loop; with a GUI it hands the pump to ``bpy.app.timers``.

Protocol (one JSON object per line, loopback TCP only):

    -> {"id": "...", "token": "...", "op": "exec", "code": "...", "mode": "exec"}
    <- {"id": "...", "ok": true, "stdout": "...", "result": "...", "error": null}

Every request is executed on Blender's **main thread** — ``bpy`` is not
thread-safe — by posting it to a queue that a timer (or the bootstrap loop)
drains.  Responses therefore arrive one at a time, in order.
"""

bl_info = {
    "name": "DSH Bridge",
    "author": "dsh-plugin-dcc-bridge",
    "version": (0, 1, 0),
    "blender": (2, 93, 0),
    "location": "View3D > Sidebar > DSH",
    "description": "Serve a loopback JSON bridge so DSH can run Python inside this Blender session.",
    "category": "Development",
}

import contextlib
import io
import json
import os
import queue
import socket
import sys
import threading
import time
import traceback
import uuid

DEFAULT_BASE_PORT = 47810


def discovery_dirs():
    """Every directory a bridge advertises itself in, most preferred first.

    Deliberately not a single location: a Blender the user starts by hand and a
    Blender launched from DSH can carry different LOCALAPPDATA/TEMP values, and
    a confined parent may be denied one of them entirely.  The add-on writes to
    every directory it can, and readers scan all of them, so a bridge that is
    running is always findable.  ``DSH_DCC_BRIDGE_DIR`` overrides the list.
    """
    override = os.environ.get("DSH_DCC_BRIDGE_DIR")
    if override:
        return [override]
    dirs = []
    for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("APPDATA"), os.environ.get("TEMP")):
        if base:
            dirs.append(os.path.join(base, "dsh-dcc-bridge"))
    home = os.path.expanduser("~")
    dirs.append(os.path.join(home, ".dsh", "dcc-bridge"))
    seen = []
    for item in dirs:
        if item not in seen:
            seen.append(item)
    return seen


DISCOVERY_DIRS = discovery_dirs()
DISCOVERY_DIR = DISCOVERY_DIRS[0]
PUMP_INTERVAL = 0.02
EXECUTE_BUDGET = 0.6
DEFAULT_IDLE_SECONDS = 900


def _blender_version():
    try:
        import bpy

        return "%s.%s.%s" % tuple(bpy.app.version[0:3])
    except Exception:
        return "unknown"


def _is_background():
    try:
        import bpy

        return bool(bpy.app.background)
    except Exception:
        return False


class BridgeServer:
    """Loopback JSON bridge; executes code on the owning thread, never on its own."""

    def __init__(self, base_port=DEFAULT_BASE_PORT, token=None, idle_seconds=DEFAULT_IDLE_SECONDS):
        self.base_port = base_port
        self.token = token or uuid.uuid4().hex
        self.idle_seconds = idle_seconds
        self.port = None
        self.host = "127.0.0.1"
        self.pending = queue.Queue()
        self.namespace = {"__name__": "__dsh_bridge__", "__builtins__": __builtins__}
        self.running = False
        self.started_at = None
        self.last_activity = None
        self.processed = 0
        self.last_error = None
        self._listener = None
        self._thread = None
        self._watchdog_thread = None
        self._current_client = None
        self._discovery_files = []
        self._lock = threading.Lock()
        try:
            import bpy

            self.namespace["bpy"] = bpy
        except Exception:
            pass

    # ------------------------------------------------------------- lifecycle
    def start(self):
        if self.running:
            return self
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        bound = None
        for candidate in range(self.base_port, self.base_port + 64):
            try:
                self._listener.bind((self.host, candidate))
                bound = candidate
                break
            except OSError:
                continue
        if bound is None:
            self._listener.close()
            self._listener = None
            raise RuntimeError("no free port in %d..%d" % (self.base_port, self.base_port + 63))
        self._listener.listen(4)
        self.port = bound
        self.running = True
        self.started_at = time.time()
        self.last_activity = self.started_at
        self._thread = threading.Thread(target=self._accept_loop, name="dsh-bridge", daemon=True)
        self._thread.start()
        self._watchdog_thread = threading.Thread(target=self._watchdog, name="dsh-bridge-idle", daemon=True)
        self._watchdog_thread.start()
        self._write_discovery()
        return self

    def stop(self):
        self.running = False
        listener = self._listener
        self._listener = None
        if listener is not None:
            try:
                listener.close()
            except Exception:
                pass
        # Unblock a thread parked in readline() so the accept loop can finish.
        client = self._current_client
        if client is not None:
            try:
                client.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
        self._remove_discovery()
        return self

    @property
    def status(self):
        return {
            "running": self.running,
            "port": self.port,
            "processed": self.processed,
            "pid": os.getpid(),
            "idle_seconds": None if self.last_activity is None else round(time.time() - self.last_activity, 1),
            "last_error": self.last_error,
        }

    # ------------------------------------------------------------- discovery
    def _write_discovery(self):
        payload = {
            "app": "blender",
            "label": "Blender",
            "version": _blender_version(),
            "port": self.port,
            "host": self.host,
            "token": self.token,
            "pid": os.getpid(),
            "started": self.started_at,
            "background": _is_background(),
            "source": "blender-addon",
        }
        text = json.dumps(payload)
        written = []
        failures = []
        for directory in DISCOVERY_DIRS:
            try:
                os.makedirs(directory, exist_ok=True)
                path = os.path.join(directory, "blender-%d-%d.json" % (os.getpid(), self.port))
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(text)
                written.append(path)
            except Exception as exc:
                failures.append("%s: %s" % (directory, exc))
        self._discovery_files = written
        if not written:
            self.last_error = "discovery write failed everywhere: %s" % "; ".join(failures)
            print("[dsh-bridge] warning: could not advertise the bridge: %s" % self.last_error, file=sys.stderr)

    def _remove_discovery(self):
        for path in list(getattr(self, "_discovery_files", [])):
            try:
                os.remove(path)
            except Exception:
                pass
        self._discovery_files = []

    # ---------------------------------------------------------------- server
    def _accept_loop(self):
        while self.running:
            listener = self._listener
            if listener is None:
                break
            try:
                conn, _addr = listener.accept()
            except OSError:
                break
            try:
                self._serve_client(conn)
            except Exception as exc:
                self.last_error = "client error: %s" % exc
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
        self.running = False

    def _watchdog(self):
        """Close an idle bridge.

        Deliberately a separate thread rather than a socket timeout: setting a
        timeout on the client socket makes ``makefile().readline()`` raise after
        that timeout and, worse, leaves the buffered reader in an undefined
        state.  A bridge that drops its client one second into a pause is far
        more damaging than one that lingers.
        """
        while self.running:
            time.sleep(1.0)
            if self.last_activity is None:
                continue
            if time.time() - self.last_activity <= self.idle_seconds:
                continue
            self.stop()
            break

    def _serve_client(self, conn):
        reader = conn.makefile("r", encoding="utf-8", newline="\n")
        writer = conn.makefile("w", encoding="utf-8", newline="\n")
        self._current_client = conn
        try:
            while self.running:
                line = reader.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                self.last_activity = time.time()
                try:
                    request = json.loads(line)
                except Exception as exc:
                    writer.write(json.dumps({"id": None, "ok": False, "error": "bad json: %s" % exc}) + "\n")
                    writer.flush()
                    continue
                if self.token and request.get("token") != self.token:
                    writer.write(json.dumps({"id": request.get("id"), "ok": False, "error": "unauthorized: bad or missing token"}) + "\n")
                    writer.flush()
                    continue
                response = self._dispatch(request)
                writer.write(json.dumps(response) + "\n")
                writer.flush()
        finally:
            self._current_client = None
            try:
                reader.close()
                writer.close()
            except Exception:
                pass

    def _dispatch(self, request):
        op = request.get("op", "exec")
        if op == "hello":
            return {
                "id": request.get("id"),
                "ok": True,
                "app": "blender",
                "version": _blender_version(),
                "pid": os.getpid(),
                "background": _is_background(),
                "file": self._current_file(),
            }
        if op == "ping":
            return {"id": request.get("id"), "ok": True, "status": self.status}
        if op not in ("exec", "eval"):
            return {"id": request.get("id"), "ok": False, "error": "unknown op: %s" % op}

        holder = {"event": threading.Event(), "response": None}
        self.pending.put((request, holder))
        timeout = float(request.get("timeout_ms") or 30000) / 1000.0
        if not holder["event"].wait(timeout):
            return {
                "id": request.get("id"),
                "ok": False,
                "error": "timed out after %.0fms waiting for Blender's main thread" % (timeout * 1000.0),
            }
        return holder["response"]

    def _current_file(self):
        try:
            import bpy

            return bpy.data.filepath or None
        except Exception:
            return None

    # ------------------------------------------------------------------ pump
    def pump_once(self):
        """Drain queued work. Must be called on Blender's main thread."""
        started = time.time()
        while time.time() - started < EXECUTE_BUDGET:
            try:
                request, holder = self.pending.get_nowait()
            except queue.Empty:
                break
            try:
                holder["response"] = {"id": request.get("id"), "ok": True, **self._execute(request)}
            except BaseException:
                holder["response"] = {"id": request.get("id"), "ok": False, "error": traceback.format_exc()}
            finally:
                self.processed += 1
                self.last_activity = time.time()
                holder["event"].set()
        return PUMP_INTERVAL

    def _execute(self, request):
        code = request.get("code") or ""
        mode = request.get("mode") or "exec"
        buffer = io.StringIO()
        result = None
        error = None
        try:
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                compiled = compile(code, "<dsh-bridge>", "eval" if mode == "eval" else "exec")
                if mode == "eval":
                    result = eval(compiled, self.namespace)
                else:
                    exec(compiled, self.namespace)
        except BaseException:
            error = traceback.format_exc()
        return {
            "stdout": buffer.getvalue(),
            "result": None if result is None else repr(result),
            "error": error,
        }


# ------------------------------------------------------------------ singleton
_server = None
_timer_registered = False


def server():
    return _server


def start(base_port=DEFAULT_BASE_PORT, token=None, idle_seconds=DEFAULT_IDLE_SECONDS):
    """Start the process-wide bridge and hook up the main-thread pump."""
    global _server, _timer_registered
    if _server is not None and _server.running:
        return _server
    _server = BridgeServer(base_port=base_port, token=token, idle_seconds=idle_seconds).start()
    _install_pump()
    return _server


def stop():
    global _server, _timer_registered
    if _server is None:
        return None
    was = _server
    _uninstall_pump()
    was.stop()
    _server = None
    return was


def _install_pump():
    global _timer_registered
    if _server is None or _timer_registered:
        return
    try:
        import bpy
    except Exception:
        return
    if bpy.app.background:
        return  # the bootstrap loop drives the pump instead
    bpy.app.timers.register(_pump_timer, first_interval=PUMP_INTERVAL, persistent=True)
    _timer_registered = True


def _uninstall_pump():
    global _timer_registered
    if not _timer_registered:
        return
    try:
        import bpy

        if bpy.app.timers.is_registered(_pump_timer):
            bpy.app.timers.unregister(_pump_timer)
    except Exception:
        pass
    _timer_registered = False


def _pump_timer():
    if _server is None or not _server.running:
        _uninstall_pump()
        return None
    return _server.pump_once()


# --------------------------------------------------------------------- add-on
try:
    import bpy
    from bpy.props import IntProperty, StringProperty
    from bpy.types import Operator, Panel

    class DSH_OT_bridge_start(Operator):
        bl_idname = "dsh.bridge_start"
        bl_label = "Start DSH Bridge"
        bl_description = "Open the loopback bridge DSH uses to run Python in this session"

        def execute(self, context):
            try:
                active = start(base_port=int(context.scene.dsh_bridge_port))
            except Exception as exc:
                self.report({"ERROR"}, "DSH bridge failed: %s" % exc)
                return {"CANCELLED"}
            self.report({"INFO"}, "DSH bridge listening on 127.0.0.1:%d" % active.port)
            return {"FINISHED"}

    class DSH_OT_bridge_stop(Operator):
        bl_idname = "dsh.bridge_stop"
        bl_label = "Stop DSH Bridge"
        bl_description = "Close the loopback bridge"

        def execute(self, context):
            stopped = stop()
            if stopped is None:
                self.report({"INFO"}, "DSH bridge was not running")
            else:
                self.report({"INFO"}, "DSH bridge stopped")
            return {"FINISHED"}

    class DSH_PT_bridge(Panel):
        bl_label = "DSH Bridge"
        bl_idname = "DSH_PT_bridge"
        bl_space_type = "VIEW_3D"
        bl_region_type = "UI"
        bl_category = "DSH"

        def draw(self, context):
            layout = self.layout
            active = server()
            if active is not None and active.running:
                layout.label(text="Listening on 127.0.0.1:%d" % active.port, icon="LINKED")
                layout.label(text="Requests handled: %d" % active.processed)
                layout.operator("dsh.bridge_stop", icon="CANCEL")
            else:
                layout.label(text="Not running", icon="UNLINKED")
                layout.prop(context.scene, "dsh_bridge_port")
                layout.operator("dsh.bridge_start", icon="PLAY")

    _CLASSES = (DSH_OT_bridge_start, DSH_OT_bridge_stop, DSH_PT_bridge)

    def register():
        for cls in _CLASSES:
            bpy.utils.register_class(cls)
        if not hasattr(bpy.types.Scene, "dsh_bridge_port"):
            bpy.types.Scene.dsh_bridge_port = IntProperty(
                name="Base port",
                description="Lowest loopback port the DSH bridge may use",
                default=DEFAULT_BASE_PORT,
                min=1024,
                max=65535,
            )
        try:
            start(base_port=int(getattr(bpy.context.scene, "dsh_bridge_port", DEFAULT_BASE_PORT)))
        except Exception as exc:  # never block Blender startup on the bridge
            print("[dsh-bridge] autostart failed: %s" % exc)

    def unregister():
        stop()
        for cls in reversed(_CLASSES):
            try:
                bpy.utils.unregister_class(cls)
            except Exception:
                pass

except Exception:  # imported outside Blender (tests, plain CPython)
    _CLASSES = ()

    def register():
        pass

    def unregister():
        pass


# ----------------------------------------------------------------- bootstrap
def _parse_bootstrap_args(argv):
    port = DEFAULT_BASE_PORT
    token = None
    idle = DEFAULT_IDLE_SECONDS
    index = 0
    while index < len(argv):
        item = argv[index]
        if item == "--port" and index + 1 < len(argv):
            port = int(argv[index + 1])
            index += 2
            continue
        if item == "--token" and index + 1 < len(argv):
            token = argv[index + 1]
            index += 2
            continue
        if item == "--idle-seconds" and index + 1 < len(argv):
            idle = float(argv[index + 1])
            index += 2
            continue
        index += 1
    return port, token, idle


def _bootstrap():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    # `--standalone` runs the identical protocol server under plain CPython with
    # no Blender present.  Only the Blender-specific answers degrade (version,
    # background flag); transport, dispatch, the pending queue and error
    # reporting are the very same code paths, which makes the bridge testable
    # without a DCC installation.
    standalone = "--standalone" in argv
    try:
        import bpy
    except Exception:
        if not standalone:
            print(
                "[dsh-bridge] this script must run inside Blender "
                "(or pass --standalone for a protocol-only bridge)",
                file=sys.stderr,
            )
            return 2
        bpy = None

    port, token, idle = _parse_bootstrap_args(argv)
    active = start(base_port=port, token=token, idle_seconds=idle)
    background = True if bpy is None else bool(bpy.app.background)
    print(
        "[dsh-bridge] listening on 127.0.0.1:%d (pid %d, background=%s, standalone=%s)"
        % (active.port, os.getpid(), background, bpy is None)
    )
    sys.stdout.flush()

    if background:
        # No event loop exists, so this loop *is* the main thread's work queue.
        while active.running:
            active.pump_once()
            time.sleep(PUMP_INTERVAL)
        print("[dsh-bridge] stopped")
        return 0
    return 0


if __name__ == "__main__":
    _bootstrap()
