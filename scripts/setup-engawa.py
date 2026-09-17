#!/usr/bin/env python3
"""Install the pinned MIT Engawa MCP into an ignored local runtime and register it.

No API key is read or accepted here.  The upstream commit and license are kept
in ``upstreams/engawa-mcp.lock.json`` and ``licenses/ENGAWA_MCP.txt``.

When a step fails, stderr carries a line starting with ``安装没完成：`` that says
what to do, followed by the step's own last lines.  The settings page shows both,
so nobody has to guess from a bare "failed".
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCK = ROOT / "upstreams" / "engawa-mcp.lock.json"
RUNTIME = ROOT / ".runtime" / "engawa"

#: 失败时留给人看的原话行数
TAIL = 25
#: 设置页和测试靠这两个标记从输出里认出「为什么」和「原话」
REASON = "安装没完成："
RAW = "—— 最后几行原话 ——"


class SetupError(Exception):
    def __init__(self, reason: str, tail: str = "") -> None:
        super().__init__(reason)
        self.reason, self.tail = reason, tail


def _python_version(command: str) -> tuple[int, int] | None:
    try:
        out = subprocess.run(
            [command, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
            check=True, capture_output=True, text=True, timeout=10,
        ).stdout.split()
        return int(out[0]), int(out[1])
    except Exception:
        return None


def find_python() -> str:
    """Engawa requires Python 3.11+; choose an installed interpreter explicitly."""
    candidates = [sys.executable, "python3.14", "python3.13", "python3.12", "python3.11", "python3"]
    seen: set[str] = set()
    for item in candidates:
        command = shutil.which(item) if not Path(item).is_absolute() else item
        if not command or command in seen:
            continue
        seen.add(command)
        version = _python_version(command)
        if version and version >= (3, 11):
            return command
    raise RuntimeError("Engawa 需要 Python 3.11 或更新版本；先安装新版 Python 再点一次")


def executable(runtime: Path = RUNTIME) -> Path:
    choices = (runtime / "bin" / "engawa-mcp", runtime / "Scripts" / "engawa-mcp.exe")
    return next((path for path in choices if path.is_file()), choices[0])


def register(command: Path, config_path: Path) -> None:
    """Write only the MCP command; this file contains no key and stays outside Git."""
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        value = {}
    value.setdefault("mcpServers", {})["engawa"] = {
        "command": str(command),
        "args": [],
        "env": {"ENGAWA_CACHE_DIR": str(config_path.parent / "engawa-cache")},
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = config_path.with_suffix(config_path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(config_path)


def git_works() -> bool:
    """A git that actually runs, not just a name on PATH.  On a Mac without the command
    line tools, /usr/bin/git is a stub that fails the moment it is called."""
    git = shutil.which("git")
    if not git:
        return False
    try:
        return subprocess.run([git, "--version"], capture_output=True, timeout=15).returncode == 0
    except Exception:
        return False


def source(lock: dict) -> str:
    """Where Engawa is fetched from.  ``ENGAWA_SOURCE`` wins (a zip downloaded by hand, or
    a mirror URL) for networks that cannot reach GitHub.  Otherwise git when it works, as
    before; without a working git, the same pinned commit as a zip archive — same code."""
    own = os.environ.get("ENGAWA_SOURCE", "").strip()
    if own:
        return own
    repo = str(lock["repository"]).rstrip("/")
    commit = str(lock["commit"])
    if git_works():
        return f"git+{repo}.git@{commit}"
    return f"{repo}/archive/{commit}.zip"


_GIT = ("cannot find command 'git'", "xcrun: error", "no developer tools", "git: not found",
        "'git' is not recognized", "have not agreed to the xcode license")
_NET = ("failed to establish a new connection", "could not fetch url", "read timed out",
        "connecttimeout", "connection timed out", "timed out", "temporary failure in name resolution",
        "name or service not known", "nodename nor servname", "connection reset", "connection refused",
        "connection aborted", "remote end closed connection", "network is unreachable", "sslerror",
        "certificate verify failed", "unable to access", "could not resolve host", "early eof",
        "rpc failed", "proxyerror", "http error", "no matching distribution found")


def why(step: str, output: str) -> str:
    """The common failures as one sentence a person can act on; '' when not recognised."""
    low = (output or "").lower()
    if step == "venv":
        return ("这台电脑的 Python 缺了建独立运行环境的那一块"
                "（Debian / Ubuntu 上装 python3-venv），装好再点一次")
    if any(s in low for s in _GIT):
        return ("这台电脑上的 git 用不了。装好 git 再点一次；"
                "或者照 docs/FEATURES.md「Engawa 装不上」手动下载压缩包来装")
    if any(s in low for s in _NET):
        return ("下载没成功，多半是连不上 GitHub 或 Python 的包仓库（国内网络常见）。"
                "照 docs/FEATURES.md「Engawa 装不上」换国内镜像，或者手动下载压缩包再装")
    if step == "check":
        return "装上了，但自检没过"
    return ""


def run(cmd: list[str], timeout: float | None = None) -> tuple[int, str]:
    """Run one step.  Its output still streams to the terminal as before; the last lines
    are also kept, for the reason and for the settings page."""
    tail: deque[str] = deque(maxlen=TAIL)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, errors="replace")
    timer = threading.Timer(timeout, proc.kill) if timeout else None
    if timer:
        timer.start()
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            tail.append(line.rstrip("\n"))
        code = proc.wait()
    finally:
        if timer:
            timer.cancel()
    return code, "\n".join(tail)


def step(name: str, cmd: list[str], timeout: float | None = None) -> None:
    code, tail = run(cmd, timeout)
    if code:
        raise SetupError(why(name, tail) or f"「{name}」这一步失败了，下面是它的原话", tail)


def install() -> Path:
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    python = find_python()
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    step("venv", [python, "-m", "venv", str(RUNTIME)])
    runtime_python = RUNTIME / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    step("pip", [str(runtime_python), "-m", "pip", "install", "--disable-pip-version-check",
                 source(lock)])
    command = executable()
    step("check", [str(command), "--check"], timeout=60)
    db = Path(os.environ.get("LIANHUAN_DB", str(ROOT / "data" / "lianhuan.db")))
    register(command, db.parent / "mcp.json")
    return command


def main() -> int:
    try:
        install()
    except SetupError as e:
        print("\n" + REASON + e.reason, file=sys.stderr)
        if e.tail:
            print(RAW + "\n" + e.tail, file=sys.stderr)
        return 1
    except RuntimeError as e:
        print("\n" + REASON + str(e), file=sys.stderr)
        return 1
    print("Engawa 已安装并登记；重启连环后，檐廊和 AI 的 12 件阅读工具会一起上线。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
