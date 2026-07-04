(function () {
  "use strict";

  const DEFAULT_PIP_INDEX = "https://pypi.tuna.tsinghua.edu.cn/simple";
  const api = (path, options) => {
    const fetcher = window.pyrunnerCommon ? window.pyrunnerCommon.apiFetch : fetch;
    if (window.pyrunnerCommon) {
      return fetcher(path, options).then(r =>
        r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || "HTTP " + r.status)))
      );
    }
    return fetch("./api" + path, options).then(r =>
      r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || "HTTP " + r.status)))
    );
  };

  let envConfig = {};
  let effectiveEnv = {};
  let configSource = "global";
  let runtimeInfo = { label: "环境", mode: "none" };
  let currentScriptPath = "";
  let envPanelOpen = false;
  let suppressVenvChange = false;

  const els = {};

  function bindElements() {
    const ids = [
      "mainArea", "envPanel", "envBadge", "btnEnv", "envBackBtn", "pythonSelect",
      "pipIndexInput", "btnRefreshPython", "btnSaveEnv", "projectDirInput",
      "venvSelect", "btnCreateVenv", "venvLog",
      "pipPackageInput", "btnPipInstall", "btnRefreshPackages", "packageList", "pipLog",
      "saveToLocalCheck", "configSourceHint", "saveToLocalGroup",
    ];
    ids.forEach(function (id) {
      els[id] = document.getElementById(id);
    });
  }

  function showToast(msg, type) {
    if (window.pyrunnerShowToast) window.pyrunnerShowToast(msg, type);
  }

  function updateEnvBadge() {
    if (!els.envBadge) return;
    const label = runtimeInfo.label || "环境";
    els.envBadge.textContent = label;
    els.envBadge.className = "env-badge" + (runtimeInfo.mode === "venv" ? " venv-active" : "");
    els.envBadge.title = runtimeInfo.mode === "venv"
      ? "虚拟环境: " + (runtimeInfo.venv_path || label)
      : runtimeInfo.mode === "none"
        ? "点击配置 Python 运行环境"
        : "系统 Python: " + (runtimeInfo.python_path || label);
  }

  function setScriptPath(path) {
    currentScriptPath = path || "";
    refreshRuntime();
  }

  function refreshRuntime() {
    if (!currentScriptPath) {
      runtimeInfo = { label: "未打开文件", mode: "none" };
      updateEnvBadge();
      return Promise.resolve();
    }
    return api("/env/resolve?path=" + encodeURIComponent(currentScriptPath))
      .then(function (data) {
        runtimeInfo = data.runtime || {};
        updateEnvBadge();
        return data;
      })
      .catch(function () {
        runtimeInfo = { label: "system", mode: "system" };
        updateEnvBadge();
      });
  }

  function updateConfigSourceHint(data) {
    if (!els.configSourceHint) return;
    if (!currentScriptPath) {
      els.configSourceHint.textContent = "打开 .py 文件后可保存到项目目录 .pyrunner";
      return;
    }
    if (data && data.config_source === "local") {
      els.configSourceHint.textContent =
        "当前配置来自项目目录 .pyrunner" +
        (data.local_config_path ? "（" + data.local_config_path + "）" : "");
    } else {
      els.configSourceHint.textContent = "当前配置来自全局 env.json，可勾选上方选项保存到 .pyrunner";
    }
  }

  function applyEffectiveEnv(data) {
    effectiveEnv = (data && data.effective) || {};
    configSource = (data && data.config_source) || "global";
    if (els.pipIndexInput) {
      els.pipIndexInput.value = effectiveEnv.pip_index_url || DEFAULT_PIP_INDEX;
    }
    if (els.saveToLocalGroup) {
      els.saveToLocalGroup.hidden = !currentScriptPath;
    }
    if (els.saveToLocalCheck) {
      els.saveToLocalCheck.disabled = !currentScriptPath;
      if (currentScriptPath && data) {
        els.saveToLocalCheck.checked = !!data.save_to_local;
      } else {
        els.saveToLocalCheck.checked = false;
      }
    }
    updateConfigSourceHint(data);
  }

  function loadEnvConfig() {
    if (!currentScriptPath) {
      return api("/env").then(function (cfg) {
        envConfig = cfg;
        effectiveEnv = {
          python_path: cfg.python_path || "",
          pip_index_url: cfg.pip_index_url || DEFAULT_PIP_INDEX,
        };
        if (els.pipIndexInput) {
          els.pipIndexInput.value = effectiveEnv.pip_index_url;
        }
        applyEffectiveEnv(null);
        return cfg;
      });
    }
    return api("/env/resolve?path=" + encodeURIComponent(currentScriptPath))
      .then(function (data) {
        return api("/env").then(function (cfg) {
          envConfig = cfg;
          applyEffectiveEnv(data);
          return data;
        });
      });
  }

  function loadPythonList() {
    return api("/python/list").then(function (data) {
      if (!els.pythonSelect) return;
      els.pythonSelect.innerHTML = "";
      const selected = effectiveEnv.python_path || envConfig.python_path || data.default;
      (data.interpreters || []).forEach(function (item) {
        const opt = document.createElement("option");
        opt.value = item.path;
        opt.textContent = item.label;
        if (item.path === selected) opt.selected = true;
        els.pythonSelect.appendChild(opt);
      });
      if (!els.pythonSelect.options.length && data.default) {
        const opt = document.createElement("option");
        opt.value = data.default;
        opt.textContent = data.default;
        opt.selected = true;
        els.pythonSelect.appendChild(opt);
      }
    });
  }

  function formatEnvOption(env) {
    if (env.kind === "system" || !env.path) {
      const py = env.python_path || "系统 Python";
      const ver = env.python_version ? " — Python " + env.python_version : "";
      return "系统 Python（" + py + "）" + ver;
    }
    const status = env.python_version ? "Python " + env.python_version : "已就绪";
    return env.description + " — " + env.path + "（" + status + "）";
  }

  function getEnvSelection() {
    const venvPath = els.venvSelect ? els.venvSelect.value : "";
    return {
      venv_path: venvPath,
      use_venv: venvPath !== "",
    };
  }

  function loadVenvList() {
    if (!currentScriptPath) {
      if (els.projectDirInput) els.projectDirInput.value = "";
      if (els.venvSelect) els.venvSelect.innerHTML = '<option value="">请先打开 .py 文件</option>';
      return Promise.resolve();
    }
    return api("/venv/list?path=" + encodeURIComponent(currentScriptPath)).then(function (data) {
      if (els.projectDirInput) els.projectDirInput.value = data.project_dir || "";
      if (!els.venvSelect) return;

      const environments = data.environments || data.venvs || [];
      const active = data.active != null ? data.active : "";
      suppressVenvChange = true;
      els.venvSelect.innerHTML = "";

      environments.forEach(function (env) {
        const opt = document.createElement("option");
        opt.value = env.path || "";
        opt.textContent = formatEnvOption(env);
        if (env.path === active || (!env.path && !active)) {
          opt.selected = true;
        }
        els.venvSelect.appendChild(opt);
      });

      els.venvSelect.value = active;
      suppressVenvChange = false;
      return api("/env/resolve?path=" + encodeURIComponent(currentScriptPath)).then(function (res) {
        applyEffectiveEnv(res);
      });
    });
  }

  function loadPackages() {
    if (!els.packageList) return Promise.resolve();
    if (!currentScriptPath) {
      els.packageList.innerHTML = '<div class="package-empty">请先打开 .py 文件</div>';
      return Promise.resolve();
    }
    els.packageList.innerHTML = '<div class="package-empty">加载中...</div>';
    return api("/pip/list?path=" + encodeURIComponent(currentScriptPath)).then(function (data) {
      if (data.error) {
        els.packageList.innerHTML = '<div class="package-empty">' + escapeHtml(data.error) + '</div>';
        return;
      }
      const pkgs = data.packages || [];
      if (!pkgs.length) {
        els.packageList.innerHTML = '<div class="package-empty">暂无已安装的包</div>';
        return;
      }
      els.packageList.innerHTML = pkgs.map(function (p) {
        return '<div class="package-item"><span class="pkg-name">' + escapeHtml(p.name) +
          '</span><span class="pkg-version">' + escapeHtml(p.version) + '</span></div>';
      }).join("");
    }).catch(function (err) {
      els.packageList.innerHTML = '<div class="package-empty">' + escapeHtml(err.message) + '</div>';
    });
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function setBtnEnvState(open) {
    if (!els.btnEnv) return;
    if (open) {
      els.btnEnv.innerHTML = '<span class="btn-glyph">←</span><span class="btn-text">返回</span>';
      els.btnEnv.title = "返回编辑";
    } else {
      els.btnEnv.innerHTML = '<span class="btn-glyph">⚙</span><span class="btn-text">环境</span>';
      els.btnEnv.title = "环境设置";
    }
  }

  function openEnvPanel() {
    if (!els.envPanel || !els.mainArea) return;
    envPanelOpen = true;
    els.mainArea.classList.add("is-hidden");
    els.mainArea.style.display = "none";
    els.envPanel.hidden = false;
    els.envPanel.classList.add("is-visible");
    els.envPanel.style.display = "flex";
    setBtnEnvState(true);
    loadEnvConfig()
      .catch(function () { return {}; })
      .then(function () { return loadPythonList(); })
      .then(function () { return loadVenvList(); })
      .then(function () { return loadPackages(); })
      .catch(function (err) {
        showToast("加载环境配置失败: " + err.message, "error");
      });
  }

  function closeEnvPanel() {
    if (!els.envPanel || !els.mainArea) return;
    envPanelOpen = false;
    els.mainArea.classList.remove("is-hidden");
    els.mainArea.style.display = "";
    els.envPanel.classList.remove("is-visible");
    els.envPanel.style.display = "";
    els.envPanel.hidden = true;
    setBtnEnvState(false);
    refreshRuntime();
  }

  function toggleEnvPanel() {
    if (envPanelOpen) closeEnvPanel();
    else openEnvPanel();
  }

  function buildSaveBody() {
    const body = {
      python_path: els.pythonSelect ? els.pythonSelect.value : "",
      pip_index_url: els.pipIndexInput
        ? (els.pipIndexInput.value.trim() || DEFAULT_PIP_INDEX)
        : DEFAULT_PIP_INDEX,
    };
    if (currentScriptPath) {
      body.script_path = currentScriptPath;
      body.save_to_local = els.saveToLocalCheck ? els.saveToLocalCheck.checked : false;
      body.project = getEnvSelection();
    }
    return body;
  }

  function saveGlobalEnv() {
    const body = buildSaveBody();
    if (els.btnSaveEnv) els.btnSaveEnv.disabled = true;
    return api("/env", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(function (cfg) {
        envConfig = cfg;
        const msg = body.save_to_local
          ? "环境设置已保存到 .pyrunner"
          : "环境设置已保存到全局配置";
        showToast(msg, "success");
        return loadEnvConfig()
          .then(function () { return refreshRuntime(); })
          .then(function () { return loadPackages(); });
      })
      .catch(function (err) { showToast("保存失败: " + err.message, "error"); })
      .finally(function () { if (els.btnSaveEnv) els.btnSaveEnv.disabled = false; });
  }

  function createVenv() {
    if (!currentScriptPath) {
      showToast("请先打开 .py 文件", "error");
      return;
    }
    if (els.btnCreateVenv) els.btnCreateVenv.disabled = true;
    if (els.venvLog) els.venvLog.textContent = "正在创建虚拟环境...";
    api("/venv/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script_path: currentScriptPath,
        python_path: els.pythonSelect ? els.pythonSelect.value : "",
      }),
    })
      .then(function (result) {
        if (els.venvLog) {
          els.venvLog.textContent = "创建成功: " + result.venv_path +
            " (Python " + (result.python_version || "") + ")";
        }
        showToast("虚拟环境创建成功", "success");
        return loadVenvList().then(function () { return refreshRuntime(); });
      })
      .catch(function (err) {
        if (els.venvLog) els.venvLog.textContent = "创建失败: " + err.message;
        showToast("创建失败: " + err.message, "error");
      })
      .finally(function () { if (els.btnCreateVenv) els.btnCreateVenv.disabled = false; });
  }

  function applyEnvSelection() {
    if (!currentScriptPath) {
      showToast("请先打开 .py 文件", "error");
      return Promise.resolve();
    }
    const selection = getEnvSelection();
    return api("/env", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        script_path: currentScriptPath,
        save_to_local: els.saveToLocalCheck ? els.saveToLocalCheck.checked : false,
        project: selection,
      }),
    })
      .then(function () {
        showToast("运行环境已更新", "success");
        return refreshRuntime().then(function () { return loadPackages(); });
      })
      .catch(function (err) { showToast("更新失败: " + err.message, "error"); });
  }

  function pollTask(taskId, logEl, onDone) {
    const timer = setInterval(function () {
      api("/task/" + taskId).then(function (data) {
        if (logEl) {
          if (data.stdout) logEl.textContent = data.stdout;
          if (data.stderr) {
            logEl.textContent += (logEl.textContent ? "\n" : "") + data.stderr;
          }
        }
        if (data.status === "running" || data.status === "pending") return;
        clearInterval(timer);
        if (onDone) onDone(data);
      }).catch(function () { clearInterval(timer); });
    }, 500);
  }

  function pipInstall() {
    if (!currentScriptPath) {
      showToast("请先打开 .py 文件", "error");
      return;
    }
    const packages = els.pipPackageInput ? els.pipPackageInput.value.trim() : "";
    if (!packages) {
      showToast("请输入包名", "error");
      return;
    }
    if (els.btnPipInstall) els.btnPipInstall.disabled = true;
    if (els.pipLog) els.pipLog.textContent = "正在安装 " + packages + "...";
    api("/pip/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ script_path: currentScriptPath, packages: packages }),
    })
      .then(function (data) {
        pollTask(data.task_id, els.pipLog, function (result) {
          if (els.btnPipInstall) els.btnPipInstall.disabled = false;
          if (result.status === "done") {
            showToast("安装成功", "success");
            if (els.pipPackageInput) els.pipPackageInput.value = "";
            loadPackages();
          } else {
            showToast("安装失败", "error");
          }
        });
      })
      .catch(function (err) {
        if (els.pipLog) els.pipLog.textContent = "安装失败: " + err.message;
        if (els.btnPipInstall) els.btnPipInstall.disabled = false;
        showToast("安装失败: " + err.message, "error");
      });
  }

  function bindEvents() {
    document.querySelectorAll(".env-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".env-tab").forEach(function (t) { t.classList.remove("active"); });
        document.querySelectorAll(".env-tab-panel").forEach(function (p) { p.classList.remove("active"); });
        tab.classList.add("active");
        const panel = document.getElementById("tab-" + tab.dataset.tab);
        if (panel) panel.classList.add("active");
        if (tab.dataset.tab === "pip") loadPackages();
        if (tab.dataset.tab === "venv") loadVenvList();
      });
    });

    if (els.btnEnv) els.btnEnv.addEventListener("click", toggleEnvPanel);
    if (els.envBadge) els.envBadge.addEventListener("click", openEnvPanel);
    if (els.envBackBtn) els.envBackBtn.addEventListener("click", closeEnvPanel);
    if (els.btnRefreshPython) {
      els.btnRefreshPython.addEventListener("click", function () {
        loadPythonList().then(function () { showToast("已刷新", "success"); });
      });
    }
    if (els.btnSaveEnv) els.btnSaveEnv.addEventListener("click", saveGlobalEnv);
    if (els.btnCreateVenv) els.btnCreateVenv.addEventListener("click", createVenv);
    if (els.venvSelect) {
      els.venvSelect.addEventListener("change", function () {
        if (suppressVenvChange) return;
        applyEnvSelection();
      });
    }
    if (els.btnPipInstall) els.btnPipInstall.addEventListener("click", pipInstall);
    if (els.btnRefreshPackages) els.btnRefreshPackages.addEventListener("click", loadPackages);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && envPanelOpen) {
        closeEnvPanel();
      }
    });
  }

  function init() {
    bindElements();
    bindEvents();
    updateEnvBadge();
    loadEnvConfig().catch(function () { /* ignore */ }).then(function () {
      return refreshRuntime();
    });

    window.pyrunnerEnv = {
      setScriptPath: setScriptPath,
      refreshRuntime: refreshRuntime,
      getRuntime: function () { return runtimeInfo; },
      openEnvPanel: openEnvPanel,
      closeEnvPanel: closeEnvPanel,
      openModal: openEnvPanel,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
