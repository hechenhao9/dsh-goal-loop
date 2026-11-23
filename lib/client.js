/**
 * dsh-goal-loop — composer pill (browser half)
 *
 * Shaped after the shipped `dsh-windows-mcp` pill: a seat in
 * `conversation.input.left`, `inject = ["slots"]` (the one service that is
 * certainly provided — declaring a service nobody provides leaves this
 * plugin's fiber `pending` and the whole web boot fails), the host owns the
 * flag, and the pill only renders what `GET /state` answers.
 *
 * No `ctx.remote`, no command round-trip: the switch reads and writes its own
 * host route, so it keeps working even when the command catalog has not
 * refreshed.
 */
window.__ModuleLoader__.load({
  id: "dsh-goal-loop",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    var PACKAGE_ID = "dsh-goal-loop";
    var SLOT_NAME = "conversation.input.left";
    var ENTRY_ID = "goal-loop-mode";
    var ENTRY_ORDER = 26;
    var STATE_PATH = "/dsh-goal-loop/state";
    var STYLE_ID = PACKAGE_ID + "-pill-styles";

    /** Only `slots` is injected. A service nobody provides would keep the
     *  fiber `pending` and break the web boot. */
    var inject = ["slots"];

    var CSS = [
      ".dgl-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 7px 0 5px;",
      "border:none;border-radius:999px;background:transparent;",
      "color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;",
      "letter-spacing:.01em;cursor:pointer;white-space:nowrap;user-select:none;",
      "transition:color .14s ease,opacity .14s ease}",
      ".dgl-pill:hover{color:var(--dsw-alias-label-primary)}",
      ".dgl-pill:active{transform:translateY(.5px)}",
      ".dgl-pill:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);",
      "outline-offset:1px}",
      ".dgl-pill[data-busy='1']{opacity:.65;cursor:progress}",
      ".dgl-pill[disabled]{cursor:not-allowed;opacity:.5}",
      ".dgl-dot{width:6px;height:6px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary);",
      "transition:background-color .18s ease,box-shadow .18s ease}",
      ".dgl-pill[data-state='on'] .dgl-dot{background:var(--dsw-alias-state-success-primary);",
      "box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 22%,transparent)}",
      ".dgl-pill[data-state='warn'] .dgl-dot{background:var(--dsw-alias-state-warn-primary);",
      "box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 20%,transparent)}",
      ".dgl-icon{width:14px;height:14px;flex:none;display:block;opacity:.85}",
      ".dgl-pill:hover .dgl-icon{opacity:1}",
      "@media (max-width:860px){.dgl-label{display:none}.dgl-pill{padding:0 5px}}",
      "@media (prefers-reduced-motion:reduce){.dgl-pill,.dgl-dot{transition:none}}",
    ].join("");

    function ensureStyles() {
      try {
        if (typeof document === "undefined") return;
        if (document.getElementById(STYLE_ID) !== null) return;
        var style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
      } catch (error) {
        /* a missing stylesheet only costs the colours */
      }
    }

    /**
     * Same-origin URL for a host route, anchored on `document.baseURI`: the
     * host serves its UI from that directory and does not use path routing.
     */
    function apiUrl(path) {
      var relative = String(path).replace(/^\/+/, "");
      try {
        if (typeof document === "undefined") return "/" + relative;
        return new URL(relative, document.baseURI).pathname;
      } catch (error) {
        return "/" + relative;
      }
    }

    /** Three stacked gates inside a frame: the switch turns the gates on. */
    function gateIcon() {
      return React.createElement(
        "svg",
        {
          className: "dgl-icon",
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.4",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        React.createElement("rect", { x: "1.8", y: "2.2", width: "12.4", height: "11.6", rx: "2" }),
        React.createElement("path", { d: "M4.4 5.6h7.2" }),
        React.createElement("path", { d: "M4.4 8h7.2" }),
        React.createElement("path", { d: "M4.4 10.4h4.4" }),
      );
    }

    /**
     * Read and write the host's flag. The host is the source of truth: the pill
     * renders whatever `/state` answers and rolls back when a write is refused.
     */
    function useFlag() {
      var initial = { phase: "loading", enabled: false, busy: false, error: null };
      var pair = React.useState(initial);
      var view = pair[0];
      var setView = pair[1];
      // True while a write is in flight: the poller stays quiet so an
      // optimistic toggle is not overwritten by a stale read.
      var busyRef = React.useRef(false);

      var load = React.useCallback(function () {
        try {
          fetch(apiUrl(STATE_PATH), { cache: "no-store", headers: { accept: "application/json" } })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + response.status);
              return response.json();
            })
            .then(function (body) {
              setView({ phase: "ready", enabled: body && body.enabled === true, busy: false, error: null });
            })
            .catch(function (error) {
              setView({ phase: "error", enabled: false, busy: false, error: messageOf(error) });
            });
        } catch (error) {
          setView({ phase: "error", enabled: false, busy: false, error: messageOf(error) });
        }
      }, []);

      React.useEffect(function () {
        load();
        if (typeof window === "undefined" || typeof window.setInterval !== "function") return undefined;
        var refresh = function () {
          if (!busyRef.current) load();
        };
        var timer = window.setInterval(refresh, 4000);
        var hasListeners = typeof window.addEventListener === "function";
        if (hasListeners) window.addEventListener("focus", refresh);
        return function () {
          window.clearInterval(timer);
          if (hasListeners) window.removeEventListener("focus", refresh);
        };
      }, [load]);

      var toggle = React.useCallback(function () {
        if (view.phase === "loading" || view.busy) return;
        var next = !view.enabled;
        busyRef.current = true;
        setView({ phase: view.phase === "error" ? "ready" : view.phase, enabled: next, busy: true, error: null });
        try {
          fetch(apiUrl(STATE_PATH), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          })
            .then(function (response) {
              if (!response.ok) throw new Error("HTTP " + response.status);
              return response.json();
            })
            .then(function (body) {
              busyRef.current = false;
              setView({ phase: "ready", enabled: body && body.enabled === true, busy: false, error: null });
            })
            .catch(function (error) {
              busyRef.current = false;
              setView({ phase: "ready", enabled: !next, busy: false, error: messageOf(error) });
            });
        } catch (error) {
          busyRef.current = false;
          setView({ phase: "ready", enabled: !next, busy: false, error: messageOf(error) });
        }
      }, [view]);

      return [view, toggle, load];
    }

    function messageOf(error) {
      try {
        return String(error && error.message ? error.message : error);
      } catch (ignored) {
        return "unknown";
      }
    }

    function labelOf(view) {
      if (view.phase === "loading") return "目标工程 …";
      if (view.phase === "error") return "目标工程 · 连不上";
      return view.enabled ? "目标工程" : "目标工程 · 关";
    }

    function tooltipOf(view) {
      if (view.phase === "loading") return "正在读宿主状态";
      if (view.phase === "error") return "读不到宿主状态：" + view.error + "\n点一下重试";
      return view.enabled
        ? "目标工程：开。交付类任务会先落合约、机器层跑绿、评审过线才准说完成。点一下关闭。"
        : "目标工程：关。常驻闸门已撤，goal_* 工具还在（想用就打 /goal）。点一下打开。";
    }

    function GoalLoopPill() {
      var triple = useFlag();
      var view = triple[0];
      var toggle = triple[1];
      var reload = triple[2];

      var state = view.phase === "error" ? "warn" : view.enabled ? "on" : "off";
      var onClick = view.phase === "error" ? reload : toggle;

      return React.createElement(
        "button",
        {
          type: "button",
          className: "dgl-pill",
          "data-state": state,
          "data-busy": view.busy ? "1" : "0",
          role: "switch",
          "aria-checked": view.enabled === true,
          "aria-label": "目标工程开关",
          title: tooltipOf(view),
          onClick: onClick,
        },
        React.createElement("span", { className: "dgl-dot" }),
        gateIcon(),
        React.createElement("span", { className: "dgl-label" }, labelOf(view)),
      );
    }

    function apply(ctx) {
      try {
        ensureStyles();
      } catch (error) {
        /* styles are cosmetic */
      }
      try {
        if (!ctx || typeof ctx.slots !== "object" || ctx.slots === null) return function () {};
        if (typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") {
          return function () {};
        }
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () {
                return "目标工程";
              },
              inject: function (sessionId) {
                return { sessionId: sessionId };
              },
            },
            function SlotComponent() {
              return React.createElement(GoalLoopPill, null);
            },
          );
        });
      } catch (error) {
        try {
          console.error("[" + PACKAGE_ID + "] composer pill registration failed:", error);
        } catch (ignored) {
          /* nothing else to do: a missing pill must not break the composer */
        }
      }
      return function () {};
    }

    module.exports = { name: PACKAGE_ID, apply: apply, inject: inject };
    return module.exports;
  },
});
