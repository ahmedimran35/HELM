// HELM Apps SDK — `window.helmApp` for bundles served at /apps/:slug/.
//
// This script is injected into every app HTML by the bundle server
// (see backend/src/routes/apps-bundles.ts). It exposes a small API to
// the app:
//
//   window.helmApp.me             — { id, name, username, role } | null
//   window.helmApp.install        — { id, app_id, ... } | null
//   window.helmApp.theme          — "light" | "dark"
//   window.helmApp.ready          — Promise<void> resolves when me/install
//                                   are populated (or auth failed)
//   window.helmApp.callAPI(path, opts)
//   window.helmApp.data.get/set/del/list
//   window.helmApp.navigate(path)
//   window.helmApp.openPanel(panelId)
//   window.helmApp.toast({ ... })
//   window.helmApp.copy(text)
//
// Identity is fetched from /api/apps/bootstrap (the backend reads the
// session cookie). When the app is running inside an iframe hosted by
// HELM (via /apps-embed), the parent provides install info via
// postMessage("helm:context", { install, theme }) as a fallback.
//
// The SDK communicates with the HELM host via postMessage because the
// iframe runs WITHOUT `allow-same-origin` (opaque origin) — it cannot
// make direct same-origin fetch calls. All /api/* and app-data requests
// are proxied through the host.

