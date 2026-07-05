#!/usr/bin/env python3
"""pyrunner - Python script editor & runner backend for fnOS."""

import argparse
import json
import mimetypes
import os
import pty
import shlex
import socketserver
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from env_manager import EnvManager

EXEC_TASKS = {}
EXEC_TASKS_LOCK = threading.Lock()
MAX_FILE_SIZE = 10 * 1024 * 1024
EXEC_TIMEOUT = 300

ENV_MANAGER = None


def normalize_base_path(path):
    if not path:
        return "/"
    normalized = path.strip()
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return normalized.rstrip("/") or "/"


def strip_base_path(path, base_path):
    normalized = path or "/"
    if base_path != "/" and normalized.startswith(base_path):
        normalized = normalized[len(base_path):] or "/"
    return normalized


def validate_path(file_path):
    if not file_path or not file_path.startswith("/"):
        return False, "Path must be absolute"
    if ".." in file_path.split("/"):
        return False, "Path traversal not allowed"
    target = Path(file_path)
    suffix = target.suffix.lower()
    if suffix and suffix != ".py":
        return False, "Only .py files are supported"
    if not suffix:
        return False, "File must have .py extension"
    return True, target


def run_script(task_id, file_path, args_str, cwd_str):
    with EXEC_TASKS_LOCK:
        task = EXEC_TASKS.get(task_id)
        if not task:
            return
        task["status"] = "running"
        task["started_at"] = datetime.now().isoformat()

    runtime = ENV_MANAGER.resolve_runtime(file_path)
    target = Path(file_path)
    cmd = [runtime["python_path"], str(target)]
    if args_str:
        try:
            cmd.extend(shlex.split(args_str))
        except ValueError:
            cmd.append(args_str)

    cwd = cwd_str if cwd_str else str(target.parent)
    proc_env = ENV_MANAGER.build_script_env(runtime)
    proc_env["TERM"] = "xterm-256color"

    with EXEC_TASKS_LOCK:
        if task_id in EXEC_TASKS:
            EXEC_TASKS[task_id]["runtime"] = runtime

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
        slave_fd = None

        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["proc"] = proc
                EXEC_TASKS[task_id]["pty_master"] = master_fd

        def _read_pty():
            try:
                while True:
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if not data:
                        break
                    text = data.decode("utf-8", errors="replace")
                    with EXEC_TASKS_LOCK:
                        if task_id in EXEC_TASKS:
                            EXEC_TASKS[task_id]["stdout"] += text
            except Exception:
                pass
            finally:
                try:
                    os.close(master_fd)
                except OSError:
                    pass
                with EXEC_TASKS_LOCK:
                    if task_id in EXEC_TASKS:
                        EXEC_TASKS[task_id]["pty_master"] = None

        t_out = threading.Thread(target=_read_pty, daemon=True)
        t_out.start()

        proc.wait(timeout=EXEC_TIMEOUT)
        t_out.join(timeout=5)
        exit_code = proc.returncode

        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["status"] = "done"
                EXEC_TASKS[task_id]["exit_code"] = exit_code
                EXEC_TASKS[task_id]["finished_at"] = datetime.now().isoformat()
    except subprocess.TimeoutExpired:
        if proc:
            proc.kill()
            proc.wait(timeout=5)
        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["status"] = "timeout"
                EXEC_TASKS[task_id]["exit_code"] = -1
                EXEC_TASKS[task_id]["stderr"] += f"\n[Process killed after {EXEC_TIMEOUT}s timeout]"
                EXEC_TASKS[task_id]["finished_at"] = datetime.now().isoformat()
    except Exception as exc:
        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["status"] = "error"
                EXEC_TASKS[task_id]["exit_code"] = -1
                EXEC_TASKS[task_id]["stderr"] += str(exc)
                EXEC_TASKS[task_id]["finished_at"] = datetime.now().isoformat()
    finally:
        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["pty_master"] = None


