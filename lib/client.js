/**
 * 客户端那一半：在输入框那排（计划模式 chip 的位置）挂一个「目标工程」开关。
 *
 * 它不自己存状态——点一下就走宿主命令 /goal-mode，状态由宿主决定，
 * 显示的是宿主返回的那句话。所以 UI 不会和真实行为分叉：
 * 关掉之后下一轮系统提示里就没有那段闸门，工具照旧在。
 *
 * 客户端插件是 ModuleLoader 载入的 CJS 工厂，不能 import（只有 require）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-goal-loop',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');

    const CSS_ID = '@deepseek-ai/dsh-goal-loop/ModeChip.module.css';
    const CSS = [
      '.dshgl_chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;',
      'padding:0 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;',
      'line-height:18px;cursor:pointer;transition:background-color .12s,color .12s,border-color .12s}',
      '.dshgl_chip:hover{background:var(--dsw-static-neutral-100);color:var(--dsw-alias-label-primary)}',
      '.dshgl_chip[data-on="true"]{color:var(--dsw-alias-state-business-primary);border-color:currentColor}',
      '.dshgl_chip[data-busy="true"]{opacity:.6;cursor:default}',
      '.dshgl_dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.3;flex:none}',
      '.dshgl_chip[data-on="true"] .dshgl_dot{opacity:1}',
      'body[data-ds-dark-theme] .dshgl_chip:hover{background:var(--dsw-static-neutral-800)}',
    ].join('');

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = '@deepseek-ai/dsh-goal-loop';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** 从宿主回的那句话里读开关状态；读不出来就当作未知。 */
    function readEnabled(value) {
      const text = typeof value === 'string' ? value : String(value?.text ?? '');
      if (!text) return null;
      if (text.includes('：开') || text.includes('开（')) return true;
      if (text.includes('：关') || text.includes('关（')) return false;
      return null;
    }

    /** 调宿主命令，返回 {ok, enabled, text}。 */
    async function callMode(remote, sessionId, arg) {
      const command = arg === undefined ? '/goal-mode' : `/goal-mode ${arg}`;
      const result = await remote.commands.execute(sessionId, command, []);
      if (!result?.ok) {
        return { ok: false, enabled: null, text: String(result?.error?.message ?? '命令执行失败') };
      }
      const enabled = readEnabled(result.value);
      return { ok: true, enabled, text: String(result.value?.text ?? '') };
    }

    function ModeChip({ sessionId, toggle, probe }) {
      const [enabled, setEnabled] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);
      const aliveRef = react.useRef(true);

      react.useEffect(() => {
        aliveRef.current = true;
        probe().then((result) => {
          if (!aliveRef.current) return;
          if (result.ok) setEnabled(result.enabled);
        }, () => {});
        return () => {
          aliveRef.current = false;
        };
      }, []);

      const onClick = () => {
        setBusy(true);
        setError(null);
        toggle().then((result) => {
          if (!aliveRef.current) return;
          setBusy(false);
          if (result.ok) setEnabled(result.enabled);
          else setError(result.text);
        }, (reason) => {
          if (!aliveRef.current) return;
          setBusy(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        });
      };

      const on = enabled === true;
      return jsxRuntime.jsxs('button', {
        type: 'button',
        className: 'dshgl_chip',
        'data-on': on ? 'true' : 'false',
        'data-busy': busy ? 'true' : 'false',
        disabled: busy,
        onClick,
        title: error ?? (on
          ? '目标工程已开：交付类任务先立合约、说完前要裁决。点击关闭。'
          : '目标工程已关：闸门不在系统提示里，goal_* 工具仍可手动用。点击打开。'),
        'aria-pressed': on,
        children: [
          jsxRuntime.jsx('span', { className: 'dshgl_dot', 'aria-hidden': true }),
          jsxRuntime.jsx('span', { children: on ? '目标工程' : '目标工程 · 关' }),
        ],
      });
    }

    const inject = [
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-api-remotes',
    ];

    function apply(ctx) {
      const remote = ctx.remote;
      if (!remote?.commands || typeof ctx.slots?.inject !== 'function') {
        ctx.logger?.warn?.('dsh-goal-loop(client): 缺少 commands 远程或 slots 服务，chip 未挂载');
        return;
      }
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'goal-loop-mode',
        order: 20,
        inject: (sessionId) => ({
          sessionId,
          probe: () => callMode(remote, sessionId, 'status'),
          toggle: () => callMode(remote, sessionId, undefined),
        }),
      }, ModeChip));
    }

    module.exports = { name: 'dsh-goal-loop', apply, inject };
    return module.exports;
  },
});
