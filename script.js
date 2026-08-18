(function () {
  "use strict";

  /* =========================================================
   * TempMal.com — client application
   * Real Mail.tm API integration, no fake data.
   * ========================================================= */

  var POLL_INTERVAL = 15000;
  var STORAGE_SESSION = "tempmal-session";
  var STORAGE_THEME = "tempmal-theme";
  var API_BASE = "https://api.mail.tm";

  /* ---------------- Application state ---------------- */
  var state = {
    email: null,
    accountId: null,
    token: null,
    password: null,
    messages: [],
    totalItems: 0,
    selectedMessage: null,
    loading: false,
    error: null,
    connection: "idle", // idle | connecting | active | offline | error
    realtime: false,
    busyActions: {}
  };

  var listenerTimer = null;
  var listenerActive = false;
  var requestSeq = 0;
  var apiBaseReady = null;

  /* ---------------- API base detection ----------------
   * Prefer a same-origin relay (`/api/...`) which the included
   * `server.js` provides, because Mail.tm currently restricts browser
   * CORS to its own origin only. If no relay is present (e.g. opened
   * from file:// or a static host without the relay), fall back to
   * calling Mail.tm directly (best effort).
   */
  function detectApiBase() {
    if (apiBaseReady !== null) return apiBaseReady;
    apiBaseReady = new Promise(function (resolve) {
      if (window.location.protocol === "file:") {
        resolve("https://api.mail.tm");
        return;
      }
      fetch("/api/health", { cache: "no-store" }).then(function (r) {
        resolve(r.ok ? "/api" : "https://api.mail.tm");
      }).catch(function () {
        resolve("https://api.mail.tm");
      });
    });
    return apiBaseReady;
  }

  function apiUrl(path) {
    return API_BASE + path;
  }

  /* =========================================================
   * API layer (kept separate from UI)
   * ========================================================= */

  function httpStatusText(status) {
    if (status === 400) return "Invalid request. Please try again.";
    if (status === 401) return "Your temporary mailbox session is no longer valid.";
    if (status === 404) return "The requested mailbox or email could not be found.";
    if (status === 422) return "This email address could not be created. Please try again.";
    if (status === 429) return "Too many requests. Please wait a moment and try again.";
    return "Temporary email service is currently unavailable. Please try again later.";
  }

  function apiRequest(path, options) {
    options = options || {};
    var headers = { "Accept": "application/ld+json" };
    var body = options.body;
    if (body && typeof body === "object") {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    if (options.token) headers["Authorization"] = "Bearer " + options.token;

    return detectApiBase().then(function (base) {
      API_BASE = base;
      return fetch(base + path, {
        method: options.method || "GET",
        headers: headers,
        body: body
      });
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try { data = JSON.parse(text); } catch (e) { data = null; }
        }
        if (!res.ok) {
          var err = new Error(httpStatusText(res.status));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  function getDomains() {
    return apiRequest("/domains?page=1").then(function (data) {
      var members = (data && data["hydra:member"]) || [];
      var active = members.filter(function (d) { return d.isActive === true; });
      if (active.length === 0) {
        // domains endpoint is paginated — walk pages if the first has none active
        var total = (data && data["hydra:totalItems"]) || 0;
        var pages = Math.ceil(total / 30);
        var chain = Promise.resolve([]);
        for (var p = 2; p <= pages; p++) {
          chain = chain.then(function (acc) {
            return apiRequest("/domains?page=" + p).then(function (d2) {
              var act = ((d2 && d2["hydra:member"]) || []).filter(function (x) { return x.isActive === true; });
              if (act.length > 0) throw { __found: act };
              return acc;
            });
          });
        }
        return chain.then(function () { return null; }, function (err) {
          if (err && err.__found) return err.__found;
          throw err;
        });
      }
      return active;
    });
  }

  function createAccount(address, password) {
    return apiRequest("/accounts", { method: "POST", body: { address: address, password: password } });
  }

  function getToken(address, password) {
    return apiRequest("/token", { method: "POST", body: { address: address, password: password } });
  }

  function getCurrentAccount(token) {
    return apiRequest("/me", { token: token });
  }

  function getMessages(token, page) {
    return apiRequest("/messages?page=" + (page || 1), { token: token });
  }

  function getMessage(token, id) {
    return apiRequest("/messages/" + encodeURIComponent(id), { token: token });
  }

  function markMessageAsRead(token, id) {
    return apiRequest("/messages/" + encodeURIComponent(id), {
      method: "PATCH",
      token: token,
      body: { seen: true }
    });
  }

  function deleteMessage(token, id) {
    return apiRequest("/messages/" + encodeURIComponent(id), { method: "DELETE", token: token });
  }

  function deleteAccount(token, id) {
    return apiRequest("/accounts/" + encodeURIComponent(id), { method: "DELETE", token: token });
  }

  function generateAddress(domain) {
    var name = "";
    var alphabet = "abcdefghijklmnopqrstuvwxyz";
    var i;
    for (i = 0; i < 8; i++) name += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    name += Math.floor(Math.random() * 9000 + 1000);
    return name + "@" + domain;
  }

  function generatePassword() {
    var bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) {
      return "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789".charAt(b % 56);
    }).join("");
  }

  function createNewMailbox() {
    return getDomains().then(function (domains) {
      if (!domains || domains.length === 0) {
        var e = new Error("No active temporary email domains available.");
        e.status = 0;
        throw e;
      }
      var address = generateAddress(domains[0].domain);
      var password = generatePassword();
      return createAccount(address, password).then(function (account) {
        return getToken(address, password).then(function (tokenData) {
          return {
            account: account,
            token: tokenData.token,
            address: address,
            password: password
          };
        });
      });
    });
  }

  /* ---------------- Session persistence ---------------- */

  function saveSession() {
    if (!state.token || !state.accountId || !state.email) return;
    try {
      localStorage.setItem(STORAGE_SESSION, JSON.stringify({
        token: state.token,
        accountId: state.accountId,
        email: state.email
      }));
    } catch (e) { /* storage unavailable */ }
  }

  function loadSession() {
    try {
      var raw = localStorage.getItem(STORAGE_SESSION);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || !s.token || !s.accountId || !s.email) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function clearSession() {
    try { localStorage.removeItem(STORAGE_SESSION); } catch (e) { /* ignore */ }
  }

  /* =========================================================
   * HTML sanitization (received email content is untrusted)
   * ========================================================= */

  var ALLOWED_TAGS = new Set([
    "A", "P", "BR", "B", "STRONG", "I", "EM", "U", "S", "DEL", "STRIKE",
    "UL", "OL", "LI", "BLOCKQUOTE", "CODE", "PRE", "H1", "H2", "H3", "H4", "H5", "H6",
    "DIV", "SPAN", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION",
    "IMG", "HR", "SUB", "SUP", "SMALL", "DL", "DT", "DD"
  ]);
  var DANGEROUS_TAGS = new Set([
    "SCRIPT", "STYLE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "FORM",
    "INPUT", "BUTTON", "SELECT", "TEXTAREA", "LINK", "META", "SVG", "MATH", "TEMPLATE",
    "VIDEO", "AUDIO", "BASE", "NOSCRIPT", "APPLET"
  ]);
  var ALLOWED_ATTRS = {
    A: ["href", "title", "target", "rel"],
    IMG: ["src", "alt", "title", "width", "height"]
  };

  function isSafeUrl(name, value) {
    var v = String(value).trim().toLowerCase();
    if (v === "" ) return false;
    if (v.indexOf("javascript:") === 0 || v.indexOf("vbscript:") === 0 || v.indexOf("data:") === 0) return false;
    if (v.indexOf("http://") === 0 || v.indexOf("https://") === 0) return true;
    if (name === "href" && v.indexOf("mailto:") === 0) return true;
    return false;
  }

  function sanitizeHtml(html) {
    if (!html) return "";
    var doc;
    try {
      doc = new DOMParser().parseFromString(String(html), "text/html");
    } catch (e) {
      return "";
    }
    var root = doc.body || doc.documentElement;
    function clean(node, isRoot) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        var tag = node.tagName.toUpperCase();
        if (DANGEROUS_TAGS.has(tag) && !isRoot) {
          node.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tag) && !isRoot) {
          var parent = node.parentNode;
          if (!parent) { node.remove(); return; }
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          node.remove();
          return;
        }
        var allowed = ALLOWED_ATTRS[tag] || [];
        Array.prototype.slice.call(node.attributes).forEach(function (attr) {
          var name = attr.name.toLowerCase();
          if (name.indexOf("on") === 0 || name === "style" || name === "srcdoc" ||
              name === "formaction" || name === "xmlns" || name === "autofocus") {
            node.removeAttribute(attr.name);
            return;
          }
          if (allowed.indexOf(name) === -1) {
            node.removeAttribute(attr.name);
            return;
          }
          if (name === "href" || name === "src") {
            if (!isSafeUrl(name, attr.value)) node.removeAttribute(attr.name);
          }
        });
        if (tag === "A") {
          node.setAttribute("rel", "noopener noreferrer nofollow");
          node.setAttribute("target", "_blank");
        }
        if (tag === "IMG") {
          node.setAttribute("loading", "lazy");
        }
      }
      Array.prototype.slice.call(node.childNodes).forEach(function (child) { clean(child, false); });
    }
    clean(root, true);
    return root.innerHTML;
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* =========================================================
   * Utilities
   * ========================================================= */

  function $(id) { return document.getElementById(id); }

  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function formatSize(bytes) {
    if (bytes == null) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  function getSenderInfo(from) {
    if (!from) return { name: "Unknown", email: "" };
    if (typeof from === "string") return { name: from, email: from };
    return { name: from.name || from.address || "", email: from.address || "" };
  }

  function getRecipientInfo(to) {
    if (!to) return "Unknown";
    if (typeof to === "string") return to;
    if (Array.isArray(to)) {
      return to.map(function (t) {
        if (typeof t === "string") return t;
        return t.name ? (t.name + " <" + t.address + ">") : t.address;
      }).join(", ");
    }
    return to.name ? (to.name + " <" + to.address + ">") : to.address;
  }

  function initials(name, email) {
    var source = (name || email || "?");
    var parts = source.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  /* =========================================================
   * Toast notifications
   * ========================================================= */

  function toast(message, type) {
    var region = $("toastRegion");
    var el = document.createElement("div");
    el.className = "toast " + (type || "info");
    var icon = "";
    if (type === "success") {
      icon = '<svg class="toast-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
    } else if (type === "error") {
      icon = '<svg class="toast-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>';
    } else {
      icon = '<svg class="toast-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>';
    }
    el.innerHTML = icon + '<span class="toast-msg">' + escapeHtml(message) + "</span>";
    region.appendChild(el);
    setTimeout(function () {
      el.classList.add("toast-out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, 3400);
  }

  /* =========================================================
   * Theme
   * ========================================================= */

  function applyTheme(pref) {
    var theme = pref || "light";
    if (theme === "system") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", theme);
  }

  function getThemePref() {
    try { return localStorage.getItem(STORAGE_THEME) || "system"; } catch (e) { return "system"; }
  }

  function setThemePref(pref) {
    try { localStorage.setItem(STORAGE_THEME, pref); } catch (e) { /* ignore */ }
  }

  /* =========================================================
   * Connection status UI
   * ========================================================= */

  function setStatus(text, className) {
    $("mailStatusText").textContent = text;
    $("mailStatus").className = "mail-status" + (className ? " " + className : "");
  }

  function setLoading(key, on) {
    if (on) state.busyActions[key] = true;
    else delete state.busyActions[key];
    var busy = Object.keys(state.busyActions).length > 0;
    var card = $("tempMailCard");
    card.classList.toggle("busy", busy);
    $("copyBtn").disabled = busy || !state.token;
    $("refreshBtn").disabled = busy || !state.token;
    $("deleteBtn").disabled = busy || !state.token;
  }

  /* =========================================================
   * Clipboard
   * ========================================================= */

  function copyText(text, fallbackMessage) {
    function fallback() {
      toast(fallbackMessage || "Please copy the email address manually.", "info");
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fallback();
      return Promise.resolve(false);
    }
    return navigator.clipboard.writeText(text).then(function () {
      return true;
    }).catch(function () {
      fallback();
      return false;
    });
  }

  function copyEmailButton() {
    if (!state.email) return;
    copyText(state.email, "Please copy the email address manually.").then(function (ok) {
      if (ok) {
        var btn = $("copyBtn");
        var old = btn.innerHTML;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>Copied!';
        toast("Email copied!", "success");
        setTimeout(function () { btn.innerHTML = old; }, 1600);
      }
    });
  }

  /* =========================================================
   * Inbox rendering
   * ========================================================= */

  function renderInbox() {
    var list = $("messageList");
    var empty = $("inboxEmpty");
    $("msgCount").textContent = state.totalItems + (state.totalItems === 1 ? " message" : " messages");
    $("refreshTime").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    if (state.messages.length === 0) {
      list.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.hidden = false;
    list.innerHTML = "";

    state.messages.forEach(function (m) {
      var sender = getSenderInfo(m.from);
      var li = document.createElement("li");
      var unread = !m.seen;
      var attachIcon = m.hasAttachments
        ? '<span class="msg-attachment" title="Has attachments"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></span>'
        : "";

      li.innerHTML =
        '<button type="button" class="message-item' + (unread ? " unread" : "") + '" data-id="' + escapeHtml(m.id) + '" aria-label="' +
        (unread ? "Unread" : "Read") + " email from " + escapeHtml(sender.name || sender.email) + ': ' + escapeHtml(m.subject || "(no subject)") + '">' +
          '<span class="msg-avatar" aria-hidden="true">' + escapeHtml(initials(sender.name, sender.email)) + "</span>" +
          '<span class="msg-main">' +
            '<span class="msg-sender">' + escapeHtml(sender.name || sender.email) +
              (sender.email && sender.name ? " <small>" + escapeHtml(sender.email) + "</small>" : "") +
              (unread ? '<span class="msg-unread-dot" aria-hidden="true"></span>' : "") +
            "</span>" +
            '<span class="msg-subject">' + escapeHtml(m.subject || "(no subject)") + "</span>" +
            '<span class="msg-preview">' + escapeHtml(m.intro || "") + "</span>" +
          "</span>" +
          '<span class="msg-meta">' +
            '<span class="msg-date">' + escapeHtml(formatDate(m.createdAt)) + "</span>" +
            attachIcon +
          "</span>" +
        "</button>";
      list.appendChild(li);
    });
  }

  /* =========================================================
   * Message reader
   * ========================================================= */

  function renderReaderHtml(m) {
    var sender = getSenderInfo(m.from);
    var html = m.html;
    var sanitized = "";
    if (html) sanitized = sanitizeHtml(html);
    var textPart = m.text || "";
    var body = "";
    if (sanitized && sanitized.replace(/<[^>]+>/g, "").trim()) {
      body = sanitized;
    } else if (textPart) {
      body = "<p>" + escapeHtml(textPart).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>") + "</p>";
    } else {
      body = "<p>No content in this email.</p>";
    }

    var att = "";
    var attachments = m.attachments || [];
    if (attachments.length > 0) {
      att = '<div class="attachments"><p class="attachments-title">Attachments (' + attachments.length + ")</p>";
      att += attachments.map(function (a) {
        var aUrl = a.downloadUrl || (API_BASE + "/messages/" + encodeURIComponent(m.id) + "/attachment/" + encodeURIComponent(a.id));
        return '<div class="attachment-item">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
          '<span class="attachment-info">' +
            '<span class="attachment-name">' + escapeHtml(a.filename || "Attachment") + "</span>" +
            '<span class="attachment-size">' + escapeHtml(a.contentType || "File") + (a.size != null ? " · " + formatSize(a.size) : "") + "</span>" +
          "</span>" +
          '<button type="button" class="btn btn-secondary btn-sm attachment-open" data-url="' + escapeHtml(aUrl) + '">Open</button>' +
        "</div>";
      }).join("");
      att += "</div>";
    }

    return '<div class="reader-header">' +
        '<div class="reader-sender">' +
          '<span class="msg-avatar" aria-hidden="true">' + escapeHtml(initials(sender.name, sender.email)) + "</span>" +
          "<div><div style=\"font-weight:700\">" + escapeHtml(sender.name || sender.email) + "</div>" +
          (sender.email ? '<div class="reader-meta">' + escapeHtml(sender.email) + "</div>" : "") + "</div>" +
        "</div>" +
        '<h2 class="reader-title" id="readerSubject">' + escapeHtml(m.subject || "(no subject)") + "</h2>" +
        '<div class="reader-meta">' +
          "<div><strong>From:</strong> " + escapeHtml(sender.name ? sender.name + " <" + sender.email + ">" : sender.email) + "</div>" +
          "<div><strong>To:</strong> " + escapeHtml(getRecipientInfo(m.to)) + "</div>" +
          '<div><strong>Date:</strong> ' + escapeHtml(formatDate(m.createdAt)) + "</div>" +
        "</div>" +
      "</div>" +
      '<div class="reader-body">' + body + "</div>" +
      att;
  }

  function openMessage(id) {
    if (!state.token) return;
    var modal = $("readerModal");
    var bodyEl = $("readerContent");
    bodyEl.innerHTML = '<div class="reader-loading" id="readerLoading">Opening email…</div>';
    openModal(modal);
    setLoading("open", true);
    getMessage(state.token, id).then(function (full) {
      if (!full || !full.id) throw new Error("Message not found");
      state.selectedMessage = full;
      bodyEl.innerHTML = renderReaderHtml(full);
      setLoading("open", false);
      var wasUnread = !full.seen;
      if (wasUnread) {
        markMessageAsRead(state.token, id).then(function () {
          var msg = state.messages.find(function (m) { return m.id === id; });
          if (msg) msg.seen = true;
          renderInbox();
        }).catch(function () {
          toast("Unable to update message status.", "error");
        });
      }
    }).catch(function (err) {
      setLoading("open", false);
      closeModal(modal);
      handleApiError(err);
    });
  }

  function openAttachment(url, filename) {
    if (!state.token) return;
    setLoading("attach", true);
    fetch(url, { headers: { "Authorization": "Bearer " + state.token } })
      .then(function (r) {
        if (!r.ok) throw new Error(httpStatusText(r.status));
        return r.blob();
      })
      .then(function (blob) {
        var objUrl = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = objUrl;
        a.download = filename || "attachment";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(objUrl); }, 60000);
        setLoading("attach", false);
      })
      .catch(function () {
        setLoading("attach", false);
        toast("Unable to open attachment", "error");
      });
  }

  function closeReader() {
    closeModal($("readerModal"));
    state.selectedMessage = null;
  }

  /* =========================================================
   * Inbox refresh (polling)
   * ========================================================= */

  function refreshInbox(opts) {
    opts = opts || {};
    if (!state.token) return Promise.resolve(false);
    var seq = ++requestSeq;
    setLoading("refresh", true);
    return getMessages(state.token, 1).then(function (data) {
      if (seq < requestSeq) { setLoading("refresh", false); return false; } // stale response
      var messages = (data && data["hydra:member"]) || [];
      var total = (data && data["hydra:totalItems"]) || messages.length;

      var currentIds = state.messages.map(function (m) { return m.id; });
      var newIds = messages.map(function (m) { return m.id; });
      var freshCount = newIds.filter(function (id) { return currentIds.indexOf(id) === -1; }).length;
      var wasEmpty = state.messages.length === 0;

      state.messages = messages;
      state.totalItems = total;
      state.connection = "active";
      setStatus("Active", "active");

      if (opts.silent !== true && freshCount > 0) {
        toast(freshCount + (freshCount === 1 ? " new email received" : " new emails received"), "success");
      } else if (opts.toast && freshCount === 0 && !wasEmpty) {
        toast("Inbox refreshed", "success");
      }
      renderInbox();
      setLoading("refresh", false);
      return true;
    }).catch(function (err) {
      if (seq < requestSeq) { setLoading("refresh", false); return false; }
      setLoading("refresh", false);
      if (err.status === 401) {
        handleSessionExpired();
      } else if (err.status === 429) {
        state.connection = "error";
        setStatus("Rate limited", "error");
        toast(httpStatusText(429), "error");
        backoffListener();
      } else {
        state.connection = "error";
        setStatus("Error", "error");
        if (!opts.silent) toast("Unable to load inbox", "error");
      }
      return false;
    });
  }

  function handleApiError(err) {
    if (err && err.status === 401) {
      handleSessionExpired();
    } else if (err && err.status === 429) {
      toast(httpStatusText(429), "error");
    } else {
      toast(err && err.message ? err.message : httpStatusText(0), "error");
    }
  }

  /* =========================================================
   * Real-time listener (conservative polling; Mail.tm has no
   * reliable SSE endpoint available)
   * ========================================================= */

  function startRealtimeListener() {
    stopRealtimeListener();
    if (!state.token) return;
    listenerActive = true;
    listenerTimer = setInterval(function () {
      if (document.hidden) return;
      refreshInbox({ silent: true });
    }, POLL_INTERVAL);
  }

  function stopRealtimeListener() {
    if (listenerTimer) { clearInterval(listenerTimer); listenerTimer = null; }
    listenerActive = false;
  }

  function backoffListener() {
    stopRealtimeListener();
    setTimeout(function () {
      if (state.token && !listenerActive) startRealtimeListener();
    }, POLL_INTERVAL * 3);
  }

  function onVisibilityChange() {
    if (document.hidden) {
      // pause polling while hidden
      if (listenerTimer) { clearInterval(listenerTimer); listenerTimer = null; }
    } else if (state.token && !listenerTimer) {
      refreshInbox({ silent: true }).then(function () {
        listenerTimer = setInterval(function () {
          if (document.hidden) return;
          refreshInbox({ silent: true });
        }, POLL_INTERVAL);
      });
    }
  }

  /* =========================================================
   * Mailbox lifecycle
   * ========================================================= */

  function adoptMailbox(info) {
    stopRealtimeListener();
    state.email = info.address;
    state.accountId = info.account.id;
    state.token = info.token;
    state.password = info.password || null;
    state.messages = [];
    state.totalItems = 0;
    state.selectedMessage = null;
    state.connection = "active";

    $("mailAddress").textContent = state.email;
    $("mailAddressBox").setAttribute("aria-label", "Temporary email: " + state.email);
    setStatus("Active", "active");
    saveSession();
    renderInbox();
    startRealtimeListener();
    toast("New email created", "success");
  }

  function createMailboxFlow() {
    state.connection = "connecting";
    setStatus("Connecting...", "connecting");
    $("mailAddress").textContent = "Creating your temporary email...";
    $("mailAddress").classList.add("busy");
    setLoading("create", true);

    createNewMailbox().then(function (info) {
      $("mailAddress").classList.remove("busy");
      adoptMailbox(info);
      setLoading("create", false);
    }).catch(function (err) {
      $("mailAddress").classList.remove("busy");
      setLoading("create", false);
      state.connection = "error";
      setStatus("Error", "error");
      if (err && err.status === 429) {
        toast(httpStatusText(429), "error");
        setTimeout(function () { createMailboxFlow(); }, 12000);
      } else if (err && err.status === 422) {
        toast("This email address could not be created. Please try again.", "error");
      } else {
        toast("Unable to create email", "error");
      }
    });
  }

  function handleSessionExpired() {
    stopRealtimeListener();
    clearSession();
    state.token = null;
    state.accountId = null;
    state.email = null;
    state.messages = [];
    state.totalItems = 0;
    state.connection = "error";
    setStatus("Offline", "offline");
    toast("Your temporary mailbox session is no longer valid.", "error");
    renderInbox();
    setTimeout(createMailboxFlow, 600);
  }

  function attemptSessionRestore() {
    var session = loadSession();
    if (!session) {
      createMailboxFlow();
      return;
    }
    setStatus("Connecting...", "connecting");
    getCurrentAccount(session.token).then(function (me) {
      if (!me || me.isDeleted === true) throw new Error("deleted");
      state.email = me.address || session.email;
      state.accountId = session.accountId;
      state.token = session.token;
      state.messages = [];
      state.totalItems = 0;
      $("mailAddress").textContent = state.email;
      setStatus("Active", "active");
      saveSession();
      renderInbox();
      startRealtimeListener();
      refreshInbox({ silent: true }).catch(function () {});
    }).catch(function () {
      // saved session invalid — replace with a new mailbox
      clearSession();
      createMailboxFlow();
    });
  }

  function deleteCurrentMailbox(createNext) {
    if (!state.token || !state.accountId) return Promise.resolve(false);
    var token = state.token;
    var id = state.accountId;
    return deleteAccount(token, id).then(function () {
      stopRealtimeListener();
      clearSession();
      state.email = null;
      state.accountId = null;
      state.token = null;
      state.password = null;
      state.messages = [];
      state.totalItems = 0;
      $("mailAddress").textContent = "Your temporary mailbox has been deleted.";
      setStatus("Offline", "offline");
      renderInbox();
      toast("Mailbox deleted", "success");
      if (createNext) createMailboxFlow();
      return true;
    }).catch(function (err) {
      handleApiError(err);
      return false;
    });
  }

  function openConfirmNewEmail() {
    var chk = $("deleteOldChk");
    chk.checked = false;
    $("deleteOldRow").hidden = !state.token;
    openModal($("confirmModal"));
  }

  function doCreateNewEmail() {
    closeModal($("confirmModal"));
    stopRealtimeListener();
    setLoading("create", true);
    var oldToken = state.token;
    var oldId = state.accountId;
    var deleteOld = $("deleteOldChk").checked && !!oldToken;

    var deletion = deleteOld ? deleteAccount(oldToken, oldId) : Promise.resolve(null);

    deletion.then(function () {
      if (deleteOld) {
        clearSession();
        state.email = null;
        state.accountId = null;
        state.token = null;
        state.messages = [];
        state.totalItems = 0;
      }
      return createMailboxFlow();
    }).catch(function () {
      setLoading("create", false);
      toast("Unable to create email", "error");
    });
  }

  /* =========================================================
   * Modals
   * ========================================================= */

  function openModal(el) { el.hidden = false; }
  function closeModal(el) { el.hidden = true; }

  function trapFocus(modalEl) {
    var focusables = modalEl.querySelectorAll("button, [href], input, [tabindex]:not([tabindex='-1'])");
    if (focusables.length === 0) return;
    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    modalEl.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  function focusModal(modalEl, initial) {
    (initial || modalEl.querySelector("button, [href], input")).focus();
  }

  function openReaderModalWithFocus() {
    openModal($("readerModal"));
    trapFocus($("readerModal"));
    focusModal($("readerModal"), $("readerBack"));
  }

  /* =========================================================
   * FAQ accordion
   * ========================================================= */

  function setupFaq() {
    var items = document.querySelectorAll(".faq-item");
    items.forEach(function (item) {
      var q = item.querySelector(".faq-q");
      var a = item.querySelector(".faq-a");
      q.addEventListener("click", function () {
        var expanded = q.getAttribute("aria-expanded") === "true";
        // close others for clean accordion behavior
        items.forEach(function (other) {
          if (other === item) return;
          other.querySelector(".faq-q").setAttribute("aria-expanded", "false");
          other.querySelector(".faq-a").style.maxHeight = "0px";
        });
        q.setAttribute("aria-expanded", String(!expanded));
        a.style.maxHeight = expanded ? "0px" : a.scrollHeight + "px";
      });
    });
  }

  /* =========================================================
   * Mobile menu
   * ========================================================= */

  function setupMobileMenu() {
    var toggle = $("menuToggle");
    var nav = $("mainNav");
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    nav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  /* =========================================================
   * Global keydown for Escape
   * ========================================================= */

  function setupEscape() {
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      [ $("readerModal"), $("confirmModal"), $("deleteModal") ].forEach(function (m) {
        if (m && !m.hidden) { m.hidden = true; }
      });
    });
  }

  /* =========================================================
   * Init
   * ========================================================= */

  function init() {
    applyTheme(getThemePref());
    setupFaq();
    setupMobileMenu();
    setupEscape();
    trapFocus($("readerModal"));
    trapFocus($("confirmModal"));
    trapFocus($("deleteModal"));

    $("themeToggle").addEventListener("click", function () {
      var current = document.documentElement.getAttribute("data-theme");
      var next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      setThemePref(next);
    });

    $("copyBtn").addEventListener("click", copyEmailButton);
    $("refreshBtn").addEventListener("click", function () {
      setLoading("manual", true);
      refreshInbox({ toast: true }).then(function () { setLoading("manual", false); });
    });
    $("emptyRefreshBtn").addEventListener("click", function () {
      setLoading("manual", true);
      refreshInbox({ toast: true }).then(function () { setLoading("manual", false); });
    });

    $("heroGenerateBtn").addEventListener("click", createMailboxFlow);
    $("navNewEmail").addEventListener("click", openConfirmNewEmail);
    $("newEmailBtn").addEventListener("click", openConfirmNewEmail);

    $("deleteBtn").addEventListener("click", function () { openModal($("deleteModal")); focusModal($("deleteModal"), $("deleteCancel")); });
    $("deleteCancel").addEventListener("click", function () { closeModal($("deleteModal")); });
    $("deleteClose").addEventListener("click", function () { closeModal($("deleteModal")); });
    $("deleteConfirm").addEventListener("click", function () {
      closeModal($("deleteModal"));
      setLoading("delete", true);
      deleteCurrentMailbox(false).then(function () { setLoading("delete", false); });
    });

    $("confirmCancel").addEventListener("click", function () { closeModal($("confirmModal")); });
    $("confirmClose").addEventListener("click", function () { closeModal($("confirmModal")); });
    $("confirmCreate").addEventListener("click", doCreateNewEmail);

    $("readerClose").addEventListener("click", closeReader);
    $("readerBack").addEventListener("click", closeReader);
    $("readerModal").addEventListener("click", function (e) {
      if (e.target === $("readerModal")) closeReader();
    });

    document.getElementById("inbox").addEventListener("click", function (e) {
      var item = e.target.closest(".message-item");
      if (item) {
        openReaderModalWithFocus();
        openMessage(item.getAttribute("data-id"));
      }
    });

    document.getElementById("readerContent").addEventListener("click", function (e) {
      var btn = e.target.closest(".attachment-open");
      if (btn) {
        e.preventDefault();
        openAttachment(btn.getAttribute("data-url"));
      }
    });

    document.querySelectorAll(".modal-backdrop").forEach(function (m) {
      m.addEventListener("click", function (e) {
        if (e.target === m) { m.hidden = true; }
      });
    });

    document.querySelectorAll('a[data-footer-link="terms"]').forEach(function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        toast("TempMal.com is provided as-is for temporary email use. See the Mail.tm terms: https://mail.tm/", "info");
      });
    });

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
        if (getThemePref() === "system") applyTheme("system");
      });
    }

    // Begin: restore or create a real mailbox
    attemptSessionRestore();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Guarded debug hook: only active when the page is loaded with ?debug=1
  if (window.location.search.indexOf("debug=1") !== -1) {
    window.__TEMPMAL__ = {
      sanitizeHtml: sanitizeHtml,
      escapeHtml: escapeHtml,
      renderReaderHtml: renderReaderHtml,
      getSenderInfo: getSenderInfo,
      ALLOWED_TAGS: ALLOWED_TAGS,
      DANGEROUS_TAGS: DANGEROUS_TAGS
    };
  }
})();
