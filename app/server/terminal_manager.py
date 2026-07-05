#!/usr/bin/env python3
"""Persistent background terminals for long-running scripts."""

import json
import os
import pty
import shlex
import subprocess
import threading
import uuid
from datetime import datetime
from pathlib import Path

TERMINAL_LOCK = threading.Lock()

# ANSI SGR — 与前台 .line.info 颜色 (#608b4e) 一致
_ANSI_GREEN = "\x1b[32m"
_ANSI_RESET = "\x1b[0m"


def _now():
    return datetime.now().isoformat()


class TerminalManager:
    def __init__(self, config_dir):
        self.config_dir = Path(config_dir)
        self.terminals_dir = self.config_dir / "terminals"
        self.terminals_dir.mkdir(parents=True, exist_ok=True)
        self._active = {}
        self.recover_stale_running()

    def recover_stale_running(self):
        for meta in self._iter_meta_files():
            if meta.get("status") == "running":
                meta["status"] = "interrupted"
                meta["finished_at"] = _now()
                meta["exit_code"] = meta.get("exit_code", -1)
                self._write_meta(meta["id"], meta)
                log_path = self._log_path(meta["id"])
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write("\n[服务重启，后台任务已中断]\n")

    def _meta_path(self, terminal_id):
        return self.terminals_dir / f"{terminal_id}.json"

    def _log_path(self, terminal_id):
        return self.terminals_dir / f"{terminal_id}.log"

    def _iter_meta_files(self):
        for path in sorted(self.terminals_dir.glob("*.json"), reverse=True):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("id"):
                    yield data
            except (OSError, json.JSONDecodeError):
                continue

    def _read_meta(self, terminal_id):
        path = self._meta_path(terminal_id)
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, json.JSONDecodeError):
            return None

    def _write_meta(self, terminal_id, meta):
        self._meta_path(terminal_id).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def _append_log(self, terminal_id, text):
        if not text:
            return
        with open(self._log_path(terminal_id), "a", encoding="utf-8") as fh:
            fh.write(text)

    def _read_log_from(self, terminal_id, offset=0):
        path = self._log_path(terminal_id)
        if not path.is_file():
            return "", 0
        size = path.stat().st_size
        if offset < 0:
            offset = 0
        if offset >= size:
            return "", size
        with open(path, "rb") as fh:
            fh.seek(offset)
            data = fh.read()
        return data.decode("utf-8", errors="replace"), size

    def list_terminals(self):
        items = []
        for meta in self._iter_meta_files():
            tid = meta["id"]
            log_size = self._log_path(tid).stat().st_size if self._log_path(tid).is_file() else 0
            items.append(self._public_meta(meta, log_size))
        items.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return {"terminals": items}

    def _public_meta(self, meta, log_size=0):
        tid = meta["id"]
        with TERMINAL_LOCK:
            live = tid in self._active
        return {
            "id": tid,
            "title": meta.get("title") or Path(meta.get("script_path", "")).name or tid,
            "script_path": meta.get("script_path", ""),
            "args": meta.get("args", ""),
            "status": meta.get("status", "unknown"),
            "exit_code": meta.get("exit_code"),
            "created_at": meta.get("created_at"),
            "started_at": meta.get("started_at"),
            "finished_at": meta.get("finished_at"),
            "runtime": meta.get("runtime") or {},
            "log_size": log_size,
            "interactive": live and meta.get("status") == "running",
        }

    def get_terminal(self, terminal_id, offset=0):
        meta = self._read_meta(terminal_id)
        if not meta:
            return None
        output, log_size = self._read_log_from(terminal_id, offset)
        pub = self._public_meta(meta, log_size)
        pub["output"] = output
        pub["offset"] = offset
        return pub

    def delete_terminal(self, terminal_id):
        with TERMINAL_LOCK:
            if terminal_id in self._active:
                raise ValueError("终端仍在运行，请先停止任务")
        meta = self._read_meta(terminal_id)
        if not meta:
            raise ValueError("Terminal not found")
        if meta.get("status") == "running":
            raise ValueError("终端仍在运行，请先停止任务")
        try:
            self._meta_path(terminal_id).unlink(missing_ok=True)
            self._log_path(terminal_id).unlink(missing_ok=True)
        except OSError as exc:
            raise ValueError(str(exc)) from exc
        return {"deleted": terminal_id}

    def create_and_run(self, script_path, args_str, cwd_str, runtime, env_manager):
        terminal_id = uuid.uuid4().hex[:12]
        target = Path(script_path)
        title = target.name or terminal_id
        cmd_line = runtime.get("python_path", "python3") + " " + script_path
        if args_str:
            cmd_line += " " + args_str

        meta = {
            "id": terminal_id,
            "title": title,
            "script_path": script_path,
            "args": args_str or "",
            "cwd": cwd_str or str(target.parent),
            "runtime": runtime,
            "status": "pending",
            "exit_code": None,
            "created_at": _now(),
            "started_at": None,
            "finished_at": None,
            "background": True,
        }
        self._write_meta(terminal_id, meta)
        self._log_path(terminal_id).write_text(
            f"{_ANSI_GREEN}$ {cmd_line}{_ANSI_RESET}\n", encoding="utf-8"
        )
        if runtime.get("mode") == "venv" and runtime.get("venv_path"):
            self._append_log(
                terminal_id,
                f"{_ANSI_GREEN}# venv: {runtime['venv_path']}{_ANSI_RESET}\n",
            )

        thread = threading.Thread(
            target=self._run_terminal,
            args=(terminal_id, script_path, args_str, cwd_str, runtime, env_manager),
            daemon=True,
        )
        thread.start()
        return self._public_meta(meta, self._log_path(terminal_id).stat().st_size)

    def _run_terminal(self, terminal_id, script_path, args_str, cwd_str, runtime, env_manager):
        meta = self._read_meta(terminal_id)
        if not meta:
            return
        meta["status"] = "running"
        meta["started_at"] = _now()
        self._write_meta(terminal_id, meta)

        target = Path(script_path)
        cmd = [runtime["python_path"], str(target)]
        if args_str:
            try:
                cmd.extend(shlex.split(args_str))
            except ValueError:
                cmd.append(args_str)
        cwd = cwd_str if cwd_str else str(target.parent)
        proc_env = env_manager.build_script_env(runtime)
        proc_env["TERM"] = "xterm-256color"

        master_fd = None
        proc = None
        try:
            master_fd, slave_fd = pty.openpty()
            proc = subprocess.Popen(
                cmd,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                cwd=cwd,
                env=proc_env,
                close_fds=True,
            )
            os.close(slave_fd)

            with TERMINAL_LOCK:
                self._active[terminal_id] = {
                    "proc": proc,
                    "pty_master": master_fd,
                }

            def _read_pty():
                try:
                    while True:
                        try:
                            data = os.read(master_fd, 4096)
                        except OSError:
                            break
                        if not data:
                            break
                        self._append_log(
                            terminal_id, data.decode("utf-8", errors="replace")
                        )
                finally:
                    try:
                        os.close(master_fd)
                    except OSError:
                        pass
                    with TERMINAL_LOCK:
                        active = self._active.get(terminal_id)
                        if active and active.get("pty_master") == master_fd:
                            active["pty_master"] = None

            reader = threading.Thread(target=_read_pty, daemon=True)
            reader.start()

            proc.wait()
            reader.join(timeout=5)
            exit_code = proc.returncode

            meta = self._read_meta(terminal_id) or meta
            meta["status"] = "done"
            meta["exit_code"] = exit_code
            meta["finished_at"] = _now()
            self._write_meta(terminal_id, meta)
        except Exception as exc:
            meta = self._read_meta(terminal_id) or meta
            meta["status"] = "error"
            meta["exit_code"] = -1
            meta["finished_at"] = _now()
            self._write_meta(terminal_id, meta)
            self._append_log(terminal_id, f"\n[Error: {exc}]\n")
        finally:
            with TERMINAL_LOCK:
                self._active.pop(terminal_id, None)

    def write_stdin(self, terminal_id, line):
        with TERMINAL_LOCK:
            active = self._active.get(terminal_id)
            meta = self._read_meta(terminal_id)
            if not meta or meta.get("status") != "running" or not active:
                raise ValueError("Terminal not accepting input")
            master = active.get("pty_master")
            if master is None:
                raise ValueError("Interactive input unavailable")
        if line and not line.endswith("\n"):
            line += "\n"
        os.write(master, line.encode("utf-8"))

    def stop_terminal(self, terminal_id):
        with TERMINAL_LOCK:
            active = self._active.get(terminal_id)
            meta = self._read_meta(terminal_id)
            if not meta:
                raise ValueError("Terminal not found")
            if meta.get("status") != "running":
                return self._public_meta(meta, self._log_size(terminal_id))
            proc = active.get("proc") if active else None
            master = active.get("pty_master") if active else None
            if master is not None:
                try:
                    os.close(master)
                except OSError:
                    pass
                active["pty_master"] = None
        if proc and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        meta = self._read_meta(terminal_id) or meta
        meta["status"] = "killed"
        meta["exit_code"] = -9
        meta["finished_at"] = _now()
        self._write_meta(terminal_id, meta)
        self._append_log(terminal_id, "\n[Process killed by user]\n")
        with TERMINAL_LOCK:
            self._active.pop(terminal_id, None)
        return self._public_meta(meta, self._log_size(terminal_id))

    def _log_size(self, terminal_id):
        path = self._log_path(terminal_id)
        return path.stat().st_size if path.is_file() else 0

    def is_running(self, terminal_id):
        meta = self._read_meta(terminal_id)
        return bool(meta and meta.get("status") == "running")
