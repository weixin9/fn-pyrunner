#!/usr/bin/env python3
"""Environment management: Python interpreters, venv, pip."""

import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

DEFAULT_PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple"
CONFIG_VERSION = 1
LOCAL_CONFIG_FILE = ".pyrunner"
LOCAL_CONFIG_VERSION = 1

CONFIG_LOCK = threading.Lock()


def default_config():
    return {
        "version": CONFIG_VERSION,
        "python_path": "",
        "pip_index_url": DEFAULT_PIP_INDEX,
        "project_envs": {},
    }


def default_local_config():
    return {
        "version": LOCAL_CONFIG_VERSION,
        "python_path": "",
        "pip_index_url": DEFAULT_PIP_INDEX,
        "use_venv": True,
        "venv_path": "",
    }


class EnvManager:
    def __init__(self, config_dir):
        self.config_dir = Path(config_dir)
        self.config_path = self.config_dir / "env.json"
        self.venvs_dir = self.config_dir / "venvs"
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.venvs_dir.mkdir(parents=True, exist_ok=True)
        self._config = self._load()

    def _load(self):
        if not self.config_path.exists():
            cfg = default_config()
            self._save_unlocked(cfg)
            return cfg
        try:
            data = json.loads(self.config_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return default_config()
            merged = default_config()
            merged.update(data)
            if not merged.get("pip_index_url"):
                merged["pip_index_url"] = DEFAULT_PIP_INDEX
            if not isinstance(merged.get("project_envs"), dict):
                merged["project_envs"] = {}
            return merged
        except (OSError, json.JSONDecodeError):
            return default_config()

    def _save_unlocked(self, config):
        self.config_path.write_text(
            json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def save_config(self, updates):
        with CONFIG_LOCK:
            self._config.update(updates)
            if "project_envs" in updates and not isinstance(updates["project_envs"], dict):
                self._config["project_envs"] = {}
            self._save_unlocked(self._config)
            return dict(self._config)

    def get_config(self):
        with CONFIG_LOCK:
            return dict(self._config)

    def get_project_dir(self, script_path):
        if not script_path:
            return ""
        return str(Path(script_path).parent.resolve())

    def local_config_path(self, script_path):
        project_dir = self.get_project_dir(script_path)
        if not project_dir:
            return None
        return Path(project_dir) / LOCAL_CONFIG_FILE

    def read_local_config(self, script_path):
        path = self.local_config_path(script_path)
        if not path or not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return None
            merged = default_local_config()
            merged.update(data)
            if not merged.get("pip_index_url"):
                merged["pip_index_url"] = DEFAULT_PIP_INDEX
            return merged
        except (OSError, json.JSONDecodeError):
            return None

    def write_local_config(self, script_path, updates):
        path = self.local_config_path(script_path)
        if not path:
            raise ValueError("Invalid script path")
        ok, project_dir = self.validate_abs_path(self.get_project_dir(script_path))
        if not ok:
            raise ValueError(str(project_dir))
        current = self.read_local_config(script_path) or default_local_config()
        allowed = {"python_path", "pip_index_url", "use_venv", "venv_path"}
        for key, value in updates.items():
            if key in allowed:
                current[key] = value
        current["version"] = LOCAL_CONFIG_VERSION
        path.write_text(
            json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return dict(current)

    def remove_local_config(self, script_path):
        path = self.local_config_path(script_path)
        if path and path.is_file():
            path.unlink()

    def get_project_env_global(self, script_path):
        project_dir = self.get_project_dir(script_path)
        if not project_dir:
            return {}
        with CONFIG_LOCK:
            return dict(self._config.get("project_envs", {}).get(project_dir, {}))

    def get_effective_env(self, script_path):
        """Return effective env settings; prefer .pyrunner over global config."""
        global_cfg = self.get_config()
        local = self.read_local_config(script_path)
        project_global = self.get_project_env_global(script_path)

        if local:
            effective = {
                "python_path": local.get("python_path") or global_cfg.get("python_path", ""),
                "pip_index_url": local.get("pip_index_url") or global_cfg.get(
                    "pip_index_url", DEFAULT_PIP_INDEX
                ),
                "use_venv": local.get("use_venv", True),
                "venv_path": local.get("venv_path", ""),
            }
            save_to_local = project_global.get("save_to_local", True)
            return effective, "local", True, save_to_local

        effective = {
            "python_path": global_cfg.get("python_path", ""),
            "pip_index_url": global_cfg.get("pip_index_url", DEFAULT_PIP_INDEX),
            "use_venv": project_global.get("use_venv", True),
            "venv_path": project_global.get("venv_path", ""),
        }
        save_to_local = bool(project_global.get("save_to_local", False))
        return effective, "global", False, save_to_local

    def save_project_config(self, script_path, updates, save_to_local=False):
        allowed = ("python_path", "pip_index_url", "use_venv", "venv_path")
        project_updates = {k: updates[k] for k in allowed if k in updates}
        if save_to_local:
            self.write_local_config(script_path, project_updates)
            self.set_project_env(script_path, {"save_to_local": True})
            return self.read_local_config(script_path)
        self.remove_local_config(script_path)
        global_updates = {}
        if "python_path" in project_updates:
            global_updates["python_path"] = project_updates["python_path"]
        if "pip_index_url" in project_updates:
            global_updates["pip_index_url"] = project_updates["pip_index_url"]
        if global_updates:
            self.save_config(global_updates)
        pe_updates = {
            k: project_updates[k] for k in ("use_venv", "venv_path") if k in project_updates
        }
        pe_updates["save_to_local"] = False
        if pe_updates:
            return self.set_project_env(script_path, pe_updates)
        return self.get_project_env_global(script_path)

    def _update_project_venv(self, script_path, venv_path, use_venv=True):
        local = self.read_local_config(script_path)
        pref = self.get_project_env_global(script_path).get("save_to_local", False)
        if local is not None or pref:
            self.write_local_config(
                script_path, {"venv_path": venv_path, "use_venv": use_venv}
            )
            self.set_project_env(script_path, {"save_to_local": True})
        else:
            self.set_project_env(
                script_path, {"venv_path": venv_path, "use_venv": use_venv}
            )

    def get_project_env(self, script_path):
        effective, _, _, _ = self.get_effective_env(script_path)
        return {
            "use_venv": effective.get("use_venv", True),
            "venv_path": effective.get("venv_path", ""),
        }

    def set_project_env(self, script_path, updates):
        project_dir = self.get_project_dir(script_path)
        if not project_dir:
            raise ValueError("Invalid script path")
        with CONFIG_LOCK:
            envs = self._config.setdefault("project_envs", {})
            current = dict(envs.get(project_dir, {}))
            current.update(updates)
            envs[project_dir] = current
            self._save_unlocked(self._config)
            return current

    @staticmethod
    def validate_abs_path(path, allow_nonexistent=False):
        if not path or not path.startswith("/"):
            return False, "Path must be absolute"
        if ".." in path.split("/"):
            return False, "Path traversal not allowed"
        p = Path(path)
        if not allow_nonexistent and not p.exists():
            return False, "Path does not exist"
        return True, p

    def discover_pythons(self):
        found = {}
        search_names = []
        for minor in range(14, 6, -1):
            search_names.append(f"python3.{minor}")
        search_names.extend(["python3", "python"])

        for name in search_names:
            exe = shutil.which(name)
            if exe and exe not in found:
                version = self._python_version(exe)
                found[exe] = {"path": exe, "version": version, "label": f"{exe} ({version})" if version else exe}

        for pattern_dir in ["/usr/bin", "/usr/local/bin", "/opt/bin"]:
            bin_dir = Path(pattern_dir)
            if not bin_dir.is_dir():
                continue
            for entry in sorted(bin_dir.glob("python3*")):
                if not entry.is_file():
                    continue
                if not os.access(entry, os.X_OK):
                    continue
                exe = str(entry.resolve())
                if exe in found:
                    continue
                if re.match(r"python3(\.\d+)?$", entry.name):
                    version = self._python_version(exe)
                    found[exe] = {"path": exe, "version": version, "label": f"{exe} ({version})" if version else exe}

        interpreters = sorted(found.values(), key=lambda x: x.get("version") or "", reverse=True)
        default = self.get_config().get("python_path") or (interpreters[0]["path"] if interpreters else "")
        if not default:
            default = shutil.which("python3") or sys_executable_fallback()
        return {"interpreters": interpreters, "default": default}

    @staticmethod
    def _python_version(exe):
        try:
            result = subprocess.run(
                [exe, "--version"],
                capture_output=True, text=True, timeout=5,
            )
            text = (result.stdout or result.stderr or "").strip()
            if text.startswith("Python "):
                return text.replace("Python ", "")
            return text or ""
        except Exception:
            return ""

    def resolve_runtime(self, script_path):
        """Resolve effective python/pip for a script."""
        effective, _, _, _ = self.get_effective_env(script_path)
        project_dir = self.get_project_dir(script_path)

        python_path = effective.get("python_path") or shutil.which("python3") or sys_executable_fallback()
        venv_path = effective.get("venv_path", "")
        use_venv = effective.get("use_venv", True)
        pip_index_url = effective.get("pip_index_url", DEFAULT_PIP_INDEX)

        # 未指定 venv 且未显式选择系统 Python 时，自动使用项目 .venv
        auto_venv = str(Path(project_dir) / ".venv") if project_dir else ""
        if use_venv and not venv_path and auto_venv:
            auto_python = Path(auto_venv) / "bin" / "python"
            if auto_python.is_file():
                venv_path = auto_venv

        if use_venv and venv_path:
            venv_python = Path(venv_path) / "bin" / "python"
            venv_pip = Path(venv_path) / "bin" / "pip"
            if venv_python.is_file():
                return {
                    "python_path": str(venv_python),
                    "pip_path": str(venv_pip) if venv_pip.is_file() else None,
                    "venv_path": venv_path,
                    "use_venv": True,
                    "pip_index_url": pip_index_url,
                    "mode": "venv",
                    "label": f"venv ({Path(venv_path).name})",
                }

        system_pip = None
        if python_path:
            parent = Path(python_path).parent
            for name in ("pip", "pip3"):
                candidate = parent / name
                if candidate.is_file():
                    system_pip = str(candidate)
                    break

        return {
            "python_path": python_path,
            "pip_path": system_pip,
            "venv_path": "",
            "use_venv": False,
            "pip_index_url": pip_index_url,
            "mode": "system",
            "label": f"system ({Path(python_path).name})",
        }

    def _discover_project_venvs(self, project_dir):
        """扫描项目目录中实际存在的虚拟环境（含 bin/python 的子目录）。"""
        if not project_dir:
            return []
        pdir = Path(project_dir)
        if not pdir.is_dir():
            return []

        skip_names = {"__pycache__", "node_modules", ".git", ".svn", "site-packages", "dist", "build"}
        results = []
        seen = set()

        try:
            for entry in sorted(pdir.iterdir()):
                if not entry.is_dir() or entry.name in skip_names:
                    continue
                py = entry / "bin" / "python"
                if not py.is_file():
                    continue
                path_str = str(entry.resolve())
                if path_str in seen:
                    continue
                seen.add(path_str)
                results.append((path_str, f"项目 {entry.name}"))
        except OSError:
            pass

        return results

    @staticmethod
    def _is_valid_venv(path):
        return (Path(path) / "bin" / "python").is_file()

    def _pip_command(self, runtime, *args):
        """Build pip argv tied to the effective Python interpreter."""
        if runtime.get("use_venv") and runtime.get("venv_path"):
            pip = runtime.get("pip_path") or str(Path(runtime["venv_path"]) / "bin" / "pip")
            if Path(pip).is_file():
                return [pip, *args]

        py = runtime.get("python_path")
        if py and Path(py).is_file():
            parent = Path(py).parent
            for name in ("pip", "pip3"):
                candidate = parent / name
                if candidate.is_file():
                    return [str(candidate), *args]
            return [py, "-m", "pip", *args]

        pip = shutil.which("pip3") or shutil.which("pip")
        if pip:
            return [pip, *args]
        return None

    def _resolve_pip_path(self, runtime):
        """Return display path for the pip command."""
        cmd = self._pip_command(runtime, "list")
        if not cmd:
            return ""
        if len(cmd) >= 3 and cmd[1] == "-m" and cmd[2] == "pip":
            return f"{cmd[0]} -m pip"
        return cmd[0]

    def list_venvs(self, script_path):
        """列出可选运行环境：系统 Python + 项目/全局虚拟环境。"""
        project_dir = self.get_project_dir(script_path)
        effective, _, _, _ = self.get_effective_env(script_path)
        system_python = (
            effective.get("python_path")
            or self.get_config().get("python_path")
            or shutil.which("python3")
            or sys_executable_fallback()
        )
        system_version = self._python_version(system_python)

        environments = [{
            "path": "",
            "description": "系统 Python",
            "exists": bool(system_python and Path(system_python).is_file()),
            "python_version": system_version,
            "python_path": system_python or "",
            "kind": "system",
        }]

        candidates = list(self._discover_project_venvs(project_dir))
        seen_paths = {c[0] for c in candidates}

        configured_venv = effective.get("venv_path", "")
        if configured_venv:
            cfg_path = str(Path(configured_venv).resolve())
            if cfg_path not in seen_paths and self._is_valid_venv(cfg_path):
                candidates.append((cfg_path, f"已配置 {Path(cfg_path).name}"))
                seen_paths.add(cfg_path)

        if self.venvs_dir.is_dir():
            for entry in sorted(self.venvs_dir.iterdir()):
                if not entry.is_dir():
                    continue
                path_str = str(entry.resolve())
                if path_str in seen_paths:
                    continue
                if self._is_valid_venv(path_str):
                    candidates.append((path_str, f"全局 {entry.name}"))
                    seen_paths.add(path_str)

        seen = set()
        for path, desc in candidates:
            if path in seen:
                continue
            seen.add(path)
            py = Path(path) / "bin" / "python"
            environments.append({
                "path": path,
                "description": desc,
                "exists": True,
                "python_version": self._python_version(str(py)),
                "python_path": str(py),
                "kind": "venv",
            })

        runtime = self.resolve_runtime(script_path)
        configured_venv = effective.get("venv_path", "")
        use_venv = effective.get("use_venv", True)
        if configured_venv and self._is_valid_venv(configured_venv):
            active = str(Path(configured_venv).resolve())
        elif not use_venv:
            active = ""
        elif runtime.get("venv_path") and self._is_valid_venv(runtime["venv_path"]):
            active = runtime["venv_path"]
        else:
            active = ""

        return {
            "environments": environments,
            "venvs": [e for e in environments if e.get("kind") == "venv"],
            "active": active,
            "project_dir": project_dir,
        }

    def create_venv(self, script_path, venv_path=None, python_path=None, name=None):
        ok, project_dir = self.validate_abs_path(self.get_project_dir(script_path))
        if not ok:
            raise ValueError(project_dir)

        if venv_path:
            ok, target = self.validate_abs_path(venv_path, allow_nonexistent=True)
            if not ok:
                raise ValueError(str(target))
        elif name:
            ok, target = self.validate_abs_path(str(self.venvs_dir / name), allow_nonexistent=True)
            if not ok:
                raise ValueError(str(target))
        else:
            target = Path(project_dir) / ".venv"

        if target.exists():
            raise ValueError(f"Virtual environment already exists: {target}")

        if not python_path:
            effective, _, _, _ = self.get_effective_env(script_path)
            python_path = effective.get("python_path") or self.get_config().get("python_path") or shutil.which("python3")
        if not python_path or not Path(python_path).is_file():
            raise ValueError("Python interpreter not found")

        result = subprocess.run(
            [python_path, "-m", "venv", str(target)],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "venv creation failed").strip()
            raise RuntimeError(err)

        venv_str = str(target)
        self._update_project_venv(script_path, venv_str, use_venv=True)

        # Configure pip index in venv
        pip_path = target / "bin" / "pip"
        if pip_path.is_file():
            effective, _, _, _ = self.get_effective_env(script_path)
            index_url = effective.get("pip_index_url", DEFAULT_PIP_INDEX)
            subprocess.run(
                [str(pip_path), "config", "set", "global.index-url", index_url],
                capture_output=True, text=True, timeout=30,
            )

        return {"venv_path": venv_str, "python_version": self._python_version(str(target / "bin" / "python"))}

    def pip_list(self, script_path):
        runtime = self.resolve_runtime(script_path)
        cmd = self._pip_command(runtime, "list", "--format=json")
        if not cmd:
            return {"packages": [], "pip_path": "", "error": "pip not found"}

        pip_label = self._resolve_pip_path(runtime)
        index_url = runtime.get("pip_index_url", DEFAULT_PIP_INDEX)
        result = subprocess.run(
            cmd,
            capture_output=True, text=True, timeout=60,
            env=self._subprocess_env(runtime),
        )
        if result.returncode != 0:
            return {
                "packages": [],
                "pip_path": pip_label,
                "python_path": runtime.get("python_path", ""),
                "error": (result.stderr or result.stdout).strip(),
            }

        try:
            packages = json.loads(result.stdout or "[]")
        except json.JSONDecodeError:
            packages = []

        return {
            "packages": packages,
            "pip_path": pip_label,
            "python_path": runtime.get("python_path", ""),
            "pip_index_url": index_url,
        }

    def pip_install(self, script_path, packages, upgrade=False):
        if not packages or not packages.strip():
            raise ValueError("Package name required")

        runtime = self.resolve_runtime(script_path)
        install_args = ["install", "-i", runtime.get("pip_index_url", DEFAULT_PIP_INDEX)]
        if upgrade:
            install_args.append("--upgrade")
        install_args.extend(packages.split())

        cmd = self._pip_command(runtime, *install_args)
        if not cmd:
            raise ValueError("pip not found. Create a virtual environment first.")

        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=300,
            env=self._subprocess_env(runtime),
        )
        output = (result.stdout or "") + (result.stderr or "")
        if result.returncode != 0:
            raise RuntimeError(output.strip() or "pip install failed")
        return {"output": output.strip(), "pip_path": self._resolve_pip_path(runtime)}

    @staticmethod
    def _subprocess_env(runtime):
        env = {**os.environ, "TERM": "dumb"}
        venv = runtime.get("venv_path")
        if venv:
            env["VIRTUAL_ENV"] = venv
            env["PATH"] = f"{Path(venv) / 'bin'}:{env.get('PATH', '')}"
        return env

    def build_script_env(self, runtime):
        env = {**os.environ, "TERM": "dumb", "PYTHONUNBUFFERED": "1"}
        venv = runtime.get("venv_path")
        if venv and runtime.get("use_venv"):
            env["VIRTUAL_ENV"] = venv
            env["PATH"] = f"{Path(venv) / 'bin'}:{env.get('PATH', '')}"
        return env


def sys_executable_fallback():
    import sys
    return sys.executable or "/usr/bin/python3"
