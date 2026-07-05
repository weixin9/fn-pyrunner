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

  const TERMINAL_STATUS_LABEL = {
    running: "●",
    done: "✓",
    killed: "■",
    error: "✗",
    interrupted: "!",
    pending: "…",
  };

  const FINISHED_STATUS_MAP = {
    done: ["done", "完成"],
    error: ["error", "错误"],
    timeout: ["error", "超时"],
    killed: ["error", "已终止"],
    interrupted: ["error", "已中断"],
  };

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
  let streamRawText = "";

  let displayMode = "idle";
  let currentTerminalId = null;
  let terminalPollTimer = null;
  let terminalLogOffset = 0;
  let terminalList = [];
  let terminalListTimer = null;
  let terminalSelectLocked = false;
  let terminalSelectPendingSync = false;

  const els = {
    filePath: document.getElementById("filePath"),
    unsavedDot: document.getElementById("unsavedDot"),
    btnSave: document.getElementById("btnSave"),
    btnRun: document.getElementById("btnRun"),
    btnRunBackground: document.getElementById("btnRunBackground"),
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
    terminalSelect: document.getElementById("terminalSelect"),
    btnDeleteTerminal: document.getElementById("btnDeleteTerminal"),
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

  function saveBeforeRun() {
    if (!isDirty) return Promise.resolve();
    const content = editor.getValue();
    return api("/file", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentPath, content: content }),
    }).then(function () {
      savedContent = content;
      setDirty(false);
    });
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
    streamRawText = "";
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

  function renderOutputStream() {
    const stream = ensureOutputStream();
    if (!stream) return;
    if (window.pyrunnerAnsi) {
      stream.innerHTML = window.pyrunnerAnsi.toHtml(streamRawText);
    } else {
      stream.textContent = streamRawText;
    }
    els.outputArea.scrollTop = els.outputArea.scrollHeight;
  }

  function appendStream(text) {
    if (!text) return;
    streamRawText += text;
    renderOutputStream();
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
    if (displayMode === "terminal" && terminalPollTimer && status === "idle") return;
    if (els.statusDot) els.statusDot.className = "status-dot " + status;
    if (els.statusText) els.statusText.textContent = text;
  }

  function setInteractiveInput(enabled) {
    if (displayMode === "foreground" && !currentTaskId) {
      if (els.outputInputForm) els.outputInputForm.hidden = true;
      return;
    }
    if (displayMode === "terminal" && !currentTerminalId) {
      if (els.outputInputForm) els.outputInputForm.hidden = true;
      return;
    }
    if (!els.outputInputForm) return;
    const wasVisible = !els.outputInputForm.hidden;
    els.outputInputForm.hidden = !enabled;
    if (enabled && els.outputInput && !wasVisible && !terminalSelectLocked) {
      setTimeout(function () {
        if (!terminalSelectLocked) els.outputInput.focus();
      }, 0);
    } else if (!enabled && els.outputInput) {
      els.outputInput.value = "";
    }
  }

  function getTerminalMeta(terminalId) {
    return terminalList.find(function (t) { return t.id === terminalId; });
  }

  function isForegroundRunning() {
    return !!currentTaskId && !!pollTimer;
  }

  function isViewedTerminalRunning() {
    if (displayMode !== "terminal" || !currentTerminalId) return false;
    const meta = getTerminalMeta(currentTerminalId);
    return !!(meta && meta.status === "running");
  }

  function updateStopButton() {
    if (!els.btnStop) return;
    els.btnStop.disabled = !(isForegroundRunning() || isViewedTerminalRunning());
  }

  function setForegroundRunning(running) {
    if (els.btnRun) els.btnRun.disabled = running;
    if (els.argsInput) els.argsInput.disabled = running;
    if (editor) editor.setOption("readOnly", running);
    if (!running && displayMode === "foreground") setInteractiveInput(false);
    updateStopButton();
  }

  function sendStdin(line) {
    if (displayMode === "terminal" && currentTerminalId) {
      return api("/terminals/" + currentTerminalId + "/stdin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: line }),
      });
    }
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
    const canSend = (displayMode === "terminal" && currentTerminalId) ||
      (displayMode === "foreground" && currentTaskId);
    if (!els.outputInput || !canSend) return;
    const line = els.outputInput.value;
    const promise = line === "" ? sendStdin("\n") : sendStdin(line);
    promise.catch(function (err) {
      showToast("发送输入失败: " + err.message, "error");
    });
    els.outputInput.value = "";
    els.outputInput.focus();
  }

  function terminalOptionLabel(t) {
    const icon = TERMINAL_STATUS_LABEL[t.status] || "?";
    const suffix = t.status === "running" ? " (运行中)" : "";
    return icon + " " + (t.title || t.script_path || t.id) + suffix;
  }

  function requestTerminalSelectSync(selectId) {
    if (terminalSelectLocked) {
      terminalSelectPendingSync = true;
      return;
    }
    renderTerminalSelect(selectId);
  }

  function unlockTerminalSelect() {
    terminalSelectLocked = false;
    if (terminalSelectPendingSync) {
      terminalSelectPendingSync = false;
      renderTerminalSelect(displayMode === "terminal" ? currentTerminalId : undefined);
    }
  }

  function renderTerminalSelect(selectId) {
    if (!els.terminalSelect) return;
    const sel = els.terminalSelect;
    const prev = selectId !== undefined ? selectId : sel.value;

    let defaultOpt = sel.querySelector('option[value=""]');
    if (!defaultOpt) {
      defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "前台输出";
      sel.insertBefore(defaultOpt, sel.firstChild);
    }

    const seen = new Set([""]);
    terminalList.forEach(function (t) {
      seen.add(t.id);
      let opt = Array.from(sel.options).find(function (o) { return o.value === t.id; });
      const label = terminalOptionLabel(t);
      if (!opt) {
        opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = label;
        sel.appendChild(opt);
      } else if (opt.textContent !== label) {
        opt.textContent = label;
      }
    });

    Array.from(sel.options).forEach(function (opt) {
      if (opt.value && !seen.has(opt.value)) opt.remove();
    });

    if (prev && Array.from(sel.options).some(function (o) { return o.value === prev; })) {
      if (sel.value !== prev) sel.value = prev;
    }
  }

  function setupTerminalSelectInteraction() {
    const sel = els.terminalSelect;
    if (!sel) return;

    function lockSelect() {
      terminalSelectLocked = true;
    }

    sel.addEventListener("pointerdown", lockSelect);
    sel.addEventListener("mousedown", lockSelect);
    sel.addEventListener("focus", lockSelect);
    sel.addEventListener("keydown", function (e) {
      if (e.key === " " || e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        lockSelect();
      }
    });
    sel.addEventListener("keyup", function (e) {
      if (e.key === "Escape") setTimeout(unlockTerminalSelect, 0);
    });
    sel.addEventListener("blur", function () {
      setTimeout(unlockTerminalSelect, 0);
    });
    sel.addEventListener("change", function () {
      terminalSelectLocked = false;
      terminalSelectPendingSync = false;
      onTerminalSelectChange();
      setTimeout(function () {
        renderTerminalSelect(displayMode === "terminal" ? currentTerminalId : undefined);
      }, 0);
    });
  }

  function updateDeleteButton() {
    if (!els.btnDeleteTerminal) return;
    const meta = currentTerminalId ? getTerminalMeta(currentTerminalId) : null;
    const canDelete = displayMode === "terminal" && meta && meta.status !== "running";
    els.btnDeleteTerminal.hidden = !canDelete;
  }

  function refreshTerminalList(selectId) {
    return api("/terminals").then(function (data) {
      terminalList = data.terminals || [];
      requestTerminalSelectSync(selectId);
      updateDeleteButton();
      updateStopButton();
    }).catch(function () { /* ignore */ });
  }

  function applyFinishedStatus(data) {
    const code = data.exit_code;
    if (els.exitCodeDisplay) els.exitCodeDisplay.style.display = "";
    if (els.exitCodeValue) {
      els.exitCodeValue.textContent = code;
      els.exitCodeValue.className = "exit-code " + (code === 0 ? "success" : "fail");
    }
    const mapped = FINISHED_STATUS_MAP[data.status] || ["done", data.status];
    setStatus(mapped[0], mapped[1]);
  }

  function switchToForegroundView() {
    if (terminalPollTimer) {
      clearInterval(terminalPollTimer);
      terminalPollTimer = null;
    }
    displayMode = currentTaskId ? "foreground" : "idle";
    currentTerminalId = null;
    try { sessionStorage.removeItem("pyrunner_last_terminal"); } catch (e) { /* ignore */ }
    if (els.terminalSelect) els.terminalSelect.value = "";

    clearOutput();
    lastStdoutLen = 0;
    lastStderrLen = 0;

    if (currentTaskId) {
      pollTask(currentTaskId);
      if (!pollTimer) {
        pollTimer = setInterval(function () { pollTask(currentTaskId); }, 400);
      }
      setForegroundRunning(true);
    } else {
      setStatus("idle", "就绪");
      if (els.exitCodeDisplay) els.exitCodeDisplay.style.display = "none";
      setInteractiveInput(false);
    }
    updateDeleteButton();
    updateStopButton();
  }

  function switchToTerminalView(terminalId) {
    if (!terminalId) {
      switchToForegroundView();
      return;
    }

    displayMode = "terminal";
    currentTerminalId = terminalId;
    terminalLogOffset = 0;
    try { sessionStorage.setItem("pyrunner_last_terminal", terminalId); } catch (e) { /* ignore */ }

    if (els.terminalSelect) els.terminalSelect.value = terminalId;

    clearOutput();
    expandOutputPanel();

    if (terminalPollTimer) clearInterval(terminalPollTimer);
    pollTerminal(terminalId);
    terminalPollTimer = setInterval(function () { pollTerminal(terminalId); }, 500);

    updateDeleteButton();
    updateStopButton();
  }

  function pollTerminal(terminalId) {
    api("/terminals/" + terminalId + "?offset=" + terminalLogOffset)
      .then(function (data) {
        if (displayMode !== "terminal" || currentTerminalId !== terminalId) return;

        if (data.output) {
          appendStream(data.output);
        }
        terminalLogOffset = data.log_size != null ? data.log_size : terminalLogOffset;

        const idx = terminalList.findIndex(function (t) { return t.id === terminalId; });
        if (idx >= 0) {
          terminalList[idx] = Object.assign({}, terminalList[idx], {
            status: data.status,
            exit_code: data.exit_code,
            log_size: data.log_size,
            interactive: data.interactive,
          });
        } else {
          terminalList.push(data);
        }

        if (data.status === "running" || data.status === "pending") {
          setStatus("running", "运行中...");
          if (els.exitCodeDisplay) els.exitCodeDisplay.style.display = "none";
          setInteractiveInput(!!data.interactive);
          updateStopButton();
          return;
        }

        if (terminalPollTimer) {
          clearInterval(terminalPollTimer);
          terminalPollTimer = null;
        }
        setInteractiveInput(false);
        applyFinishedStatus(data);
        requestTerminalSelectSync(terminalId);
        updateDeleteButton();
        updateStopButton();
      })
      .catch(function () {
        if (displayMode === "terminal" && currentTerminalId === terminalId && terminalPollTimer) {
          clearInterval(terminalPollTimer);
          terminalPollTimer = null;
        }
      });
  }

  function runScript() {
    if (!currentPath) {
      showToast("未打开文件，无法运行", "error");
      return;
    }

    saveBeforeRun()
      .then(function () {
        expandOutputPanel();
        switchToForegroundView();
        clearOutput();
        lastStdoutLen = 0;
        lastStderrLen = 0;
        const args = els.argsInput ? els.argsInput.value : "";
        const runtime = window.pyrunnerEnv ? window.pyrunnerEnv.getRuntime() : {};
        const py = runtime.python_path || "python3";
        addLine("$ " + py + " " + currentPath + (args ? " " + args : ""), "info");
        if (runtime.mode === "venv") addLine("# venv: " + runtime.venv_path, "info");

        setStatus("running", "运行中...");
        setForegroundRunning(true);
        setInteractiveInput(true);
        if (els.exitCodeDisplay) els.exitCodeDisplay.style.display = "none";

        const url = "/execute?path=" + encodeURIComponent(currentPath) +
          "&args=" + encodeURIComponent(args);

        return api(url);
      })
      .then(function (data) {
        if (!data) return;
        currentTaskId = data.task_id;
        displayMode = "foreground";
        pollTimer = setInterval(function () { pollTask(currentTaskId); }, 400);
        updateStopButton();
      })
      .catch(function (err) {
        addLine("启动失败: " + err.message, "error");
        setStatus("error", "失败");
        setForegroundRunning(false);
        currentTaskId = null;
      });
  }

  function runScriptBackground() {
    if (!currentPath) {
      showToast("未打开文件，无法运行", "error");
      return;
    }

    saveBeforeRun()
      .then(function () {
        const args = els.argsInput ? els.argsInput.value : "";
        return api("/terminals/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script_path: currentPath, args: args }),
        });
      })
      .then(function (term) {
        if (!term) return;
        showToast("已在后台启动: " + (term.title || term.id), "success");
        return refreshTerminalList(term.id).then(function () {
          switchToTerminalView(term.id);
        });
      })
      .catch(function (err) {
        showToast("后台启动失败: " + err.message, "error");
      });
  }

  function pollTask(taskId) {
    api("/task/" + taskId)
      .then(function (data) {
        const showUi = displayMode === "foreground" && currentTaskId === taskId;

        if (showUi) {
          if (data.stdout && data.stdout.length > lastStdoutLen) {
            appendStream(data.stdout.substring(lastStdoutLen));
            lastStdoutLen = data.stdout.length;
          }
          if (data.stderr && data.stderr.length > lastStderrLen) {
            appendStream(data.stderr.substring(lastStderrLen));
            lastStderrLen = data.stderr.length;
          }
          if (data.interactive || data.status === "running") {
            setInteractiveInput(true);
          }
        }

        if (data.status === "running" || data.status === "pending") {
          updateStopButton();
          return;
        }

        clearInterval(pollTimer);
        pollTimer = null;
        currentTaskId = null;
        setForegroundRunning(false);

        if (showUi) {
          setInteractiveInput(false);
          applyFinishedStatus(data);
        }
        updateStopButton();
      })
      .catch(function () {
        clearInterval(pollTimer);
        pollTimer = null;
        currentTaskId = null;
        setForegroundRunning(false);
        if (displayMode === "foreground") setStatus("error", "失败");
        updateStopButton();
      });
  }

  function stopScript() {
    if (displayMode === "terminal" && currentTerminalId && isViewedTerminalRunning()) {
      api("/terminals/" + currentTerminalId + "/stop", { method: "POST" })
        .then(function () {
          pollTerminal(currentTerminalId);
          refreshTerminalList(currentTerminalId);
        })
        .catch(function (err) {
          showToast("停止失败: " + err.message, "error");
        });
      return;
    }
    if (!currentTaskId) return;
    apiFetch("/task/" + currentTaskId + "/stop", { method: "POST" }).catch(function () { /* ignore */ });
  }

  function deleteCurrentTerminal() {
    if (!currentTerminalId) return;
    const id = currentTerminalId;
    api("/terminals/" + id, { method: "DELETE" })
      .then(function () {
        showToast("终端已删除", "success");
        if (terminalPollTimer) {
          clearInterval(terminalPollTimer);
          terminalPollTimer = null;
        }
        currentTerminalId = null;
        displayMode = "idle";
        clearOutput();
        setStatus("idle", "就绪");
        if (els.exitCodeDisplay) els.exitCodeDisplay.style.display = "none";
        setInteractiveInput(false);
        try { sessionStorage.removeItem("pyrunner_last_terminal"); } catch (e) { /* ignore */ }
        return refreshTerminalList("");
      })
      .catch(function (err) {
        showToast("删除失败: " + err.message, "error");
      });
  }

  function onTerminalSelectChange() {
    const val = els.terminalSelect ? els.terminalSelect.value : "";
    if (!val) switchToForegroundView();
    else switchToTerminalView(val);
  }

  function restoreTerminalView() {
    let last = "";
    try { last = sessionStorage.getItem("pyrunner_last_terminal") || ""; } catch (e) { /* ignore */ }
    if (last && terminalList.some(function (t) { return t.id === last; })) {
      switchToTerminalView(last);
      return;
    }
    const running = terminalList.find(function (t) { return t.status === "running"; });
    if (running) {
      switchToTerminalView(running.id);
    }
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
    if (els.btnRunBackground) els.btnRunBackground.addEventListener("click", runScriptBackground);
    if (els.btnStop) els.btnStop.addEventListener("click", stopScript);
    if (els.btnToggleOutput) els.btnToggleOutput.addEventListener("click", toggleOutputPanel);
    setupTerminalSelectInteraction();
    if (els.btnDeleteTerminal) els.btnDeleteTerminal.addEventListener("click", deleteCurrentTerminal);
    if (els.outputInputForm) {
      els.outputInputForm.addEventListener("submit", function (e) {
        e.preventDefault();
        submitOutputInput();
      });
    }
    setupResize();

    refreshTerminalList().then(restoreTerminalView);
    terminalListTimer = setInterval(function () {
      refreshTerminalList(displayMode === "terminal" ? currentTerminalId : undefined);
    }, 8000);

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
