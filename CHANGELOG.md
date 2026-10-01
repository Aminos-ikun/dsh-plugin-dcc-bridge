# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — first release

### Added

- **Desktop control (Windows).** `desktop_screenshot`, `desktop_mouse`,
  `desktop_keyboard`, `desktop_window`, `desktop_process`, `desktop_clipboard`.
  Window capture uses `PrintWindow` so an occluded window still captures
  correctly; typing goes through `KEYEVENTF_UNICODE` so any Unicode text works.
- **3D application bridge.** `dcc_list`, `dcc_launch`, `dcc_run`, `dcc_batch`,
  `dcc_bridge_install`, covering Blender end to end and providing detection plus
  headless batch recipes for Maya, 3ds Max, Houdini, Cinema 4D, Unreal, Unity,
  Godot, SketchUp and Rhino.
- **An in-app bridge** (`assets/blender_dsh_bridge.py`) that is simultaneously a
  Blender add-on and a bootstrap script, executing Python on Blender's main
  thread through a loopback JSON protocol.
- **An approval gate** for machine-changing desktop actions, defaulting to one
  confirmation per tool per session, configurable to `never` or `always`.
- **Tests.** `tools/selfcheck.mjs` (end-to-end, real desktop and a real Blender
  when one is installed) and `tools/gate-test.mjs` (deterministic gate
  coverage against a mock context).

### Notes

- The PowerShell desktop agent picks its transport at runtime: a warm loopback
  socket when it can, a one-shot file-based invocation when the parent process
  cannot create anonymous pipes (Windows reports `EPERM`). Child output is always
  captured through file descriptors rather than pipes for the same reason.
- The plugin imports nothing from `@deepseek-ai/*`. Tool definitions are written
  in the raw registry form, because a plugin installed into a DSH profile cannot
  resolve the application's own bundled packages.
