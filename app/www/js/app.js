(function () {
  "use strict";

  const apiFetch = window.pyrunnerCommon
    ? window.pyrunnerCommon.apiFetch.bind(window.pyrunnerCommon)
    : function (path, options) { return fetch("./api/" + path.replace(/^\//, ""), options); };

  function api(path, options) {
    const url = path.startsWith("/") ? path : "/" + path;
    return apiFetch(url, options).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (e) {
        return Promise.reject(new Error(e.error || "HTTP " + r.status));
      });
    });
  }

  let editor = null;
  let currentPath = "";
  let savedContent = "";
  let isDirty = false;
  let currentTaskId = null;
  let pollTimer = null;
  let lastStdoutLen = 0;
  let lastStderrLen = 0;
  let outputExpandedHeight = 220;
  let outputStreamEl = null;

  const els = {
    filePath: document.getElementById("filePath"),
    unsavedDot: document.getElementById("unsavedDot"),
    btnSave: document.getElementById("btnSave"),
    btnRun: document.getElementById("btnRun"),
    btnStop: document.getElementById("btnStop"),
    argsInput: document.getElementById("argsInput"),
    outputArea: document.getElementById("outputArea"),
    outputInputForm: document.getElementById("outputInputForm"),
    outputInput: document.getElementById("outputInput"),
    statusDot: document.getElementById("statusDot"),
    statusText: document.getElementById("statusText"),
    exitCodeDisplay: document.getElementById("exitCodeDisplay"),
    exitCodeValue: document.getElementById("exitCodeValue"),
    editorPanel: document.getElementById("editorPanel"),
    emptyState: document.getElementById("emptyState"),
    outputPanel: document.getElementById("outputPanel"),
    resizeHandle: document.getElementById("resizeHandle"),
    btnToggleOutput: document.getElementById("btnToggleOutput"),
    mainArea: document.getElementById("mainArea"),
    toast: document.getElementById("toast"),
  };

  function detectTheme() {
    try {
      const cookie = document.cookie.split(";").map(function (s) { return s.trim(); })
        .find(function (s) { return s.startsWith("fnos-theme-mode="); });
      if (cookie) {
        const val = decodeURIComponent(cookie.split("=")[1] || "").toLowerCase();
        if (val === "10" || val === "light") return "light";
        if (val === "20" || val === "dark") return "dark";
      }
    } catch (e) { /* ignore */ }
    try {
      const parentStored = window.parent && window.parent.localStorage
        ? window.parent.localStorage.getItem("fnos-theme-mode") : null;
      if (parentStored === "10" || parentStored === "light") return "light";
      if (parentStored === "20" || parentStored === "dark") return "dark";
    } catch (e) { /* ignore */ }
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
  }

  function applyTheme() {
    document.documentElement.dataset.theme = detectTheme();
    if (editor) {
      editor.setOption("theme", detectTheme() === "dark" ? "material-darker" : "eclipse");
    }
  }

  function showToast(msg, type) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = "toast show" + (type ? " " + type : "");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () { els.toast.className = "toast"; }, 2500);
  }
  window.pyrunnerShowToast = showToast;

  function setDirty(dirty) {
    isDirty = dirty;
    if (els.unsavedDot) els.unsavedDot.classList.toggle("visible", dirty);
    const name = currentPath ? currentPath.split("/").pop() : "Python 编辑器";
    document.title = (dirty ? "● " : "") + name + " - pyrunner";
  }

  function initEditor() {
    if (editor || !els.editorPanel) return;
    editor = CodeMirror(els.editorPanel, {
      value: "",
      mode: "python",
      theme: detectTheme() === "dark" ? "material-darker" : "eclipse",
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: false,
      autofocus: true,
      extraKeys: {
        Tab: function (cm) {
          if (cm.somethingSelected()) cm.indentSelection("add");
          else cm.replaceSelection("    ", "end");
        },
        "Ctrl-S": function () { saveFile(); },
        "Cmd-S": function () { saveFile(); },
        "F5": function () { runScript(); },
      },
    });
    editor.on("change", function () {
      setDirty(editor.getValue() !== savedContent);
    });
    applyTheme();
  }

  function setCurrentPath(path) {
    if (!path || path === currentPath) return;
    currentPath = path;
    loadFile();
  }

  function loadFile() {
    if (!currentPath) {
      if (els.emptyState) els.emptyState.style.display = "flex";
      if (els.filePath) els.filePath.textContent = "未打开文件";
      if (window.pyrunnerEnv) window.pyrunnerEnv.setScriptPath("");
      return;
    }

    if (els.emptyState) els.emptyState.style.display = "none";
    if (els.filePath) {
      els.filePath.textContent = currentPath;
      els.filePath.title = currentPath;
    }
    if (window.pyrunnerEnv) window.pyrunnerEnv.setScriptPath(currentPath);

    api("/file?path=" + encodeURIComponent(currentPath))
      .then(function (data) {
        savedContent = data.content;
        if (!editor) initEditor();
        editor.setValue(data.content);
        editor.clearHistory();
        setDirty(false);
      })
      .catch(function (err) {
        showToast("加载失败: " + err.message, "error");
        if (!editor) initEditor();
      });
  }

  function saveFile() {
    if (!currentPath) {
      showToast("未打开文件，无法保存", "error");
      return;
    }
    if (!editor) return;

    const content = editor.getValue();
    if (els.btnSave) els.btnSave.disabled = true;

    api("/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentPath, content: content }),
    })
      .then(function () {
        savedContent = content;
        setDirty(false);
        showToast("已保存", "success");
      })
      .catch(function (err) { showToast("保存失败: " + err.message, "error"); })
      .finally(function () { if (els.btnSave) els.btnSave.disabled = false; });
  }

  function isOutputCollapsed() {
    return els.mainArea && els.mainArea.classList.contains("output-collapsed");
  }

  function updateToggleOutputBtn(expanded) {
    if (!els.btnToggleOutput) return;
    const icon = els.btnToggleOutput.querySelector(".output-toggle-icon");
    if (icon) icon.textContent = expanded ? "▼" : "▲";
    els.btnToggleOutput.title = expanded ? "收起输出" : "展开输出";
    els.btnToggleOutput.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function expandOutputPanel() {
    if (!els.outputPanel || !els.mainArea) return;
    els.mainArea.classList.remove("output-collapsed");
    if (outputExpandedHeight) {
      els.outputPanel.style.height = outputExpandedHeight + "px";
    }
    updateToggleOutputBtn(true);
  }

  function collapseOutputPanel() {
    if (!els.outputPanel || !els.mainArea) return;
    if (!isOutputCollapsed()) {
      outputExpandedHeight = els.outputPanel.offsetHeight || outputExpandedHeight;
    }
    els.mainArea.classList.add("output-collapsed");
    els.outputPanel.style.height = "";
    updateToggleOutputBtn(false);
  }

  function toggleOutputPanel() {
    if (isOutputCollapsed()) expandOutputPanel();
    else collapseOutputPanel();
  }

  function clearOutput() {
    outputStreamEl = null;
    if (els.outputArea) els.outputArea.innerHTML = "";
  }

  function ensureOutputStream() {
    if (!els.outputArea) return null;
    if (!outputStreamEl) {
      outputStreamEl = document.createElement("pre");
      outputStreamEl.className = "output-stream";
      els.outputArea.appendChild(outputStreamEl);
    }
    return outputStreamEl;
  }

  function appendStream(text) {
    if (!text) return;
    const stream = ensureOutputStream();
    if (!stream) return;
    stream.textContent += text;
    els.outputArea.scrollTop = els.outputArea.scrollHeight;
  }

  function addLine(text, cls) {
    if (!els.outputArea) return;
    const div = document.createElement("div");
    div.className = "line " + (cls || "stdout");
    div.textContent = text;
    els.outputArea.appendChild(div);
    els.outputArea.scrollTop = els.outputArea.scrollHeight;
  }

  function setStatus(status, text) {
    if (els.statusDot) els.statusDot.className = "status-dot " + status;
    if (els.statusText) els.statusText.textContent = text;
  }

  function setInteractiveInput(enabled) {
    if (!els.outputInputForm) return;
    els.outputInputForm.hidden = !enabled;
    if (enabled && els.outputInput) {
      setTimeout(function () { els.outputInput.focus(); }, 0);
    } else if (els.outputInput) {
      els.outputInput.value = "";
    }
  }

  function sendStdin(line) {
    if (!currentTaskId) return Promise.reject(new Error("无运行中的任务"));
    return apiFetch("/task/" + currentTaskId + "/stdin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line: line }),
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (e) {
          return Promise.reject(new Error(e.error || "HTTP " + r.status));
        });
      }
      return r.json();
    });
  }

  function submitOutputInput() {
    if (!els.outputInput || !currentTaskId) return;
    const line = els.outputInput.value;
    if (line === "") {
      sendStdin("\n").catch(function (err) {
        showToast("发送输入失败: " + err.message, "error");
      });
    } else {
      sendStdin(line).catch(function (err) {
        showToast("发送输入失败: " + err.message, "error");
      });
    }
    els.outputInput.value = "";
    els.outputInput.focus();
  }

  function setRunning(running) {
    if (els.btnRun) els.btnRun.disabled = running;
    if (els.btnStop) els.btnStop.disabled = !running;
    if (els.argsInput) els.argsInput.disabled = running;
    if (editor) editor.setOption("readOnly", running);
    if (!running) setInteractiveInput(false);
  }

  function runScript() {
    if (!currentPath) {
      showToast("未打开文件，无法运行", "error");
      return;
    }

    const doRun = function () {
      expandOutputPanel();
      clearOutput();
      lastStdoutLen = 0;
      lastStderrLen = 0;
      const args = els.argsInput ? els.argsInput.value : "";
      const runtime = window.pyrunnerEnv ? window.pyrunnerEnv.getRuntime() : {};
      const py = runtime.python_path || "python3";
      addLine("$ " + py + " " + currentPath + (args ? " " + args : ""), "info");
      if (runtime.mode === "venv") addLine("# venv: " + runtime.venv_path, "info");

      setStatus("running", "运行中...");
      setRunning(true);
      setInteractiveInput(true);
      if (els.exitCodeDisplay) els.exitCodeDisplay.style.display = "none";

      const url = "/execute?path=" + encodeURIComponent(currentPath) +
        "&args=" + encodeURIComponent(args);

      api(url)
        .then(function (data) {
          currentTaskId = data.task_id;
          pollTimer = setInterval(function () { pollTask(currentTaskId); }, 400);
        })
        .catch(function (err) {
          addLine("启动失败: " + err.message, "error");
          setStatus("error", "失败");
          setRunning(false);
        });
    };

    if (!isDirty) {
      doRun();
      return;
    }

    const content = editor.getValue();
    api("/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentPath, content: content }),
    })
      .then(function () {
        savedContent = content;
        setDirty(false);
        doRun();
      })
      .catch(function (err) {
        showToast("自动保存失败: " + err.message, "error");
      });
  }

  function pollTask(taskId) {
    api("/task/" + taskId)
      .then(function (data) {
        if (data.stdout && data.stdout.length > lastStdoutLen) {
          appendStream(data.stdout.substring(lastStdoutLen));
          lastStdoutLen = data.stdout.length;
        }
        if (data.stderr && data.stderr.length > lastStderrLen) {
          const newErr = data.stderr.substring(lastStderrLen);
          lastStderrLen = data.stderr.length;
          appendStream(newErr);
        }

        if (data.interactive || data.status === "running") {
          setInteractiveInput(true);
        }

        if (data.status === "running" || data.status === "pending") return;

        clearInterval(pollTimer);
        pollTimer = null;
        setRunning(false);

        const code = data.exit_code;
        if (els.exitCodeDisplay) els.exitCodeDisplay.style.display = "";
        if (els.exitCodeValue) {
          els.exitCodeValue.textContent = code;
          els.exitCodeValue.className = "exit-code " + (code === 0 ? "success" : "fail");
        }

        const statusMap = {
          done: ["done", "完成"],
          error: ["error", "错误"],
          timeout: ["error", "超时"],
          killed: ["error", "已终止"],
        };
        const mapped = statusMap[data.status] || ["done", data.status];
        setStatus(mapped[0], mapped[1]);
      })
      .catch(function () {
        clearInterval(pollTimer);
        setRunning(false);
        setStatus("error", "失败");
      });
  }

  function stopScript() {
    if (!currentTaskId) return;
    apiFetch("/task/" + currentTaskId + "/stop", { method: "POST" }).catch(function () { /* ignore */ });
  }

  function setupResize() {
    if (!els.resizeHandle || !els.outputPanel) return;
    els.resizeHandle.addEventListener("mousedown", function (e) {
      if (isOutputCollapsed()) return;
      const startY = e.clientY;
      const startH = els.outputPanel.offsetHeight;
      function onMove(ev) {
        const delta = startY - ev.clientY;
        const newH = Math.max(80, Math.min(window.innerHeight * 0.6, startH + delta));
        els.outputPanel.style.height = newH + "px";
        outputExpandedHeight = newH;
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function initApp() {
    if (els.btnSave) els.btnSave.addEventListener("click", saveFile);
    if (els.btnRun) els.btnRun.addEventListener("click", runScript);
    if (els.btnStop) els.btnStop.addEventListener("click", stopScript);
    if (els.btnToggleOutput) els.btnToggleOutput.addEventListener("click", toggleOutputPanel);
    if (els.outputInputForm) {
      els.outputInputForm.addEventListener("submit", function (e) {
        e.preventDefault();
        submitOutputInput();
      });
    }
    setupResize();

    if (window.pyrunnerCommon) {
      window.pyrunnerCommon.watchFilePath(setCurrentPath);
    } else {
      const params = new URLSearchParams(window.location.search);
      setCurrentPath(params.get("path") || "");
    }

    window.addEventListener("beforeunload", function (e) {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