def run_bg_command(task_id, cmd, cwd=None, env=None):
    """Run a generic command in background task."""
    with EXEC_TASKS_LOCK:
        task = EXEC_TASKS.get(task_id)
        if not task:
            return
        task["status"] = "running"
        task["started_at"] = datetime.now().isoformat()

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
            env=env or {**os.environ, "TERM": "dumb"},
        )
        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["proc"] = proc

        stdout, stderr = proc.communicate(timeout=300)
        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                task = EXEC_TASKS[task_id]
                task["stdout"] = stdout.decode("utf-8", errors="replace")
                task["stderr"] = stderr.decode("utf-8", errors="replace")
                task["exit_code"] = proc.returncode
                task["status"] = "done" if proc.returncode == 0 else "error"
                task["finished_at"] = datetime.now().isoformat()
    except subprocess.TimeoutExpired:
        proc.kill()
        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["status"] = "timeout"
                EXEC_TASKS[task_id]["exit_code"] = -1
                EXEC_TASKS[task_id]["stderr"] += "\n[Timeout]"
                EXEC_TASKS[task_id]["finished_at"] = datetime.now().isoformat()
    except Exception as exc:
        with EXEC_TASKS_LOCK:
            if task_id in EXEC_TASKS:
                EXEC_TASKS[task_id]["status"] = "error"
                EXEC_TASKS[task_id]["exit_code"] = -1
                EXEC_TASKS[task_id]["stderr"] += str(exc)
                EXEC_TASKS[task_id]["finished_at"] = datetime.now().isoformat()


class ThreadingUnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, socket_path, handler_cls, *, base_path, www_root):
        self.server_name = "pyrunner"
        self.server_port = 0
        self.base_path = normalize_base_path(base_path)
        self.www_root = Path(www_root)
        super().__init__(socket_path, handler_cls)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_HEAD(self):
        self.route()

    def log_message(self, fmt, *args):
        client_addr = self.client_address
        if isinstance(client_addr, tuple):
            client_addr = client_addr[0]
        if not client_addr:
            client_addr = "-"
        sys.stdout.write(
            "%s - - [%s] %s\n" % (client_addr, self.log_date_time_string(), fmt % args)
        )
        sys.stdout.flush()

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        return json.loads(body.decode("utf-8"))

    def route(self):
        parsed = urlsplit(self.path)
        if parsed.path == self.server.base_path:
            location = self.server.base_path + "/"
            if parsed.query:
                location += "?" + parsed.query
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        path = strip_base_path(parsed.path, self.server.base_path)
        if path.startswith("/api/"):
            self.handle_api(path, parsed.query)
            return

        self.serve_static(path)

    def handle_api(self, path, query):
        routes = {
            ("/api/file", "GET"): lambda: self.handle_api_file_read(query),
            ("/api/file", "POST"): self.handle_api_file_write,
            ("/api/execute", "GET"): lambda: self.handle_api_execute(query),
            ("/api/env", "GET"): self.handle_api_env_get,
            ("/api/env", "POST"): self.handle_api_env_post,
            ("/api/env/resolve", "GET"): lambda: self.handle_api_env_resolve(query),
            ("/api/python/list", "GET"): self.handle_api_python_list,
            ("/api/venv/list", "GET"): lambda: self.handle_api_venv_list(query),
            ("/api/venv/create", "POST"): self.handle_api_venv_create,
            ("/api/pip/list", "GET"): lambda: self.handle_api_pip_list(query),
            ("/api/pip/install", "POST"): self.handle_api_pip_install,
        }
        handler = routes.get((path, self.command))
        if handler:
            handler()
            return
        if path.startswith("/api/task/"):
            self.handle_api_task(path)
            return
        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def handle_api_env_get(self):
        self.send_json(HTTPStatus.OK, ENV_MANAGER.get_config())

    def handle_api_env_post(self):
        try:
            data = self.read_json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        script_path = (data.get("script_path") or "").strip()
        save_to_local = bool(data.get("save_to_local", False)) if "save_to_local" in data else None

        if script_path and "project" in data:
            project = data["project"] or {}
            project_updates = {}
            if "python_path" in data:
                project_updates["python_path"] = data["python_path"]
            if "pip_index_url" in data:
                project_updates["pip_index_url"] = data["pip_index_url"]
            if "use_venv" in project:
                project_updates["use_venv"] = bool(project["use_venv"])
            if "venv_path" in project:
                project_updates["venv_path"] = project["venv_path"]

            if save_to_local is None:
                _, _, local_exists, pref = ENV_MANAGER.get_effective_env(script_path)
                save_to_local = local_exists or pref

            try:
                ENV_MANAGER.save_project_config(
                    script_path, project_updates, save_to_local=bool(save_to_local)
                )
            except ValueError as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return
        else:
            allowed = {"python_path", "pip_index_url"}
            updates = {k: v for k, v in data.items() if k in allowed}
            if updates:
                ENV_MANAGER.save_config(updates)

        self.send_json(HTTPStatus.OK, ENV_MANAGER.get_config())

    def handle_api_env_resolve(self, query):
        params = parse_qs(query, keep_blank_values=True)
        script_path = unquote(params.get("path", [""])[0]).strip()
        runtime = ENV_MANAGER.resolve_runtime(script_path)
        effective, config_source, local_exists, save_to_local = ENV_MANAGER.get_effective_env(
            script_path
        )
        local_path = ENV_MANAGER.local_config_path(script_path)
        self.send_json(HTTPStatus.OK, {
            "runtime": runtime,
            "project_env": ENV_MANAGER.get_project_env(script_path),
            "effective": effective,
            "config_source": config_source,
            "local_config_exists": local_exists,
            "save_to_local": save_to_local or local_exists,
            "local_config_path": str(local_path) if local_path else "",
            "project_dir": ENV_MANAGER.get_project_dir(script_path),
        })

    def handle_api_python_list(self):
        self.send_json(HTTPStatus.OK, ENV_MANAGER.discover_pythons())

    def handle_api_venv_list(self, query):
        params = parse_qs(query, keep_blank_values=True)
        script_path = unquote(params.get("path", [""])[0]).strip()
        self.send_json(HTTPStatus.OK, ENV_MANAGER.list_venvs(script_path))

    def handle_api_venv_create(self):
        try:
            data = self.read_json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        script_path = (data.get("script_path") or "").strip()
        if not script_path:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "script_path required"})
            return

        try:
            result = ENV_MANAGER.create_venv(
                script_path,
                venv_path=data.get("venv_path"),
                python_path=data.get("python_path"),
                name=data.get("name"),
            )
            self.send_json(HTTPStatus.OK, result)
        except (ValueError, RuntimeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})

    def handle_api_pip_list(self, query):
        params = parse_qs(query, keep_blank_values=True)
        script_path = unquote(params.get("path", [""])[0]).strip()
        self.send_json(HTTPStatus.OK, ENV_MANAGER.pip_list(script_path))

    def handle_api_pip_install(self):
        try:
            data = self.read_json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return

        script_path = (data.get("script_path") or "").strip()
        packages = (data.get("packages") or "").strip()
        upgrade = bool(data.get("upgrade", False))

        if not script_path:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "script_path required"})
            return

        task_id = uuid.uuid4().hex[:12]
        task = {
            "id": task_id,
            "type": "pip_install",
            "file_path": script_path,
            "status": "pending",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "proc": None,
            "created_at": datetime.now().isoformat(),
            "started_at": None,
            "finished_at": None,
        }
        with EXEC_TASKS_LOCK:
            EXEC_TASKS[task_id] = task

        def _install():
            try:
                result = ENV_MANAGER.pip_install(script_path, packages, upgrade=upgrade)
                with EXEC_TASKS_LOCK:
                    if task_id in EXEC_TASKS:
                        EXEC_TASKS[task_id]["stdout"] = result.get("output", "")
                        EXEC_TASKS[task_id]["status"] = "done"
                        EXEC_TASKS[task_id]["exit_code"] = 0
                        EXEC_TASKS[task_id]["finished_at"] = datetime.now().isoformat()
            except Exception as exc:
                with EXEC_TASKS_LOCK:
                    if task_id in EXEC_TASKS:
                        EXEC_TASKS[task_id]["stderr"] = str(exc)
                        EXEC_TASKS[task_id]["status"] = "error"
                        EXEC_TASKS[task_id]["exit_code"] = 1
                        EXEC_TASKS[task_id]["finished_at"] = datetime.now().isoformat()

        threading.Thread(target=_install, daemon=True).start()
        self.send_json(HTTPStatus.OK, {"task_id": task_id, "status": "pending"})

    def handle_api_file_read(self, query):
        params = parse_qs(query, keep_blank_values=True)
        raw_path = params.get("path", [""])[0]
        file_path = unquote(raw_path or "").strip()

        ok, result = validate_path(file_path)
        if not ok:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": result})
            return

        target_path = result
        if not target_path.exists():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "File not found", "path": file_path})
            return

        if target_path.is_dir():
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Cannot open a directory"})
            return

        size = target_path.stat().st_size
        if size > MAX_FILE_SIZE:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"File too large (max {MAX_FILE_SIZE // 1024 // 1024}MB)"})
            return

        try:
            content = target_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            try:
                content = target_path.read_text(encoding="gbk")
            except Exception as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"Unable to decode file: {exc}"})
                return
        except Exception as exc:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return

        stat = target_path.stat()
        self.send_json(HTTPStatus.OK, {
            "path": file_path,
            "content": content,
            "size": size,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })

    def handle_api_file_write(self):
        try:
            data = self.read_json_body()
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"Invalid request body: {exc}"})
            return

        file_path = (data.get("path") or "").strip()
        content = data.get("content")
        if content is None:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Missing content field"})
            return

        ok, result = validate_path(file_path)
        if not ok:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": result})
            return

        target_path = result
        if len(content.encode("utf-8")) > MAX_FILE_SIZE:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Content too large"})
            return

        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(content, encoding="utf-8")
        except Exception as exc:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"Failed to save: {exc}"})
            return

        stat = target_path.stat()
        self.send_json(HTTPStatus.OK, {
            "path": file_path,
            "size": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })

    def handle_api_execute(self, query):
        params = parse_qs(query, keep_blank_values=True)
        raw_path = params.get("path", [""])[0]
        file_path = unquote(raw_path or "").strip()
        args_str = unquote(params.get("args", [""])[0])
        cwd_str = unquote(params.get("cwd", [""])[0])

        ok, result = validate_path(file_path)
        if not ok:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": result})
            return

        target_path = result
        if not target_path.exists():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "File not found", "path": file_path})
            return

        if target_path.is_dir():
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Cannot execute a directory"})
            return

        runtime = ENV_MANAGER.resolve_runtime(file_path)
        task_id = uuid.uuid4().hex[:12]
        task = {
            "id": task_id,
            "type": "script",
            "file_path": file_path,
            "args": args_str,
            "cwd": cwd_str or str(target_path.parent),
            "runtime": runtime,
            "status": "pending",
            "exit_code": None,
            "stdout": "",
            "stderr": "",
            "proc": None,
            "pty_master": None,
            "created_at": datetime.now().isoformat(),
            "started_at": None,
            "finished_at": None,
        }

        with EXEC_TASKS_LOCK:
            EXEC_TASKS[task_id] = task

        t = threading.Thread(
            target=run_script, args=(task_id, file_path, args_str, cwd_str), daemon=True
        )
        t.start()

        self.send_json(HTTPStatus.OK, {
            "task_id": task_id,
            "status": "pending",
            "runtime": runtime,
        })

    def handle_api_task(self, path):
        parts = path.split("/")
        if len(parts) < 4:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Invalid task URL"})
            return

        task_id = parts[3]
        action = parts[4] if len(parts) > 4 else None

        if action == "stdin" and self.command == "POST":
            try:
                data = self.read_json_body()
            except (ValueError, json.JSONDecodeError) as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return

            line = data.get("line", data.get("input", ""))
            if line is None:
                line = ""
            if not isinstance(line, str):
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "line must be a string"})
                return
            if line and not line.endswith("\n"):
                line += "\n"

            with EXEC_TASKS_LOCK:
                task = EXEC_TASKS.get(task_id)
                if not task:
                    self.send_json(HTTPStatus.NOT_FOUND, {"error": "Task not found"})
                    return
                if task.get("type") != "script" or task.get("status") != "running":
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Task not accepting input"})
                    return
                master = task.get("pty_master")
                if master is None:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"error": "Interactive input unavailable"})
                    return

            try:
                os.write(master, line.encode("utf-8"))
            except OSError as exc:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
                return

            self.send_json(HTTPStatus.OK, {"ok": True})
            return

        with EXEC_TASKS_LOCK:
            task = EXEC_TASKS.get(task_id)
            if not task:
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "Task not found"})
                return

            if action == "stop" and self.command == "POST" and task["status"] == "running":
                proc = task.get("proc")
                master = task.get("pty_master")
                if master is not None:
                    try:
                        os.close(master)
                    except OSError:
                        pass
                    task["pty_master"] = None
                if proc and proc.poll() is None:
                    try:
                        proc.terminate()
                        proc.wait(timeout=3)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                    task["status"] = "killed"
                    task["exit_code"] = -9
                    task["stderr"] += "\n[Process killed by user]"
                    task["finished_at"] = datetime.now().isoformat()

            resp = {k: task[k] for k in task if k not in ("proc", "pty_master")}
            resp["interactive"] = (
                task.get("type") == "script"
                and task.get("status") == "running"
                and task.get("pty_master") is not None
            )

        self.send_json(HTTPStatus.OK, resp)

    def send_json(self, status, data):
        response_text = json.dumps(data, ensure_ascii=False)
        response_bytes = response_text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(response_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(response_bytes)

    def serve_static(self, path):
        rel_path = unquote(path or "/")
        if rel_path in ("", "/"):
            rel_path = "/index.html"
        target = (self.server.www_root / rel_path.lstrip("/")).resolve()
        root = self.server.www_root.resolve()
        if root != target and root not in target.parents:
            self.send_error(HTTPStatus.BAD_REQUEST, "Bad request")
            return
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript", "application/json",
        }:
            content_type = f"{content_type}; charset=utf-8"
        size = target.stat().st_size

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        self.send_header(
            "Cache-Control",
            "no-store" if target.name == "index.html" else "public, max-age=3600",
        )
        self.end_headers()
        if self.command != "HEAD":
            with target.open("rb") as handle:
                while True:
                    chunk = handle.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(chunk)


def parse_args():
    parser = argparse.ArgumentParser(description="pyrunner HTTP gateway")
    parser.add_argument("--socket", required=True, help="Unix socket path")
    parser.add_argument("--base-path", default="/app/pyrunner", help="Base path to serve")
    parser.add_argument("--www-root", required=True, help="Static root directory")
    parser.add_argument("--config-dir", required=True, help="Config/data directory")
    return parser.parse_args()


def main():
    global ENV_MANAGER
    args = parse_args()
    ENV_MANAGER = EnvManager(args.config_dir)

    socket_path = os.path.abspath(args.socket)
    if os.path.exists(socket_path):
        try:
            os.remove(socket_path)
        except OSError:
            pass

    httpd = ThreadingUnixHTTPServer(
        socket_path, Handler, base_path=args.base_path, www_root=args.www_root
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
        if os.path.exists(socket_path):
            os.remove(socket_path)


if __name__ == "__main__":
    main()