(function () {
  "use strict";

  // -------- internal helpers ------------------------------------------------

  function qparam(name) {
    try {
      var p = new URLSearchParams(window.location.search);
      return p.get(name);
    } catch (_e) {
      return null;
    }
  }

  function cookie(name) {
    var jar = (document.cookie || "").split(";");
    for (var i = 0; i < jar.length; i++) {
      var kv = jar[i].trim().split("=");
      if (kv[0] === name) return decodeURIComponent(kv[1] || "");
    }
    return null;
  }

  function postParent(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, "*");
      }
    } catch (_e) {
      /* parent may be hostile — silently drop */
    }
  }

  // Request/response bridge for privileged API calls via postMessage.
  // The host (AppFrame) proxies requests and replies with
  // { type: "helm:api-response", id, status, body }.
  // Unpredictable request ids so a hostile same-origin page cannot race
  // a forged response against an in-flight request (the old
  // Date.now()+counter scheme was guessable).
  function newRequestId(prefix) {
    var u = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + (++apiRequestId));
    return prefix + "-" + u;
  }
  var apiRequestId = 0;
  var apiPromises = {};
  function callApiViaBridge(method, path, body) {
    return new Promise(function (resolve, reject) {
      var id = newRequestId("api");
      var timeout = setTimeout(function () {
        delete apiPromises[id];
        reject(new Error("api_bridge_timeout"));
      }, 30000);
      apiPromises[id] = { resolve: resolve, reject: reject, timeout: timeout };
      postParent({ type: "helm:api", id: id, method: method, path: path, body: body });
    });
  }

  function callAppDataViaBridge(op, key, value) {
    return new Promise(function (resolve, reject) {
      var id = newRequestId("appdata");
      var timeout = setTimeout(function () {
        delete apiPromises[id];
        reject(new Error("app_data_bridge_timeout"));
      }, 15000);
      apiPromises[id] = { resolve: resolve, reject: reject, timeout: timeout };
      postParent({ type: "helm:app-data", id: id, op: op, key: key, value: value });
    });
  }

  window.addEventListener("message", function (ev) {
    var data = ev.data;
    if (!data || typeof data !== "object") return;
    // Only accept bridge responses from the actual parent frame. The
    // iframe runs on an opaque origin (no allow-same-origin), so the
    // parent is the only legitimate responder; a response from any other
    // source is ignored.
    if (ev.source !== window.parent) return;
    // Response to our api/app-data bridge request.
    if (data.type === "helm:api-response" || data.type === "helm:app-data-response") {
      var promise = apiPromises[data.id];
      if (promise) {
        clearTimeout(promise.timeout);
        delete apiPromises[data.id];
        if (data.status >= 200 && data.status < 300) {
          promise.resolve(data.body);
        } else {
          var err = new Error(
            (data.body && data.body.error) || "request failed: " + data.status
          );
          err.status = data.status;
          err.body = data.body;
          promise.reject(err);
        }
      }
      return;
    }
    if (data.type === "helm:context") {
      parentReady = true;
      if (data.theme === "light" || data.theme === "dark") {
        parentTheme = data.theme;
        if (sdk.theme !== parentTheme) {
          sdk.theme = parentTheme;
          document.documentElement.setAttribute("data-theme", parentTheme);
        }
      }
      if (data.install && typeof data.install === "object") {
        parentInstall = data.install;
        if (!sdk.install) {
          sdk.install = parentInstall;
        }
      }
    } else if (data.type === "helm:install") {
      // Parent pushed an install ID after the initial load.
      if (data.install && typeof data.install === "object") {
        parentInstall = data.install;
        if (!sdk.install) sdk.install = parentInstall;
      }
    }
  });

  // Pick up an initial theme from the document before the bootstrap
  // resolves — apps often render their first paint before the network
  // round-trip finishes.
  function readLocalTheme() {
    var dt = document.documentElement.getAttribute("data-theme");
    if (dt === "light" || dt === "dark") return dt;
    try {
      var saved = window.localStorage.getItem("helm.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch (_e) {
      /* ignore */
    }
    return "dark";
  }

  // -------- the SDK object --------------------------------------------------

  var sdk = {
    brand: "HELM",
    version: "0.1.0",

    me: null,
    install: null,
    theme: readLocalTheme(),
    ready: null,

    // ----- API proxy ---------------------------------------------------------
    // Proxied through the HELM host via postMessage because the iframe
    // runs without `allow-same-origin` (opaque origin) and cannot make
    // direct same-origin fetch calls.

    callAPI: async function (path, opts) {
      opts = opts || {};
      // Accept "/panels", "panels", "/api/panels", or "api/panels" —
      // always end up with `/api/<rest>`.
      var p = String(path || "");
      if (p.charAt(0) === "/") p = p.slice(1);
      if (p.indexOf("api/") !== 0) p = "api/" + p;
      var method = (opts.method || "GET").toUpperCase();
      // Delegate to the host bridge.
      return callApiViaBridge(method, "/" + p, opts.body);
    },

    // ----- per-install persistent state --------------------------------------
    // Proxied through the HELM host via postMessage.

    data: {
      _ready: function () {
        if (!sdk.install || !sdk.install.id) {
          throw new Error("helmApp.data: no install context (missing ?install=…)");
        }
      },
      get: async function (key) {
        sdk.data._ready();
        return callAppDataViaBridge("get", key);
      },
      set: async function (key, value) {
        sdk.data._ready();
        return callAppDataViaBridge("set", key, value);
      },
      del: async function (key) {
        sdk.data._ready();
        return callAppDataViaBridge("del", key);
      },
      list: async function () {
        sdk.data._ready();
        return callAppDataViaBridge("list");
      },
    },

    // ----- HELM helpers ------------------------------------------------------

    navigate: function (path) {
      if (!path) return;
      // If we're embedded, ask the host to navigate so we don't lose
      // state. If we're standalone, change the top-level URL.
      if (window.parent && window.parent !== window) {
        postParent({ type: "helm:navigate", path: String(path) });
      } else {
        window.top.location.href = String(path);
      }
    },

    openPanel: function (panelId) {
      if (!panelId) return;
      sdk.navigate("/panels?focus=" + encodeURIComponent(String(panelId)));
    },

    toast: function (opts) {
      opts = opts || {};
      var payload = {
        type: "helm:toast",
        title: String(opts.title || ""),
        description: opts.description ? String(opts.description) : undefined,
        tone: ["info", "success", "warning"].indexOf(opts.tone) > -1
          ? opts.tone
          : "info",
        duration: typeof opts.duration === "number" ? opts.duration : 4000,
      };
      if (window.parent && window.parent !== window) {
        postParent(payload);
      } else {
        // No parent — emit a synthetic event so the page can listen.
        try {
          window.dispatchEvent(new CustomEvent("helm:toast", { detail: payload }));
        } catch (_e) {
          /* ignore */
        }
      }
    },

    copy: async function (text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(String(text));
        } else {
          // Fallback for environments without the async clipboard API.
          var ta = document.createElement("textarea");
          ta.value = String(text);
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        return true;
      } catch (_e) {
        return false;
      }
    },

    // ----- HELM domain helpers (panels, chat, users) -----------------------
    //
    // These wrap the generic callAPI() with typed shapes for the most
    // common HELM features an app wants to integrate with. They're
    // thin — just path conventions + a few client-side niceties — so
    // AI-generated apps can use them without knowing the raw API
    // surface. Apps that need something not covered here can still
    // call callAPI(path) directly.

    panels: {
      /** List panels the current user (or install target) is a member
       *  of. Returns an array of {id, name, member_count, message_count,
       *  agent_model_id, persona_id, created_at}. */
      list: function () {
        return sdk.callAPI("/panels", { method: "GET" });
      },
      /** Get a single panel's details. */
      get: function (panelId) {
        if (!panelId) return Promise.reject(new Error("panelId required"));
        return sdk.callAPI("/panels/" + encodeURIComponent(String(panelId)), { method: "GET" });
      },
      /** Get recent messages from a panel. opts: { limit, before }.
       *  Returns an array of {id, panel_id, user_id, sender_name,
       *  content, created_at}. */
      messages: function (panelId, opts) {
        if (!panelId) return Promise.reject(new Error("panelId required"));
        opts = opts || {};
        var qs = [];
        if (typeof opts.limit === "number") qs.push("limit=" + opts.limit);
        if (opts.before) qs.push("before=" + encodeURIComponent(String(opts.before)));
        var path = "/panels/" + encodeURIComponent(String(panelId)) + "/messages";
        if (qs.length) path += "?" + qs.join("&");
        return sdk.callAPI(path, { method: "GET" });
      },
    },

    chat: {
      /** Non-streaming chat completion. POSTs to /api/chat (which is
       *  actually an SSE endpoint), reads the stream, and reassembles
       *  the full reply. opts: { messages, system, model }. Returns
       *  { content, model }. The model is auto-resolved from
       *  helmApp.models.list() if not provided. */
      complete: async function (opts) {
        opts = opts || {};
        if (!Array.isArray(opts.messages) || !opts.messages.length) {
          throw new Error("messages array required");
        }
        var modelId = opts.model;
        if (!modelId) {
          try {
            var models = await sdk.callAPI("/models", { method: "GET" });
            if (Array.isArray(models) && models.length) {
              var first = models.find(function (m) { return m.state === "active"; }) || models[0];
              modelId = first && first.id;
            }
          } catch (_e) { /* fall through */ }
        }
        if (!modelId) {
          throw new Error("no model available — configure an AI provider + active model");
        }
        // /api/chat is an SSE endpoint, not JSON. Read it directly with
        // fetch so we can consume the stream and collect the tokens.
        var lastUserMsg = opts.messages[opts.messages.length - 1];
        var reqBody = JSON.stringify({
          model_id: modelId,
          content: lastUserMsg && lastUserMsg.content,
          system: opts.system,
        });
        var res = await fetch("/api/chat", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: reqBody,
        });
        if (!res.ok) {
          var errText = "";
          try { errText = await res.text(); } catch (_e) { /* ignore */ }
          throw new Error("chat failed: " + (res.status + " " + (errText || res.statusText)).trim());
        }
        // Walk the SSE stream, collecting every `token` event's delta.
        var assembled = "";
        var reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (reader) {
          var decoder = new TextDecoder();
          var buf = "";
          // eslint-disable-next-line no-constant-condition
          while (true) {
            var step = await reader.read();
            if (step.done) break;
            buf += decoder.decode(step.value, { stream: true });
            // SSE frames are separated by blank lines; events by lines
            // starting with "data: ". We split on newlines and pull
            // each event's data payload.
            var lines = buf.split("\n");
            buf = lines.pop(); // last partial line stays in the buffer
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              if (line.indexOf("data: ") !== 0) continue;
              var payload = line.slice(6).trim();
              if (!payload) continue;
              try {
                var obj = JSON.parse(payload);
                if (obj && typeof obj.delta === "string") assembled += obj.delta;
              } catch (_e) { /* ignore non-JSON lines */ }
            }
          }
        }
        return { content: assembled, model: modelId };
      },
    },

    users: {
      /** Search the user directory. Returns an array of
       *  {id, username, name, role, is_active}. */
      search: function (query) {
        var q = query ? String(query) : "";
        return sdk.callAPI("/users?q=" + encodeURIComponent(q), { method: "GET" });
      },
      /** Get the current user (equivalent to sdk.me but lazy). */
      me: function () {
        return sdk.callAPI("/me", { method: "GET" });
      },
    },

    models: {
      /** List models the current user can use. */
      list: function () {
        return sdk.callAPI("/models", { method: "GET" });
      },
    },

    // ----- internal helpers exposed for inspection ---------------------------

    _query: function () {
      return {
        install: qparam("install"),
        slug: qparam("slug"),
        theme: readLocalTheme(),
      };
    },
  };

  function safeParse(text) {
    try { return JSON.parse(text); } catch (_e) { return null; }
  }

  function httpError(status, body, text) {
    var msg = (body && body.error) || text || ("request failed: " + status);
    var err = new Error(msg);
    err.status = status;
    err.body = body;
    return err;
  }

  // -------- bootstrap -------------------------------------------------------

  // Resolve `install` from the URL, from a parent-provided message, or
  // from localStorage (set by the embed chrome on the way in).  We try
  // all three so the SDK works in both standalone and embedded modes.
  function resolveInstall() {
    var fromUrl = qparam("install");
    if (fromUrl) return { id: fromUrl };
    if (parentInstall) return parentInstall;
    try {
      var stored = window.localStorage.getItem("helm.lastInstall");
      if (stored) return { id: stored };
    } catch (_e) {
      /* ignore */
    }
    return null;
  }

  sdk.ready = (async function () {
    // 1. Pull install from URL/parent/localStorage so the SDK can guess
    //    the right bootstrap URL before the network call returns.
    var guessed = resolveInstall();
    if (guessed && guessed.id) sdk.install = guessed;

    // 2. Fetch identity (and authoritative install) from the backend.
    try {
      var url = "/api/apps/bootstrap";
      if (sdk.install && sdk.install.id) {
        url += "?install=" + encodeURIComponent(sdk.install.id);
      }
      var res = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        var body = await res.json();
        if (body && body.user) sdk.me = body.user;
        if (body && body.install) sdk.install = body.install;
        if (body && (body.theme === "light" || body.theme === "dark")) {
          sdk.theme = body.theme;
          document.documentElement.setAttribute("data-theme", sdk.theme);
        }
      } else {
        // 401 / 403 — not logged in. Leave `me` null so the app can
        // render its own "please sign in" state.
      }
    } catch (_e) {
      // Network failure — leave `me` null. The app can decide whether
      // to proceed anonymously or surface an error.
    }

    // 3. If a parent context arrives later, it can override theme/install.
    //    Nothing else to do here — the listener above handles updates.
    return null;
  })();

  // expose
  window.helmApp = sdk;

  // Notify the host that the SDK is up. The host uses this to forward
  // any later context (e.g. theme changes) without us having to ask.
  postParent({ type: "helm:ready", name: "helmApp", version: sdk.version });
})();

