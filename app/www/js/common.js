(function (global) {
  "use strict";

  var PATH_KEYS = ["path", "filepath", "filePath", "file", "src"];

  function getAppBase() {
    var p = global.location.pathname || "/";
    if (p.endsWith("/index.html")) {
      p = p.slice(0, -"/index.html".length);
    }
    if (!p.endsWith("/")) {
      p += "/";
    }
    return p;
  }

  function parseParamsFromString(str) {
    if (!str) return new URLSearchParams();
    var s = str.replace(/^#/, "");
    if (s.startsWith("/?")) s = s.slice(2);
    else if (s.startsWith("?")) s = s.slice(1);
    else if (s.startsWith("/") && s.indexOf("=") !== -1) s = s.slice(1);
    return new URLSearchParams(s);
  }

  function pickPath(params) {
    for (var i = 0; i < PATH_KEYS.length; i++) {
      var value = params.get(PATH_KEYS[i]);
      if (value) {
        try {
          return decodeURIComponent(value);
        } catch (e) {
          return value;
        }
      }
    }
    return "";
  }

  function normalizeFilePath(path) {
    if (!path) return "";
    path = String(path).trim();
    if (!path) return "";
    if (!path.startsWith("/")) path = "/" + path;
    return path;
  }

  function readPathFromUrl(urlLike) {
    try {
      var url = typeof urlLike === "string"
        ? new URL(urlLike, global.location.origin)
        : urlLike;
      var path = pickPath(url.searchParams);
      if (path) return normalizeFilePath(path);
      if (url.hash) {
        path = pickPath(parseParamsFromString(url.hash));
        if (path) return normalizeFilePath(path);
      }
    } catch (e) { /* ignore */ }
    return "";
  }

  function resolveFilePath() {
    var path = readPathFromUrl(global.location.href);
    if (path) return path;

    try {
      var frame = global.frameElement;
      if (frame && frame.src) {
        path = readPathFromUrl(frame.src);
        if (path) return path;
      }
    } catch (e) { /* ignore */ }

    var wins = [global.parent, global.top];
    for (var i = 0; i < wins.length; i++) {
      try {
        var win = wins[i];
        if (!win || win === global) continue;
        path = readPathFromUrl(win.location.href);
        if (path) return path;
      } catch (e) { /* cross-origin */ }
    }

    return "";
  }

  function extractPathFromMessage(data) {
    if (!data) return "";
    if (typeof data === "string") {
      if (data.startsWith("/")) return normalizeFilePath(data);
      return "";
    }
    if (typeof data !== "object") return "";

    var path = data.path || data.filePath || data.filepath || data.file || data.src;
    if (path) return normalizeFilePath(path);

    if (data.payload && typeof data.payload === "object") {
      path = data.payload.path || data.payload.filePath || data.payload.filepath;
      if (path) return normalizeFilePath(path);
    }

    var type = String(data.type || data.action || "");
    if (/open|file|load/i.test(type)) {
      path = data.path || data.filePath;
      if (path) return normalizeFilePath(path);
    }

    return "";
  }

  function apiFetch(apiPath, options) {
    var base = getAppBase();
    var path = String(apiPath || "").replace(/^\//, "");
    if (!path.startsWith("api/")) {
      path = "api/" + path;
    }
    return fetch(base + path, options);
  }

  var listeners = [];
  var lastResolvedPath = "";

  function notifyPathChange(path) {
    path = normalizeFilePath(path);
    if (!path || path === lastResolvedPath) return;
    lastResolvedPath = path;
    listeners.forEach(function (fn) {
      try { fn(path); } catch (e) { /* ignore */ }
    });
  }

  function watchFilePath(callback) {
    listeners.push(callback);

    var initial = resolveFilePath();
    if (initial) {
      lastResolvedPath = initial;
      callback(initial);
    }

    global.addEventListener("message", function (event) {
      var path = extractPathFromMessage(event.data);
      if (path) notifyPathChange(path);
    });

    global.addEventListener("hashchange", function () {
      var path = resolveFilePath();
      if (path) notifyPathChange(path);
    });

    global.addEventListener("popstate", function () {
      var path = resolveFilePath();
      if (path) notifyPathChange(path);
    });

    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      var path = resolveFilePath();
      if (path) notifyPathChange(path);
      if (attempts >= 30 || (lastResolvedPath && attempts > 5)) {
        clearInterval(timer);
      }
    }, 250);
  }

  global.pyrunnerCommon = {
    getAppBase: getAppBase,
    resolveFilePath: resolveFilePath,
    apiFetch: apiFetch,
    watchFilePath: watchFilePath,
  };
})(window);
