(function (global) {
  "use strict";

  var FG = {
    30: "#4e4e4e", 31: "#cd3131", 32: "#608b4e", 33: "#d7ba7d",
    34: "#569cd6", 35: "#c586c0", 36: "#4ec9b0", 37: "#d4d4d4",
    90: "#808080", 91: "#f44747", 92: "#6a9955", 93: "#dcdcaa",
    94: "#9cdcfe", 95: "#d16969", 96: "#4ec9b0", 97: "#ffffff",
  };

  var BG = {
    40: "#1e1e1e", 41: "#5a1d1d", 42: "#1e3a1e", 43: "#3a3a1e",
    44: "#1e2a3a", 45: "#3a1e3a", 46: "#1e3a3a", 47: "#3a3a3a",
    100: "#666666", 101: "#cc0000", 102: "#008000", 103: "#808000",
    104: "#0000cc", 105: "#800080", 106: "#008080", 107: "#c0c0c0",
  };

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function color256(n) {
    n = Number(n);
    if (n < 8) return FG[30 + n] || "#d4d4d4";
    if (n < 16) return FG[90 + n - 8] || "#d4d4d4";
    if (n < 232) {
      n -= 16;
      var r = Math.floor(n / 36);
      var g = Math.floor((n % 36) / 6);
      var b = n % 6;
      var ramp = [0, 95, 135, 175, 215, 255];
      return "rgb(" + ramp[r] + "," + ramp[g] + "," + ramp[b] + ")";
    }
    var grey = 8 + (n - 232) * 10;
    return "rgb(" + grey + "," + grey + "," + grey + ")";
  }

  function stripControlSequences(text) {
    return String(text).replace(/\x1b\[[0-9?;]*[A-Za-z]/g, function (seq) {
      return seq.charAt(seq.length - 1) === "m" ? seq : "";
    }).replace(/\x9b[0-9?;]*[A-Za-z]/g, function (seq) {
      return seq.charAt(seq.length - 1) === "m" ? seq : "";
    });
  }

  function defaultStyles() {
    return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null };
  }

  function applySgr(styles, raw) {
    var codes = raw === "" ? [0] : raw.split(";").map(function (p) {
      return p === "" ? 0 : parseInt(p, 10);
    });
    for (var i = 0; i < codes.length; i++) {
      var c = codes[i];
      if (isNaN(c)) continue;
      if (c === 0) {
        styles.bold = false;
        styles.dim = false;
        styles.italic = false;
        styles.underline = false;
        styles.fg = null;
        styles.bg = null;
      } else if (c === 1) styles.bold = true;
      else if (c === 2) styles.dim = true;
      else if (c === 3) styles.italic = true;
      else if (c === 4) styles.underline = true;
      else if (c === 22) styles.bold = false;
      else if (c === 39) styles.fg = null;
      else if (c === 49) styles.bg = null;
      else if (FG[c]) styles.fg = FG[c];
      else if (BG[c]) styles.bg = BG[c];
      else if (c === 38 && codes[i + 1] === 5 && codes[i + 2] != null) {
        styles.fg = color256(codes[i + 2]);
        i += 2;
      } else if (c === 38 && codes[i + 1] === 2 && codes[i + 4] != null) {
        styles.fg = "rgb(" + codes[i + 2] + "," + codes[i + 3] + "," + codes[i + 4] + ")";
        i += 4;
      } else if (c === 48 && codes[i + 1] === 5 && codes[i + 2] != null) {
        styles.bg = color256(codes[i + 2]);
        i += 2;
      } else if (c === 48 && codes[i + 1] === 2 && codes[i + 4] != null) {
        styles.bg = "rgb(" + codes[i + 2] + "," + codes[i + 3] + "," + codes[i + 4] + ")";
        i += 4;
      }
    }
  }

  function stylesToCss(styles) {
    var parts = [];
    if (styles.bold) parts.push("font-weight:bold");
    if (styles.dim) parts.push("opacity:0.75");
    if (styles.italic) parts.push("font-style:italic");
    if (styles.underline) parts.push("text-decoration:underline");
    if (styles.fg) parts.push("color:" + styles.fg);
    if (styles.bg) parts.push("background:" + styles.bg);
    return parts.join(";");
  }

  function toHtml(text) {
    text = stripControlSequences(text);
    var re = /\x1b\[([0-9;]*)m|\x9b([0-9;]*)m/g;
    var html = "";
    var styles = defaultStyles();
    var css = "";
    var last = 0;
    var match;

    function flush(end) {
      if (end <= last) return;
      var chunk = escapeHtml(text.slice(last, end));
      html += css ? '<span style="' + css + '">' + chunk + "</span>" : chunk;
      last = end;
    }

    while ((match = re.exec(text)) !== null) {
      flush(match.index);
      applySgr(styles, match[1] != null ? match[1] : match[2]);
      css = stylesToCss(styles);
      last = match.index + match[0].length;
    }
    flush(text.length);
    return html;
  }

  global.pyrunnerAnsi = { toHtml: toHtml, escapeHtml: escapeHtml };
})(window);
