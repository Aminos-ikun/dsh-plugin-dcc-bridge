"""Protocol probe: find a live DSH bridge, run a few scripts through it, report.

Usage: python probe_blender.py [--wait SECONDS]
"""

import glob
import json
import os
import socket
import sys
import tempfile
import time
import uuid

def discovery_dirs():
    override = os.environ.get("DSH_DCC_BRIDGE_DIR")
    if override:
        return [override]
    dirs = []
    for base in (os.environ.get("LOCALAPPDATA"), os.environ.get("APPDATA"), os.environ.get("TEMP")):
        if base:
            dirs.append(os.path.join(base, "dsh-dcc-bridge"))
    dirs.append(os.path.join(os.path.expanduser("~"), ".dsh", "dcc-bridge"))
    seen = []
    for item in dirs:
        if item not in seen:
            seen.append(item)
    return seen


DISCOVERY_DIRS = discovery_dirs()


def find_bridge(wait_seconds=30.0):
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        paths = []
        for directory in DISCOVERY_DIRS:
            paths.extend(glob.glob(os.path.join(directory, "*.json")))
        for path in sorted(paths):
            try:
                with open(path, encoding="utf-8") as handle:
                    info = json.load(handle)
            except Exception:
                continue
            try:
                probe = socket.create_connection((info["host"], int(info["port"])), timeout=1.0)
                probe.close()
                info["discovery_path"] = path
                return info
            except OSError:
                continue
        time.sleep(0.5)
    return None


class Client:
    def __init__(self, host, port, token):
        self.sock = socket.create_connection((host, int(port)), timeout=120.0)
        self.reader = self.sock.makefile("r", encoding="utf-8", newline="\n")
        self.writer = self.sock.makefile("w", encoding="utf-8", newline="\n")
        self.token = token

    def call(self, op, code=None, mode="exec", timeout_ms=60000):
        request = {"id": uuid.uuid4().hex, "token": self.token, "op": op}
        if code is not None:
            request["code"] = code
            request["mode"] = mode
            request["timeout_ms"] = timeout_ms
        self.writer.write(json.dumps(request) + "\n")
        self.writer.flush()
        return json.loads(self.reader.readline())

    def close(self):
        try:
            self.reader.close()
            self.writer.close()
            self.sock.close()
        except Exception:
            pass


def main():
    wait = 30.0
    if "--wait" in sys.argv:
        wait = float(sys.argv[sys.argv.index("--wait") + 1])
    info = find_bridge(wait)
    if info is None:
        print("PROBE_FAIL no live bridge discovered in %s" % ", ".join(DISCOVERY_DIRS))
        return 1
    print("PROBE_DISCOVERED", json.dumps({k: v for k, v in info.items() if k != "token"}))

    client = Client(info["host"], info["port"], info["token"])
    try:
        print("HELLO", client.call("hello"))
        print("PING", client.call("ping"))
        print("MATH", client.call("exec", "print('two', 1 + 1)"))
        print("EVAL", client.call("eval", "3 * 7", mode="eval"))
        print("BPY", client.call("exec", "import bpy\nprint('version', bpy.app.version_string)\nprint('objects', len(bpy.data.objects))"))
        print("TRACE", client.call("exec", "raise ValueError('boom')"))
        print("STATE1", client.call("exec", "counter = 41"))
        print("STATE2", client.call("eval", "counter + 1", mode="eval"))
        print("BADTOKEN", Client(info["host"], info["port"], "wrong").call("hello"))
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
