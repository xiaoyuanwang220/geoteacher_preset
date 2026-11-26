// geo-edu / dsh-geo-teacher-ui —— 客户端半边
//
// 落点（均为 list，零遮蔽）：
//   · conversation.input.left（工具行左侧）
//       → 按当前功能切换的参数下拉：讲题（讲解对象）｜课程方案（年级 + 时间）
//   · conversation.input.right（工具行右侧，紧邻原生模型选择器左侧）
//       → 功能选择器（讲题／课程方案）
//
// 参数送达 Agent 机制（不污染原生输入框、不冲掉 @文件 引用胶囊）：
//   · 按 sessionId 独立维护会话选择状态（未绑定会话前的选择在建会话时自动继承）；
//   · 会话挂载及每次切换功能或参数时，立即向同源宿主路由 POST /geo-teacher-ui/state
//     同步 `{ sessionId, preset, active, values }`；
//   · 宿主半边（index.js）经 `systemPrompt.context` 在每轮请求准入（refreshContext）时
//     将当前选定参数动态注入模型运行时上下文。
//
// 打包：普通脚本 + window.__ModuleLoader__.load({id, factory})；纯 JS、零构建。
// 样式：手工注入 <style>，类名 geo- 前缀，颜色只走 --dsw-alias-* 令牌。

