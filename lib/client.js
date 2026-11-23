/**
 * dsh-goal-loop — client half（纯 DOM 版）。
 *
 * 三条不能破的约束（破了就打不开 DSH，判据是 fiber.state 必须 = ACTIVE(2)）：
 *   1. 模块级 inject 为空数组 —— 否则 boot 卡 pending 等不存在的服务
 *   2. apply 同步返回 cleanup —— 返回 Promise 会卡 loading
 *   3. 整个 apply 包 try/catch —— 异常只表现为按钮不出现
 *
 * 1.4.1 修的「点了没反应」：
 *   a) 事件从按钮自身改到 document 捕获阶段委托。React 重渲染会把按钮行整体
 *      替换掉，绑在旧节点上的 listener 跟着消失 —— 委托到 document 就不会丢。
 *   b) 每个分支都给可见反馈：点下去立刻变「切换中…」，结束时显示结果。
 *      以前 B 路成功也不改文案，看起来就是没反应。
 *   c) 写输入框改成三档：React props 的 onChange → 原生 setter + input 事件 →
 *      execCommand('insertText')；发送改成「点发送按钮」优先，Enter 兜底。
 *      受控组件只改 value 不触发 onChange，React 会立刻把值冲掉，所以第一档最关键。
 */

window.__ModuleLoader__.load({
  id: 'dsh-goal-loop',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const LOG = '[dsh-goal-loop/client]';
    const STYLE_ID = '@deepseek-ai/dsh-goal-loop/ModeChip.css';
    const BTN_ID = 'dsh-goal-loop/mode-chip';
    const CMD = '/goal-mode';

    const css = [
      '#dsh-goal-loop\\/mode-chip{display:inline-flex;align-items:center;gap:6px;',
      'height:28px;padding:0 10px;border-radius:14px;border:1px solid var(--dsw-alias-border-secondary,rgba(0,0,0,.14));',
      'background:var(--dsw-alias-bg-primary,#fff);color:var(--dsw-alias-label-secondary,#5b5b5b);',
      'font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;user-select:none}',
      '#dsh-goal-loop\\/mode-chip:hover{background:var(--dsw-alias-bg-hover,rgba(0,0,0,.04))}',
      '#dsh-goal-loop\\/mode-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary,#3b6ef5);',
      'color:var(--dsw-alias-brand-primary,#3b6ef5);background:var(--dsw-alias-bg-brand-weak,rgba(59,110,245,.08))}',
      '#dsh-goal-loop\\/mode-chip[data-busy="true"]{opacity:.6}',
      '#dsh-goal-loop\\/mode-chip .dshgl-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.35}',
      '#dsh-goal-loop\\/mode-chip[data-on="true"] .dshgl-dot{opacity:1}',
      'body[data-ds-dark-theme] #dsh-goal-loop\\/mode-chip{border-color:rgba(255,255,255,.18);',
      'background:rgba(255,255,255,.04);color:rgba(255,255,255,.72)}',
    ].join('');

    function injectCss() {
      try {
        if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-goal-loop';
        tag.dataset.pluginCss = STYLE_ID;
        tag.textContent = css;
        document.head.appendChild(tag);
      } catch (error) {
        console.warn(LOG, '注入样式失败', error);
      }
    }

    /** 找到输入框（可见、双属性兜底）。 */
    function findComposer() {
      const areas = [...document.querySelectorAll('textarea, [contenteditable="true"]')];
      for (const el of areas) {
        if (el.offsetParent === null) continue;
        const hint = `${el.getAttribute('placeholder') ?? ''}${el.getAttribute('aria-label') ?? ''}`;
        if (hint.includes('/调用指令') || hint.includes('@ 文件') || hint.includes('发消息')) return el;
      }
      for (const el of areas) {
        if (el.offsetParent !== null) return el;
      }
      return null;
    }

    /** 找承载按钮的那一行：从输入框往上，取第一个同时装着 ≥2 个可见按钮的元素。 */
    function findButtonRow(start) {
      let el = start?.parentElement ?? null;
      for (let depth = 0; depth < 8 && el !== null; depth += 1) {
        const buttons = [...el.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
        if (buttons.length >= 2) {
          let row = buttons[0].parentElement;
          while (row !== null && !buttons.every((b) => row.contains(b))) row = row.parentElement;
          return row ?? el;
        }
        el = el.parentElement;
      }
      return null;
    }

    function labelOf(button) {
      return button?.querySelector('.dshgl-label') ?? null;
    }

    function setLabel(button, text) {
      const label = labelOf(button);
      if (label !== null) label.textContent = text;
    }

    function setOn(button, on) {
      button.dataset.on = on === true ? 'true' : 'false';
      button.setAttribute('aria-pressed', on === true ? 'true' : 'false');
      setLabel(button, on === true ? '目标工程' : '目标工程 · 关');
    }

    /** 从命令回执里读开关状态：'目标工程：开' / '目标工程：关'。 */
    function parseEnabled(text) {
      const raw = String(text ?? '');
      if (raw.includes('：开') || raw.includes(': 开')) return true;
      if (raw.includes('：关') || raw.includes(': 关')) return false;
      return null;
    }

    /** 路径 A：运行时取 commands 远程（不产生对话消息）。 */
    function lazyCommands() {
      try {
        const mod = require('@deepseek-ai/dsh-api-remotes');
        const api = mod?.default ?? mod;
        if (api?.commands?.execute) return { execute: api.commands.execute.bind(api.commands), via: 'remotes.commands' };
        if (typeof api?.execute === 'function') return { execute: api.execute.bind(api), via: 'remotes.execute' };
        return { execute: null, via: 'remotes-shape:' + Object.keys(api ?? {}).slice(0, 6).join(',') };
      } catch (error) {
        return { execute: null, via: 'require-failed' };
      }
    }

    /** 当前会话 id：从地址栏或 hash 兜底。 */
    function currentSessionId() {
      try {
        const match = location.pathname.match(/\/s\/([^/?#]+)/) ?? location.hash.match(/\/s\/([^/?#]+)/);
        return match?.[1] ?? null;
      } catch {
        return null;
      }
    }

    /** 取元素上的 React props（受控组件只有走它才认得新值）。 */
    function reactPropsOf(el) {
      try {
        const key = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
        return key === undefined ? null : el[key];
      } catch {
        return null;
      }
    }

    /** 把文本写进输入框。三档依次尝试，返回用了哪一档。 */
    function setComposerValue(el, text) {
      const props = reactPropsOf(el);
      if (props?.onChange) {
        try {
          props.onChange({ target: { value: text }, currentTarget: { value: text } });
          return 'react-onChange';
        } catch {
          /* 落到下一档 */
        }
      }
      try {
        const tag = el.tagName;
        const proto = tag === 'TEXTAREA' ? window.HTMLTextAreaElement?.prototype : window.HTMLInputElement?.prototype;
        const setter = proto === undefined ? undefined : Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (typeof setter === 'function') setter.call(el, text);
        else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'native-setter';
      } catch {
        /* 落到下一档 */
      }
      try {
        el.focus();
        document.execCommand('insertText', false, text);
        return 'execCommand';
      } catch {
        return 'failed';
      }
    }

    /** 找发送按钮：aria-label 含「发送」，或输入框右边最近的可点按钮。 */
    function findSendButton(composer) {
      const row = findButtonRow(composer);
      if (row === null) return null;
      const buttons = [...row.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const byLabel = buttons.find((b) => {
        const hint = `${b.getAttribute('aria-label') ?? ''}${b.title ?? ''}${b.textContent ?? ''}`;
        return hint.includes('发送') || hint.includes('Send') || hint.includes('send');
      });
      if (byLabel !== undefined) return byLabel;
      const byType = buttons.find((b) => b.type === 'submit');
      return byType ?? null;
    }

    /** 路径 B：把命令写进输入框再发出去（一定执行，代价是对话里多一条回执）。 */
    function sendViaComposer() {
      const composer = findComposer();
      if (composer === null) return { ok: false, text: '找不到输入框' };
      const how = setComposerValue(composer, CMD);
      if (how === 'failed') return { ok: false, text: '写不进输入框' };
      const send = findSendButton(composer);
      if (send !== null) {
        send.click();
        return { ok: true, text: '已点发送(' + how + ')' };
      }
      try {
        composer.focus();
        composer.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
        }));
      } catch {
        /* 两条都失败就是失败 */
      }
      return { ok: true, text: '已回车(' + how + ')' };
    }

    let revertTimer = null;

    function flash(button, text, ms = 2400) {
      setLabel(button, text);
      if (revertTimer !== null) clearTimeout(revertTimer);
      revertTimer = setTimeout(() => {
        revertTimer = null;
        setOn(button, button.dataset.on === 'true');
      }, ms);
    }

    async function toggle(button) {
      if (button.dataset.busy === 'true') return;
      button.dataset.busy = 'true';
      const trace = [];
      try {
        setLabel(button, '切换中…');
        const { execute, via } = lazyCommands();
        trace.push('A=' + via);
        const sessionId = currentSessionId();
        if (execute !== null && sessionId !== null) {
          const result = await execute(sessionId, CMD, []);
          if (result?.ok === true) {
            const on = parseEnabled(result.value?.text);
            if (on !== null) {
              setOn(button, on);
              button.title = '目标工程：' + (on ? '开' : '关') + '（' + trace.join(' ') + ' A-ok）';
              return;
            }
            trace.push('A-noparse');
          } else {
            trace.push('A-fail:' + String(result?.error?.code ?? '?'));
          }
        } else {
          trace.push(execute === null ? 'A-noremote' : 'A-nosession');
        }
        const fallback = sendViaComposer();
        trace.push('B=' + fallback.text);
        button.title = '目标工程切换：' + trace.join(' · ');
        flash(button, fallback.ok ? fallback.text : '失败：' + fallback.text, 4000);
      } catch (error) {
        button.title = '目标工程切换异常：' + String(error?.message ?? error);
        flash(button, '出错:' + String(error?.message ?? error).slice(0, 10), 4000);
      } finally {
        button.dataset.busy = 'false';
      }
    }

    function makeButton() {
      const button = document.createElement('button');
      button.id = BTN_ID;
      button.type = 'button';
      button.dataset.on = 'false';
      button.dataset.busy = 'false';
      button.setAttribute('aria-pressed', 'false');
      button.title = '目标工程：交付类任务先立合约、说完成前要裁决。点击切换（关掉后闸门不在系统提示里，goal_* 工具仍可手动用）。';
      const dot = document.createElement('span');
      dot.className = 'dshgl-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'dshgl-label';
      label.textContent = '目标工程 · 关';
      button.append(dot, label);
      return button;
    }

    /** 幂等挂载：已经挂上就什么都不做。 */
    function mount() {
      try {
        if (document.getElementById(BTN_ID) !== null) return true;
        const composer = findComposer();
        if (composer === null) return false;
        const row = findButtonRow(composer);
        if (row === null) return false;
        injectCss();
        row.appendChild(makeButton());
        return true;
      } catch (error) {
        console.warn(LOG, '挂载失败', error);
        return false;
      }
    }

    function watch() {
      let queued = false;
      const observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          mount();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }

    /** 捕获阶段委托：按钮被 React 重建也不会丢监听。 */
    function listen() {
      const onClick = (event) => {
        try {
          const target = event.target;
          const button = target?.closest?.('[id="dsh-goal-loop/mode-chip"]');
          if (button === null || button === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          void toggle(button);
        } catch {
          /* 点击处理绝不向外抛 */
        }
      };
      document.addEventListener('click', onClick, true);
      return () => document.removeEventListener('click', onClick, true);
    }

    const inject = [];

    function apply(ctx) {
      try {
        ctx?.logger?.info?.(LOG, '已启动（DOM 模式 1.4.1）');
      } catch {}
      let cleanup = null;
      let offClick = null;
      try {
        mount();
        cleanup = watch();
        offClick = listen();
      } catch (error) {
        console.warn(LOG, '初始化失败，按钮不会出现（应用不受影响）', error);
      }
      return () => {
        try {
          offClick?.();
          cleanup?.();
          if (revertTimer !== null) clearTimeout(revertTimer);
          document.getElementById(BTN_ID)?.remove();
        } catch {}
      };
    }

    module.exports = { name: 'dsh-goal-loop', apply, inject };
    return module.exports;
  },
});
