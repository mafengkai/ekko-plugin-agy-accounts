#!/usr/bin/env python3
"""agy 无头 Google OAuth 登录驱动（插件内嵌版，参数化多实例）。

用法: oauth_pty.py <state_dir> <home>

- <state_dir>: 状态目录，写入 status.json / auth_url.txt / cmd/ / done/ / screen.txt
- <home>:      隔离的 HOME，agy 登录后 token 落 <home>/.gemini/antigravity-cli/antigravity-oauth-token

流程: spawn `agy`(TUI) → 检测登录方法菜单 → 回车选 Google OAuth → 解析一次性
authorize URL → 写 status=url；随后监听 cmd/*.cmd 邮箱，把授权码注入 TUI；
兑换成功写 status=success 并退出，失败写 status=error。

PKCE 的 code_verifier 只存在于 agy 进程内存，所以本进程必须从 URL 生成常驻到兑换完成。
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import sys
import termios
import time

STATE = sys.argv[1] if len(sys.argv) > 1 else "/tmp/agy_oauth"
HOME = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("HOME", "/home/agent")
BIN = os.environ.get("AGY_BIN", "/usr/local/bin/agy")
if not os.path.isabs(BIN):
    resolved = shutil.which(BIN)
    if resolved:
        BIN = resolved

STATUS = os.path.join(STATE, "status.json")
URL_FILE = os.path.join(STATE, "auth_url.txt")
CMD_DIR = os.path.join(STATE, "cmd")
DONE_DIR = os.path.join(STATE, "done")
SCREEN_TXT = os.path.join(STATE, "screen.txt")

ANSI = re.compile(rb"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]|[\r\x07]")
# TUI 硬折行把长 URL 切成 "\n " 段；只按这个模式拼接，禁止删全部空白（否则后续
# 说明文字会焊进 state= 值导致 state 校验失败）。
URL_RE = re.compile(r"https://accounts\.google\.com/o/oauth2/auth\?(?:[^\s]|\n )+")


def write_status(state, url=None, extra=None):
    payload = {"state": state, "updated": time.time()}
    if url:
        payload["url"] = url
    if extra:
        payload.update(extra)
    tmp = STATUS + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, STATUS)


def read_url():
    try:
        with open(URL_FILE) as f:
            return f.read().strip()
    except Exception:
        return None


def main():
    os.makedirs(STATE, exist_ok=True)
    os.makedirs(CMD_DIR, exist_ok=True)
    os.makedirs(DONE_DIR, exist_ok=True)
    for p in (SCREEN_TXT,):
        with open(p, "wb"):
            pass
    write_status("starting", extra={"pid": os.getpid()})

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 70, 500, 0, 0))

    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for fd in (0, 1, 2):
            os.dup2(slave, fd)
        if slave > 2:
            os.close(slave)
        env = os.environ.copy()
        env.update(HOME=HOME, TERM="xterm-256color")
        env.pop("BROWSER", None)  # 无浏览器，强制手动授权码流
        os.execve(BIN, [os.path.basename(BIN)], env)

    os.close(slave)
    write_status("starting", extra={"pid": os.getpid(), "agy_pid": pid})

    buffer = b""
    menu_entered = False
    url_saved = False
    done = False
    start = time.time()

    while not done:
        r, _, _ = select.select([master], [], [], 0.2)
        if master in r:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                chunk = b""
            if not chunk:
                break
            buffer += chunk
            txt = ANSI.sub(b"", buffer).decode("utf-8", "replace")
            with open(SCREEN_TXT, "w") as f:
                f.write(txt)
            low = txt.lower()

            if not menu_entered and "select login method" in low:
                time.sleep(0.4)
                os.write(master, b"\r")  # 默认第一行 = Google OAuth
                menu_entered = True
                write_status("menu", extra={"agy_pid": pid})

            if menu_entered and not url_saved:
                m = URL_RE.search(txt)
                if m:
                    cand = re.sub(r"\n ?", "", m.group(0)).strip()
                    if "state=" in cand and "code_challenge=" in cand:
                        with open(URL_FILE, "w") as f:
                            f.write(cand)
                        write_status("url", url=cand, extra={"agy_pid": pid})
                        url_saved = True

            if url_saved:
                # 最可靠的兑换成功信号：token 文件已落盘。agy 兑换成功后不打印
                # "login successful" 之类关键词，而是直接进入 "Welcome/Choose color
                # scheme" 首次向导，因此不能只靠屏幕文本判断成功。
                tok = os.path.join(HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token")
                if os.path.exists(tok):
                    write_status("success", url=read_url(), extra={"agy_pid": pid})
                    done = True
                else:
                    for kw, st in (("login successful", "success"),
                                   ("signed in as", "success"),
                                   ("successfully signed in", "success"),
                                   ("welcome to antigravity", "success"),
                                   ("choose your color scheme", "success"),
                                   ("invalid_grant", "error"),
                                   ("invalid authorization", "error"),
                                   ("access denied", "error"),
                                   ("token exchange failed", "error"),
                                   ("authentication failed", "error"),
                                   ("timed out", "error")):
                        if kw in low:
                            write_status(st, url=read_url(), extra={"agy_pid": pid})
                            done = True
                            break

        # 处理 cmd 邮箱
        try:
            pending = sorted(n for n in os.listdir(CMD_DIR) if n.endswith(".cmd"))
        except OSError:
            pending = []
        for name in pending:
            path = os.path.join(CMD_DIR, name)
            try:
                with open(path, "rb") as f:
                    data = f.read()
                os.write(master, data)
                os.replace(path, os.path.join(DONE_DIR, name))
            except Exception:
                try:
                    os.remove(path)
                except OSError:
                    pass

        waited, code = os.waitpid(pid, os.WNOHANG)
        if waited:
            write_status("exited", extra={"agy_pid": pid, "exit_code": code})
            break
        # 兜底超时（10 分钟），防止僵尸常驻
        if time.time() - start > 600:
            write_status("error", url=read_url(), extra={"agy_pid": pid, "reason": "timeout"})
            break

    # 清理 agy 子进程
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        os.close(master)
    except Exception:
        pass


if __name__ == "__main__":
    main()