window.__ModuleLoader__.load({
  id: 'geospark-ai-ui',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PRESET_ID = 'geo-teacher';
    const STYLE_ID = 'geo-teacher-ui-styles';
    const STATE_ENDPOINT = '/geo-teacher-ui/state';

    // ── 图标（Phosphor regular 线条）────────────────────────────────────
    const ICONS = {
      explain: 'M232,48H160a40,40,0,0,0-32,16A40,40,0,0,0,96,48H24a8,8,0,0,0-8,8V200a8,8,0,0,0,8,8H96a24,24,0,0,1,24,24,8,8,0,0,0,16,0,24,24,0,0,1,24-24h72a8,8,0,0,0,8-8V56A8,8,0,0,0,232,48ZM96,192H32V64H96a24,24,0,0,1,24,24V200A39.81,39.81,0,0,0,96,192Zm128,0H160a39.81,39.81,0,0,0-24,8V88a24,24,0,0,1,24-24h64Z',
      lesson: 'M251.76,88.94l-120-64a8,8,0,0,0-7.52,0l-120,64a8,8,0,0,0,0,14.12L32,117.87v48.42a15.91,15.91,0,0,0,4.06,10.65C49.16,191.53,78.51,216,128,216a130,130,0,0,0,48-8.76V240a8,8,0,0,0,16,0V199.51a115.63,115.63,0,0,0,27.94-22.57A15.91,15.91,0,0,0,224,166.29V117.87l27.76-14.81a8,8,0,0,0,0-14.12ZM128,200c-43.27,0-68.72-21.14-80-33.71V126.4l76.24,40.66a8,8,0,0,0,7.52,0L176,143.47v46.34C163.4,195.69,147.52,200,128,200Zm80-33.75a97.83,97.83,0,0,1-16,14.25V134.93l16-8.53ZM188,118.94l-.22-.13-56-29.87a8,8,0,0,0-7.52,14.12L171,128l-43,22.93L25,96,128,41.07,231,96Z',
      caretDown: 'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z',
      check: 'M232.49,80.49l-128,128a12,12,0,0,1-17,0l-56-56a12,12,0,1,1,17-17L96,183,215.51,63.51a12,12,0,0,1,17,17Z'
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

    // ── 双功能定义（出题功能正进行方向重构，输入区仅开放讲题与课程方案）──
    const MODES = [
      {
        id: 'explain',
        name: '讲题',
        placeholder: '请输入年份、省份和题号，例如：2025年广东卷第10题。',
        helper: '可补充需要重点讲解的考点或具体疑问。',
        fields: [{ key: 'audience', label: '讲解对象', options: ['学生', '教师', '命题人'] }]
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

    // 讲题对象默认取「学生」，与 geo-teacher 预设 persona「默认 student」一致。
    const INITIAL_VALUES = { audience: '学生', grade: '高一', duration: '45分钟' };

    function modeOf(id) {
      for (let i = 0; i < MODES.length; i += 1) if (MODES[i].id === id) return MODES[i];
      return MODES[0];
    }

    function cloneSelection(entry) {
      const base = entry || { active: 'explain', values: INITIAL_VALUES };
      return {
        active: modeOf(base.active).id,
        values: Object.assign({}, INITIAL_VALUES, base.values || {})
      };
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
      if (typeof document === 'undefined' || !document.head) return;
      if (document.getElementById(STYLE_ID)) return;
      const tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function removeStyles() {
      if (typeof document === 'undefined') return;
      const tag = document.getElementById(STYLE_ID);
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
    }

    // ── 按会话隔离的状态与宿主同步 ────────────────────────────────────────
    function selectionSignature(preset, entry) {
      if (preset !== PRESET_ID) return 'off:' + String(preset || '');
      const v = entry.values || INITIAL_VALUES;
      return [PRESET_ID, entry.active, v.audience, v.grade, v.duration].join('|');
    }

    function postSelectionToHost(sessionId, preset, entry, syncedMap) {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!sid || typeof fetch !== 'function') return;
      const sig = selectionSignature(preset, entry);
      if (syncedMap[sid] === sig) return;
      syncedMap[sid] = sig;
      const payload = preset === PRESET_ID
        ? { sessionId: sid, preset: PRESET_ID, active: entry.active, values: entry.values }
        : { sessionId: sid, preset: String(preset || '') };
      Promise.resolve(fetch(STATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify(payload)
      })).then(function (res) {
        if (!res || !res.ok) delete syncedMap[sid];
      }).catch(function (err) {
        delete syncedMap[sid];
        console.warn('geo-teacher-ui: 同步选项到宿主失败', err);
      });
    }

    function createStore() {
      let fallback = cloneSelection(null);
      const bySession = {};
      const synced = {};
      let revision = 0;
      const listeners = new Set();

      function notify() {
        revision += 1;
        listeners.forEach(function (listener) { listener(); });
      }

      return {
        getRevision: function () { return revision; },
        getForSession: function (sessionId) {
          const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
          if (!sid) return fallback;
          if (!bySession[sid]) bySession[sid] = cloneSelection(fallback);
          return bySession[sid];
        },
        switchMode: function (sessionId, preset, nextId) {
          const targetMode = modeOf(nextId).id;
          const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
          const current = sid ? (bySession[sid] || cloneSelection(fallback)) : fallback;
          const next = { active: targetMode, values: Object.assign({}, current.values) };
          fallback = cloneSelection(next);
          if (sid) {
            bySession[sid] = next;
            delete synced[sid];
            postSelectionToHost(sid, preset, next, synced);
          }
          notify();
        },
        changeValue: function (sessionId, preset, key, value) {
          const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
          const current = sid ? (bySession[sid] || cloneSelection(fallback)) : fallback;
          const nextValues = Object.assign({}, current.values);
          nextValues[key] = value;
          const next = { active: current.active, values: nextValues };
          fallback = cloneSelection(next);
          if (sid) {
            bySession[sid] = next;
            delete synced[sid];
            postSelectionToHost(sid, preset, next, synced);
          }
          notify();
        },
        syncSession: function (sessionId, preset) {
          const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
          if (!sid) return;
          const entry = bySession[sid] || (bySession[sid] = cloneSelection(fallback));
          postSelectionToHost(sid, preset, entry, synced);
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        }
      };
    }

    function useSessionSelection(store, sessionId) {
      const pair = React.useState(store.getRevision());
      const setRev = pair[1];
      React.useEffect(function () {
        return store.subscribe(function () { setRev(store.getRevision()); });
      }, []);
      return store.getForSession(sessionId);
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

    // 原生输入框的 placeholder 由宿主持有，插件没有可改它的 API。要"把提示放进原对话框"，
    // 只能就地改写原生编辑器的提示属性/文本，并在退出本预设/卸载时还原。
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

    function placeholderFor(mode) {
      return mode.placeholder + '\n' + mode.helper;
    }

    // ── 工具行左侧：按功能切换的参数设置（conversation.input.left）────────
    function createSettings(store) {
      const Picker = createPicker();
      return function Settings(props) {
        const sessionId = props.sessionId;
        const preset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined;
        const selection = useSessionSelection(store, sessionId);
        const mode = modeOf(selection.active);
        const anchor = React.useRef(null);

        React.useEffect(function () {
          store.syncSession(sessionId, preset);
        }, [sessionId, preset, selection.active, selection.values.audience, selection.values.grade, selection.values.duration]);

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

        // hero 文案替换：仅在本预设生效；退出本预设或卸载时还原
        React.useEffect(function () {
          const el = anchor.current;
          if (!el) return undefined;

          const apply = function () {
            let root = el;
            for (let i = 0; i < 6 && root.parentElement; i += 1) root = root.parentElement;
            let headlineHits = findLeafByText(root, BRAND_HEADLINE_FROM);
            let badgeHits = findLeafByText(root, BRAND_BADGE_FROM);
            let usedRoot = 'local';
            if (!headlineHits.length && !badgeHits.length && typeof document !== 'undefined' && document.body) {
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
            if (typeof document === 'undefined') return;
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

        if (preset !== PRESET_ID) {
          return h('span', { ref: anchor, style: { display: 'none' }, 'data-geo-ui': 'anchor' });
        }

        return h('div', { ref: anchor, className: 'geo-settings', 'data-geo-ui': 'settings', style: { display: 'inline-flex', gap: '6px' } },
          mode.fields.map(function (field) {
            return h(Picker, {
              key: field.key,
              label: field.label,
              options: field.options,
              value: selection.values[field.key],
              onChange: function (value) { store.changeValue(sessionId, preset, field.key, value); }
            });
          })
        );
      };
    }

    // ── 工具行右侧：功能选择器（conversation.input.right，紧邻模型选择器）──
    function createFunctionSelector(store) {
      const Picker = createPicker();
      return function FunctionSelector(props) {
        const sessionId = props.sessionId;
        const preset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined;
        const selection = useSessionSelection(store, sessionId);
        const mode = modeOf(selection.active);

        React.useEffect(function () {
          store.syncSession(sessionId, preset);
        }, [sessionId, preset, selection.active, selection.values.audience, selection.values.grade, selection.values.duration]);

        if (preset !== PRESET_ID) return null;

        return h('div', { className: 'geo-fn', 'data-geo-ui': 'function-selector', style: { display: 'inline-flex' } },
          h(Picker, {
            align: 'right',
            title: '功能',
            leadingIcon: mode.id,
            options: MODES.map(function (item) { return { value: item.id, label: item.name, icon: item.id }; }),
            value: selection.active,
            display: mode.name,
            onChange: function (value) { store.switchMode(sessionId, preset, value); }
          })
        );
      };
    }

    // ── 插件本体 ────────────────────────────────────────────────────────
    return {
      name: 'geo-teacher-ui-client',
      inject: ['slots'],
      MODES: MODES,
      INITIAL_VALUES: INITIAL_VALUES,
      createStore: createStore,
      apply: function (ctx) {
        ensureStyles();
        const store = createStore();
        const Settings = createSettings(store);
        const FunctionSelector = createFunctionSelector(store);

        ctx.effect(function () {
          const dispose = ctx.slots.inject('conversation.input.left', function () {
            return ctx.slots.register(
              { name: 'conversation.input.left', id: 'geo-teacher-ui-settings', order: 10, label: '功能设置' },
              Settings
            );
          });
          return function () { if (typeof dispose === 'function') dispose(); };
        }, 'geo-teacher-ui:settings');

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
