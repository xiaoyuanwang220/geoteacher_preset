// geo-edu / dsh-geo-teacher-ui —— 客户端半边
//
// 落点（均为 list/none，零遮蔽）：
//   · conversation.input.left（工具行左侧；当前无原生占位者）
//       → 左：按功能切换的设置下拉（讲解对象 / 题型+难度 / 年级+时间）
//   · conversation.input.right（宿主顺序在模型选择器之前）
//       → 右：功能选择器（讲题/出题/课程方案），紧邻原生模型选择器左侧
//   · 发送仍由原生发送按钮完成；文本/附件/排队全走原生输入状态
//
// 提示词成形方式：不额外加"开始讲题"按钮——选择功能或改设置时，把
// `请按「<功能>」功能处理：\n<设置项>：<值>\n\n需求：` 作为前缀写入原生输入框，
// 用户自己的文字原样保留；各功能已填内容与选项分别记忆，切换时互换。
//
// 打包：普通脚本 + window.__ModuleLoader__.load({id, factory})；纯 JS、零构建。
// 样式：手工注入 <style>，类名 geo- 前缀，颜色只走 --dsw-alias-* 令牌。

window.__ModuleLoader__.load({
  id: '@geo-edu/dsh-geo-teacher-ui',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PRESET_ID = 'geo-teacher';
    const STYLE_ID = 'geo-teacher-ui-styles';

    // ── 图标（Phosphor regular 线条）────────────────────────────────────
    const ICONS = {
      explain: 'M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64Z',
      questions: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z',
      lesson: 'M251.76,88.94l-120-64a8,8,0,0,0-7.52,0l-120,64a8,8,0,0,0,0,14.12L32,117.87v48.42a15.91,15.91,0,0,0,4.06,10.65C49.16,191.53,78.51,216,128,216a130,130,0,0,0,48-8.76V240a8,8,0,0,0,16,0V199.51a115.63,115.63,0,0,0,27.94-22.57A15.91,15.91,0,0,0,224,166.29V117.87l27.76-14.81a8,8,0,0,0,0-14.12ZM128,200c-43.27,0-68.72-21.14-80-33.71V126.4l76.24,40.66a8,8,0,0,0,7.52,0L176,143.47v46.34C163.4,195.69,147.52,200,128,200Zm80-33.75a97.83,97.83,0,0,1-16,14.25V134.93l16-8.53ZM188,118.94l-.22-.13-56-29.87a8,8,0,0,0-7.52,14.12L171,128l-43,22.93L25,96,128,41.07,231,96Z',
      caretDown: 'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z',
      check: 'M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z',
      folder: 'M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z',
      headset: 'M201.89,54.66A103.43,103.43,0,0,0,128.79,24H128A104,104,0,0,0,24,128v56a24,24,0,0,0,24,24H64a24,24,0,0,0,24-24V144a24,24,0,0,0-24-24H40.36A88.12,88.12,0,0,1,190.54,65.93,87.39,87.39,0,0,1,215.65,120H192a24,24,0,0,0-24,24v40a24,24,0,0,0,24,24h24a24,24,0,0,1-24,24H136a8,8,0,0,0,0,16h56a40,40,0,0,0,40-40V128A103.41,103.41,0,0,0,201.89,54.66ZM64,136a8,8,0,0,1,8,8v40a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V136Zm128,56a8,8,0,0,1-8-8V144a8,8,0,0,1,8-8h24v56Z',
      gauge: 'M216,176a8,8,0,0,1-8-8A80,80,0,0,0,63.63,109.63a80,80,0,0,0-22.54,54.36,8,8,0,0,1-16,0A96,96,0,1,1,224,168A8,8,0,0,1,216,176Zm-88-16a16,16,0,1,1,16-16A16,16,0,0,1,128,160Z'
    };

    function icon(name, size) {
      return h('svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        viewBox: '0 0 256 256',
        width: size,
        height: size,
        fill: 'currentColor',
        'aria-hidden': 'true',
        focusable: 'false'
      }, h('path', { d: ICONS[name] }));
    }

    // ── 三功能定义（设置项与输入提示按规格）────────────────────────────────
    const MODES = [
      {
        id: 'explain',
        name: '讲题',
        placeholder: '请输入年份、省份和题号，例如：2025年广东卷第10题。',
        helper: '可补充需要重点讲解的知识点或具体疑问。',
        fields: [{ key: 'audience', label: '讲解对象', options: ['教师', '学生', '命题人'] }]
      },
      {
        id: 'questions',
        name: '出题',
        placeholder: '请说明学生学情、要考查的知识点及题目数量。',
        helper: '可补充学生年级、已有基础、常见薄弱点及命题情境要求。',
        fields: [
          { key: 'type', label: '题型', options: ['选择题', '综合题'] },
          { key: 'difficulty', label: '难度', options: ['简单', '中等', '困难'] }
        ]
      },
      {
        id: 'lesson',
        name: '课程方案',
        placeholder: '请提供课本、课标等 Markdown 文档。',
        helper: '请补充具体学情、教学目标及课堂活动要求等信息。',
        fields: [
          { key: 'grade', label: '年级', options: ['高一', '高二', '高三'] },
          { key: 'duration', label: '时间', options: ['45分钟', '10分钟'] }
        ]
      }
    ];

    // 讲题对象默认取「学生」：preset 的 persona 明示"默认 student、不自动选 teacher"，
    // 而本插件拼出的前缀是模型唯一可见的输入，故不能沿用原型设计稿的"教师"默认值。
    const INITIAL_VALUES = { audience: '学生', type: '选择题', difficulty: '中等', grade: '高一', duration: '45分钟' };

    function modeOf(id) {
      for (let i = 0; i < MODES.length; i += 1) if (MODES[i].id === id) return MODES[i];
      return MODES[0];
    }

    // 写入输入框的前缀：功能 + 设置项，末尾留出"需求："给用户续写
    function prefixFor(mode, values) {
      const lines = ['请按「' + mode.name + '」功能处理：'];
      mode.fields.forEach(function (field) { lines.push(field.label + '：' + values[field.key]); });
      lines.push('', '需求：');
      return lines.join('\n');
    }

    function stripPrefix(draft, prefix) {
      if (typeof draft !== 'string') return '';
      if (typeof prefix === 'string' && prefix && draft.indexOf(prefix) === 0) return draft.slice(prefix.length);
      return draft;
    }

    // ── 样式：沿用原生观感（浅灰细边框 / 圆角 / 柔和阴影 / 品牌蓝强调）──────
    const CSS = [
      /* 我们改写过的原生输入框（Lexical contenteditable）：让两行提示能换行 */
      'div[data-composer-input][data-geo-placeholder]::before{white-space:pre-wrap}',
      'div[data-composer-input][data-geo-placeholder]{white-space:pre-wrap}',

      /* 下拉控件：与原生模型选择器同一质感 */
      '.geo-picker{position:relative;display:inline-flex}',
      '.geo-select{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 9px;border-radius:9px;',
      'border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);',
      'font-size:12.5px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s}',
      '.geo-select:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.geo-select[aria-expanded="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.geo-select .geo-caret{color:var(--dsw-alias-label-secondary)}',
      '.geo-select[aria-expanded="true"] .geo-caret{color:var(--dsw-alias-brand-primary)}',
      '.geo-select-value{color:var(--dsw-alias-label-secondary)}',
      '.geo-select-strong{font-weight:600}',

      '.geo-menu{position:absolute;left:0;bottom:calc(100% + 6px);z-index:70;min-width:100%;width:max-content;',
      'padding:5px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);',
      'box-shadow:0 8px 24px rgba(0,0,0,.14)}',
      '.geo-menu-right{left:auto;right:0}',
      '.geo-option{display:flex;align-items:center;justify-content:space-between;gap:20px;width:100%;min-width:120px;',
      'padding:7px 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);',
      'font-size:12.5px;line-height:1.2;text-align:left;cursor:pointer}',
      '.geo-option:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.geo-option[aria-selected="true"]{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);',
      'color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.geo-option-check{color:var(--dsw-alias-brand-primary);display:inline-flex}',
      '.geo-option-label{display:inline-flex;align-items:center;gap:7px}'
    ].join('');

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function removeStyles() {
      const tag = document.getElementById(STYLE_ID);
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
    }

    // ── 共享状态 ────────────────────────────────────────────────────────
    function createStore() {
      let state = {
        active: 'explain',
        values: Object.assign({}, INITIAL_VALUES),
        drafts: { explain: '', questions: '', lesson: '' },
        appliedPrefix: null,
        lastDraft: '',
        inputActions: null
      };
      const listeners = new Set();
      return {
        get: function () { return state; },
        set: function (patch) {
          let changed = false;
          Object.keys(patch).forEach(function (key) { if (state[key] !== patch[key]) changed = true; });
          if (!changed) return;
          state = Object.assign({}, state, patch);
          listeners.forEach(function (listener) { listener(); });
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        }
      };
    }

    function useStore(store) {
      const pair = React.useState(store.get());
      const setState = pair[1];
      React.useEffect(function () { return store.subscribe(function () { setState(store.get()); }); }, []);
      return pair[0];
    }

    function setDraftVia(store, text) {
      const actions = store.get().inputActions;
      if (!actions || typeof actions.setDraft !== 'function') return false;
      try {
        actions.setDraft(text);
        store.set({ lastDraft: text });
        return true;
      } catch (error) {
        console.warn('geo-teacher-ui: 写入输入框失败', error);
        return false;
      }
    }

    // 改设置：前缀就地更新，用户正文不动
    function changeValue(store, key, value) {
      const state = store.get();
      const values = Object.assign({}, state.values);
      values[key] = value;
      const mode = modeOf(state.active);
      const userText = stripPrefix(state.lastDraft, state.appliedPrefix);
      const prefix = prefixFor(mode, values);
      setDraftVia(store, prefix + userText);
      store.set({ values: values, appliedPrefix: prefix, lastDraft: prefix + userText });
    }

    // 切功能：保存当前功能正文，换入目标功能的前缀与正文
    function switchMode(store, nextId) {
      const state = store.get();
      if (nextId === state.active) return;
      const from = modeOf(state.active);
      const userText = stripPrefix(state.lastDraft, state.appliedPrefix);
      const drafts = Object.assign({}, state.drafts);
      drafts[from.id] = userText;
      const to = modeOf(nextId);
      const nextText = drafts[to.id] || '';
      const prefix = prefixFor(to, state.values);
      setDraftVia(store, prefix + nextText);
      store.set({ active: nextId, drafts: drafts, appliedPrefix: prefix, lastDraft: prefix + nextText });
    }

    // ── 下拉（原生观感；外点关闭 / Esc / ↑↓）──────────────────────────────
    function createPicker() {
      return function Picker(props) {
        const [open, setOpen] = React.useState(false);
        const root = React.useRef(null);
        const trigger = React.useRef(null);

        React.useEffect(function () {
          if (!open) return undefined;
          function onDown(event) {
            if (root.current && !root.current.contains(event.target)) setOpen(false);
          }
          document.addEventListener('pointerdown', onDown);
          return function () { document.removeEventListener('pointerdown', onDown); };
        }, [open]);

        function move(step) {
          if (!root.current) return;
          const items = Array.prototype.slice.call(root.current.querySelectorAll('[role="option"]'));
          if (!items.length) return;
          const index = items.indexOf(document.activeElement);
          items[index < 0 ? 0 : (index + step + items.length) % items.length].focus();
        }

        function onKeyDown(event) {
          if (event.key === 'Escape') {
            setOpen(false);
            if (trigger.current) trigger.current.focus();
            return;
          }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
              setOpen(true);
              window.setTimeout(function () { move(event.key === 'ArrowDown' ? 0 : -1); }, 0);
            } else {
              move(event.key === 'ArrowDown' ? 1 : -1);
            }
          }
        }

        const alignRight = props.align === 'right';
        return h('div', { className: 'geo-picker', ref: root, onKeyDown: onKeyDown },
          h('button', {
            ref: trigger,
            type: 'button',
            className: 'geo-select',
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            title: props.title || props.label,
            onClick: function () { setOpen(!open); }
          },
            props.leadingIcon ? icon(props.leadingIcon, 15) : null,
            props.label ? h('span', { className: 'geo-select-value' }, props.label + '：') : null,
            h('span', { className: props.label ? null : 'geo-select-strong' }, props.display !== undefined ? props.display : props.value),
            h('span', { className: 'geo-caret' }, icon('caretDown', 13))
          ),
          open ? h('div', { className: 'geo-menu' + (alignRight ? ' geo-menu-right' : ''), role: 'listbox', 'aria-label': props.label || props.title },
            (props.options || []).map(function (option) {
              const value = typeof option === 'string' ? option : option.value;
              const label = typeof option === 'string' ? option : option.label;
              const optionIcon = typeof option === 'string' ? null : option.icon;
              const chosen = value === props.value;
              return h('button', {
                key: value,
                type: 'button',
                role: 'option',
                className: 'geo-option',
                'aria-selected': chosen ? 'true' : 'false',
                onClick: function () {
                  props.onChange(value);
                  setOpen(false);
                  if (trigger.current) trigger.current.focus();
                }
              },
                h('span', { className: 'geo-option-label' }, optionIcon ? icon(optionIcon, 15) : null, label),
                chosen ? h('span', { className: 'geo-option-check' }, icon('check', 14)) : null
              );
            })
          ) : null
        );
      };
    }

    // hook 必须在组件体内调用：用模块级稳定选择器，避免每次渲染换引用
    const identitySelector = function (snapshot) { return snapshot; };

    // 原生输入框的 placeholder 由宿主持有，插件没有可改它的 API。要"把提示放进原对话框"，
    // 只能就地改写原生编辑器的提示属性/文本，并在退出本预设/卸载时还原。
    // 注意：DSH 的输入区不一定是 <textarea>，因此同时找 contenteditable。
    function findComposerEditor(fromEl) {
      let node = fromEl;
      for (let depth = 0; node && depth < 8; depth += 1) {
        if (node.querySelector) {
          const editable = node.querySelector('[contenteditable="true"]');
          if (editable) return { el: editable, kind: 'contenteditable' };
          const area = node.querySelector('textarea');
          if (area) return { el: area, kind: 'textarea' };
        }
        node = node.parentElement;
      }
      return null;
    }

    // DSH 的输入提示由组件渲染（宿主 CSS 里没有 attr(data-placeholder)），
    // 所以要按"文本内容"找到那个真正显示提示的叶子节点再改写它。
    function findPlaceholderNode(rootEl, candidates) {
      try {
        if (!rootEl || !rootEl.querySelectorAll) return null;
        const nodes = rootEl.querySelectorAll('*');
        for (let i = 0; i < nodes.length; i += 1) {
          const el = nodes[i];
          if (el.children && el.children.length > 0) continue;
          const text = (el.textContent || '').trim();
          if (!text) continue;
          for (let c = 0; c < candidates.length; c += 1) {
            const cand = candidates[c];
            if (cand && text === String(cand).trim()) return el;
          }
        }
        return null;
      } catch (error) {
        return null;
      }
    }

    // hero 文案在 host 的 conversation 语言字典里（hero.headline / hero.preview），
    // 但 locale 服务规定同一 (ns, locale) 只能有一个 owner、重复注册会抛错，
    // 因此只能按文本找到这两个叶子节点做替换/隐藏，并在退出时还原。
    const BRAND_HEADLINE_FROM = '探索未至之境';
    const BRAND_HEADLINE_TO = 'GeoSparkAI · 点亮地理，启发思考';
    const BRAND_BADGE_FROM = '预览版';

    function findLeafByText(rootEl, text) {
      const hits = [];
      try {
        if (!rootEl || !rootEl.querySelectorAll) return hits;
        const nodes = rootEl.querySelectorAll('*');
        for (let i = 0; i < nodes.length; i += 1) {
          const el = nodes[i];
          if (el.children && el.children.length > 0) continue;
          if ((el.textContent || '').trim() === text) hits.push(el);
        }
      } catch (error) { /* ignore */ }
      return hits;
    }

    function hidePill(el) {
      // 把只包含该文案的最外层祖先一起隐藏，避免留下空胶囊
      let node = el;
      while (node.parentElement && (node.parentElement.textContent || '').trim() === BRAND_BADGE_FROM) {
        node = node.parentElement;
      }
      if (node.getAttribute('data-geo-orig-display') === null) {
        node.setAttribute('data-geo-orig-display', node.style.display || '');
      }
      node.setAttribute('data-geo-brand', 'badge');
      node.style.display = 'none';
      return node;
    }

    // 每个功能的两行提示（第一行=输入提示，第二行=可补充说明）
    function placeholderFor(mode) {
      return mode.placeholder + '\n' + mode.helper;
    }

    // ── 工具行左侧：按功能切换的设置（conversation.input.left）────────────
    function createSettings(store) {
      const Picker = createPicker();
      return function Settings(props) {
        const preset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined;
        const state = useStore(store);
        const mode = modeOf(state.active);
        const anchor = React.useRef(null);

        // input.left 没有 input 快照属性，用 useInput 钩子读原生草稿（hook 必须无条件调用）
        const inputState = typeof props.useInput === 'function' ? props.useInput(identitySelector) : null;
        const draftNow = inputState && typeof inputState.draft === 'string'
          ? inputState.draft
          : (props.input && typeof props.input.draft === 'string' ? props.input.draft : null);

        React.useEffect(function () {
          if (draftNow !== null) store.set({ lastDraft: draftNow });
          if (props.inputActions && !store.get().inputActions) store.set({ inputActions: props.inputActions });
        }, [draftNow, preset]);

        // 把当前功能的提示写进原生输入框（退出本预设/卸载时还原）
        React.useEffect(function () {
          const el = anchor.current;
          if (!el) return undefined;
          const found = findComposerEditor(el);
          if (!found) return undefined;
          const target = found.el;
          const attr = found.kind === 'textarea' ? 'placeholder' : 'data-placeholder';
          if (target.getAttribute('data-geo-original-placeholder') === null) {
            target.setAttribute('data-geo-original-placeholder', target.getAttribute(attr) || '');
          }
          const original = target.getAttribute('data-geo-original-placeholder') || '';
          const wanted = preset === PRESET_ID ? placeholderFor(mode) : original;
          let container = target.parentElement;
          for (let i = 0; i < 4 && container && container.parentElement; i += 1) container = container.parentElement;
          const searchRoot = container || target.parentElement || target;

          const apply = function () {
            if (target.getAttribute(attr) !== wanted) target.setAttribute(attr, wanted);
            target.setAttribute('data-geo-applied-placeholder', wanted);
            const node = findPlaceholderNode(searchRoot, [
              original,
              wanted,
              target.getAttribute('data-geo-prev-placeholder')
            ]);
            if (node) {
              if (node.textContent !== wanted) node.textContent = wanted;
              if (node.style.whiteSpace !== 'pre-wrap') node.style.whiteSpace = 'pre-wrap';
            }
            target.setAttribute('data-geo-prev-placeholder', wanted);
            return node;
          };

          if (wanted === original) target.removeAttribute('data-geo-placeholder');
          else target.setAttribute('data-geo-placeholder', 'on');
          apply();
          const timer = window.setInterval(apply, 1200);
          return function () {
            window.clearInterval(timer);
            target.setAttribute(attr, original);
            target.removeAttribute('data-geo-placeholder');
            target.removeAttribute('data-geo-prev-placeholder');
            const back = findPlaceholderNode(searchRoot, [wanted]);
            if (back && original) back.textContent = original;
          };
        }, [preset, mode.id]);

        // hero 文案替换（宿主 conversation 语言字典的 hero.headline / hero.preview）：
        // 仅在本预设生效；退出本预设或卸载时还原
        React.useEffect(function () {
          const el = anchor.current;
          if (!el) return undefined;

          const apply = function () {
            let root = el;
            for (let i = 0; i < 6 && root.parentElement; i += 1) root = root.parentElement;
            let headlineHits = findLeafByText(root, BRAND_HEADLINE_FROM);
            let badgeHits = findLeafByText(root, BRAND_BADGE_FROM);
            let usedRoot = 'local';
            if (!headlineHits.length && !badgeHits.length) {
              usedRoot = 'body';
              headlineHits = findLeafByText(document.body, BRAND_HEADLINE_FROM);
              badgeHits = findLeafByText(document.body, BRAND_BADGE_FROM);
            }
            if (preset === PRESET_ID) {
              headlineHits.forEach(function (node) {
                node.setAttribute('data-geo-brand', 'headline');
                if (node.textContent !== BRAND_HEADLINE_TO) node.textContent = BRAND_HEADLINE_TO;
              });
              badgeHits.forEach(function (node) { hidePill(node); });
            }
            return { usedRoot: usedRoot, headline: headlineHits.length, badge: badgeHits.length };
          };

          apply();
          const timer = window.setInterval(apply, 1200);
          return function () {
            window.clearInterval(timer);
            Array.prototype.slice.call(document.querySelectorAll('[data-geo-brand="headline"]')).forEach(function (node) {
              node.textContent = BRAND_HEADLINE_FROM;
              node.removeAttribute('data-geo-brand');
            });
            Array.prototype.slice.call(document.querySelectorAll('[data-geo-brand="badge"]')).forEach(function (node) {
              node.style.display = node.getAttribute('data-geo-orig-display') || '';
              node.removeAttribute('data-geo-orig-display');
              node.removeAttribute('data-geo-brand');
            });
          };
        }, [preset]);

        // 退出门控时只留一个不可见锚点：既不影响外观，又让提示能还原
        if (preset !== PRESET_ID) {
          return h('span', { ref: anchor, style: { display: 'none' }, 'data-geo-ui': 'anchor' });
        }

        return h('div', { ref: anchor, className: 'geo-settings', 'data-geo-ui': 'settings', style: { display: 'inline-flex', gap: '6px' } },
          mode.fields.map(function (field) {
            return h(Picker, {
              key: field.key,
              label: field.label,
              options: field.options,
              value: state.values[field.key],
              onChange: function (value) { changeValue(store, field.key, value); }
            });
          })
        );
      };
    }

    // ── 工具行右侧：功能选择器（conversation.input.right，紧邻模型选择器）──
    function createFunctionSelector(store) {
      const Picker = createPicker();
      return function FunctionSelector(props) {
        const preset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined;
        const state = useStore(store);
        const mode = modeOf(state.active);

        const inputState = typeof props.useInput === 'function' ? props.useInput(identitySelector) : null;
        const draftNow = inputState && typeof inputState.draft === 'string'
          ? inputState.draft
          : (props.input && typeof props.input.draft === 'string' ? props.input.draft : null);
        React.useEffect(function () {
          if (draftNow !== null) store.set({ lastDraft: draftNow });
          if (props.inputActions && !store.get().inputActions) store.set({ inputActions: props.inputActions });
        }, [draftNow, preset]);

        if (preset !== PRESET_ID) return null;

        return h('div', { className: 'geo-fn', 'data-geo-ui': 'function-selector', style: { display: 'inline-flex' } },
          h(Picker, {
            align: 'right',
            title: '功能',
            leadingIcon: mode.id,
            options: MODES.map(function (item) { return { value: item.id, label: item.name, icon: item.id }; }),
            value: state.active,
            display: mode.name,
            onChange: function (value) { switchMode(store, value); }
          })
        );
      };
    }

    // ── 插件本体 ────────────────────────────────────────────────────────
    return {
      name: 'geo-teacher-ui-client',
      inject: ['slots'],
      apply: function (ctx) {
        ensureStyles();
        const store = createStore();
        const Settings = createSettings(store);
        const FunctionSelector = createFunctionSelector(store);

        // 工具行左侧：功能设置（并负责把当前功能的提示写进原生输入框）
        ctx.effect(function () {
          const dispose = ctx.slots.inject('conversation.input.left', function () {
            return ctx.slots.register(
              { name: 'conversation.input.left', id: 'geo-teacher-ui-settings', order: 10, label: '功能设置' },
              Settings
            );
          });
          return function () { if (typeof dispose === 'function') dispose(); };
        }, 'geo-teacher-ui:settings');

        // 工具行右侧：功能选择器（在模型选择器左侧）
        ctx.effect(function () {
          const dispose = ctx.slots.inject('conversation.input.right', function () {
            return ctx.slots.register(
              { name: 'conversation.input.right', id: 'geo-teacher-ui-function', order: 10, label: '功能选择' },
              FunctionSelector
            );
          });
          return function () { if (typeof dispose === 'function') dispose(); };
        }, 'geo-teacher-ui:function');

        ctx.effect(function () {
          return function () {
            removeStyles();
          };
        }, 'geo-teacher-ui:cleanup');
      }
    };
  }
});
