/*
 * ModelCheck · 客户端面板（client.js）
 *
 * 形态：普通脚本 + window.__ModuleLoader__.load({id, factory})，纯 JS、零构建、无 JSX。
 * 落点：conversation.view（list / session 作用域）注册一条「建模判定」页签，
 *        与 聊天 / 轨迹 并列；只在会话身份存在时渲染内容。
 *
 * 真相归属：宿主半边（index.js + server/*）拥有一切判定与存储；本面板只做
 *   · 读取：status / criteria/list / components/list / annotations/list / report/latest
 *   · 写入：annotations/create → annotations/send（幂等）、annotations/withdraw、
 *           annotations/accept（人工验收）、contract/confirm（只由真实用户点击）、
 *           evidence/submit（把 bridge 采集的运行时证据回填）
 *   · 预览：iframe 指向 /modelcheck/preview/<sessionId>/<entry>?__VERIFY__=1&v=<ts>，
 *           与注入的 assets/bridge.js 用 postMessage 通信（严格校验 iframe.contentWindow、
 *           同源、channel、类型白名单、1 MiB 上限、requestId 关联）。
 *
 * 交付版剥离（规格 §8.6）：预览、标注、验证入口只存在于本面板；模型页只在
 * __VERIFY__=1 时被注入 bridge。项目未初始化 .modelcheck 或接口不可用时，面板只渲染
 * 一条紧凑的待命说明，不提供任何验收入口，也绝不抛异常。
 *
 * 样式：手写 <style>（类名 mc- 前缀），颜色只走 --dsw-alias-* 主题令牌，浅/深色自适应。
 * 约束：除本 loader 调用外不写 window 全局；不 require 其它 Harness 客户端包（只用 react）。
 */
window.__ModuleLoader__.load({
  id: '@geo-edu/dsh-modelcheck',
  factory: function (require) {
    var React = require('react');
    var h = React.createElement;

    // ── 常量 ────────────────────────────────────────────────────────────────
    var STYLE_ID = 'dsh-modelcheck-panel-styles';
    var SLOT = 'conversation.view';
    var API_PATH = '/modelcheck/api';
    var PREVIEW_PREFIX = '/modelcheck/preview';
    var CHANNEL = 'modelcheck';
    var MAX_MESSAGE_CHARS = 1024 * 1024; // 单条消息 ≤ 1 MiB（与宿主和 bridge 同口径）
    var STATUS_POLL_MS = 5000;
    var EVIDENCE_WAIT_MS = 10000;
    var EVIDENCE_TIMEOUT_MS = 8000;
    var SCREENSHOT_TIMEOUT_MS = 2500;
    var MAX_PENDING_ITEMS = 50;
    var MAX_ITEM_TEXT = 4000;
    var ADAPTER_VERSION = 'modelcheck-adapter/1';

    var TABS = [
      { id: 'verdict', label: '判定' },
      { id: 'annotate', label: '标注' },
      { id: 'requests', label: '请求' },
      { id: 'report', label: '报告' }
    ];

    var STATUS_LABELS = {
      pass: '通过',
      fail: '未通过',
      inconclusive: '无法判定',
      stale: '证据失效',
      unverified: '未验证'
    };

    var REQUEST_STATE_LABELS = {
      draft: '草稿',
      sent: '已发送',
      triaged: '已整理',
      editing: '修改中',
      review: '待验收',
      closed: '已关闭',
      withdrawn: '已撤回'
    };

    var REQUEST_STATES = ['draft', 'sent', 'triaged', 'editing', 'review', 'closed', 'withdrawn'];

    var ROUTE_LABELS = { three: 'Three.js', svg: 'SVG', dom: 'DOM', image: '图片' };

    var INBOUND_TYPES = {
      'mc:ready': true,
      'mc:evidence': true,
      'mc:pick': true,
      'mc:error': true,
      'mc:screenshot': true
    };

    // ── 样式（只使用主题令牌，类名 mc- 前缀）────────────────────────────────
    var CSS = [
      '.mc-panel{display:flex;flex-direction:column;height:100%;min-height:320px;color:var(--dsw-alias-label-primary);',
      'font-size:13px;line-height:1.5;background:var(--dsw-alias-bg-base)}',

      /* 头部 */
      '.mc-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;padding:10px 16px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mc-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40%}',
      '.mc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mc-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:18px;white-space:nowrap}',
      '.mc-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
      '.mc-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}',
      '.mc-header-actions{margin-left:auto;display:flex;align-items:center;gap:8px}',

      /* 契约待确认条 */
      '.mc-proposal{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 16px;font-size:12.5px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);',
      'background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}',
      '.mc-proposal strong{font-weight:600}',

      /* 页签 */
      '.mc-tabs{display:flex;align-items:center;gap:2px;flex:none;padding:6px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mc-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);',
      'font:inherit;font-size:13px;padding:6px 10px 8px;border-radius:8px 8px 0 0;cursor:pointer;',
      'border-bottom:2px solid transparent;display:inline-flex;align-items:center;gap:6px}',
      '.mc-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mc-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600;',
      'border-bottom-color:var(--dsw-alias-brand-primary)}',
      '.mc-tab:focus-visible,.mc-btn:focus-visible,.mc-input:focus-visible,.mc-textarea:focus-visible{',
      'outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.mc-tab-count{min-width:16px;padding:0 5px;border-radius:999px;font-size:11px;line-height:16px;',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);',
      'color:var(--dsw-alias-label-primary);text-align:center}',

      /* 主体 */
      '.mc-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 24px}',
      '.mc-body-fixed{overflow:hidden;display:flex;flex-direction:column}',
      '.mc-hint{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mc-empty{padding:24px 12px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12.5px}',
      '.mc-inert{display:flex;flex-direction:column;gap:6px;padding:16px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}',
      '.mc-inert-title{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}',

      /* 汇总 */
      '.mc-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
      '.mc-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;',
      'color:var(--dsw-alias-label-secondary)}',
      '.mc-chip b{color:var(--dsw-alias-label-primary);font-weight:600}',

      /* 判定表 */
      '.mc-table-wrap{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:auto}',
      '.mc-table{width:100%;border-collapse:collapse;font-size:12.5px}',
      '.mc-table th,.mc-table td{padding:7px 10px;text-align:left;vertical-align:top;',
      'border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mc-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);',
      'font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-size:12px}',
      '.mc-table tr:last-child td{border-bottom:0}',
      '.mc-table td.mc-col-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:nowrap}',
      '.mc-table td.mc-col-nowrap{white-space:nowrap}',
      '.mc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.mc-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:2px}',
      '.mc-status-pass{color:var(--dsw-alias-state-success-primary);font-weight:600}',
      '.mc-status-fail{color:var(--dsw-alias-state-error-primary);font-weight:600}',
      '.mc-status-stale,.mc-status-inconclusive{color:var(--dsw-alias-state-warn-primary);font-weight:600}',
      '.mc-status-unverified{color:var(--dsw-alias-label-secondary);font-weight:600}',

      /* 按钮 / 输入 */
      '.mc-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;',
      'height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap}',
      '.mc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mc-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.mc-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-bg-base);border-color:transparent}',
      '.mc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-bg-base)}',
      '.mc-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}',
      '.mc-btn-ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.mc-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.mc-btn[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}',
      '.mc-btn-sm{height:24px;padding:0 8px;font-size:12px}',
      '.mc-input,.mc-textarea{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;resize:vertical;min-height:64px}',
      '.mc-input-sm{min-height:36px;padding:5px 8px}',

      /* 标注页布局 */
      '.mc-annotate{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;flex:1;min-height:0}',
      '@media (min-width:1100px){.mc-annotate{grid-template-columns:minmax(0,1fr) 340px}}',
      '.mc-preview-pane{display:flex;flex-direction:column;min-height:0;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2)}',
      '.mc-preview-bar{display:flex;align-items:center;gap:8px;flex:none;padding:6px 8px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px;',
      'color:var(--dsw-alias-label-secondary);flex-wrap:wrap}',
      '.mc-preview-frame{position:relative;flex:1;min-height:260px;background:var(--dsw-alias-bg-layer-2)}',
      '.mc-preview-frame iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:var(--dsw-alias-bg-base)}',
      '.mc-preview-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
      'color:var(--dsw-alias-label-secondary);font-size:12px;pointer-events:none}',
      '.mc-side{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding-right:2px}',
      '.mc-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px}',
      '.mc-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;',
      'font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mc-field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}',
      '.mc-field-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.mc-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;font-size:12px;margin:0}',
      '.mc-kv dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.mc-kv dd{margin:0;min-width:0;word-break:break-word;color:var(--dsw-alias-label-primary)}',
      '.mc-item-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
      '.mc-item{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.mc-item-head{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}',
      '.mc-item-name{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-word}',
      '.mc-item-text{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;font-size:12.5px;color:var(--dsw-alias-label-primary)}',
      '.mc-item-actions{display:flex;gap:4px;flex:none}',
      '.mc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mc-spacer{flex:1}',
      '.mc-notice{margin:8px 0 0;padding:8px 10px;border-radius:8px;font-size:12.5px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mc-notice-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.mc-notice-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}',

      /* 请求 / 报告 */
      '.mc-request{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px;margin-bottom:10px;',
      'background:var(--dsw-alias-bg-layer-1)}',
      '.mc-request-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}',
      '.mc-request-id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;font-weight:600}',
      '.mc-steps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin:4px 0 8px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.mc-step{padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1)}',
      '.mc-step-current{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.mc-pre{margin:0;padding:10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;',
      'line-height:1.6;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'max-height:60vh;overflow:auto}',
      '.mc-link-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px}',

      /* 初始化 / 切换项目（init/scan → init/apply | project/select） */
      '.mc-init-slot{flex:none;padding:10px 16px 0}',
      '.mc-init{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}',
      '.mc-init-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}',
      '.mc-init-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.mc-init-note{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.mc-candidates{display:flex;flex-direction:column;gap:6px;margin:8px 0}',
      '.mc-candidate{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer}',
      '.mc-candidate[data-selected="true"]{border-color:var(--dsw-alias-brand-primary);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
      '.mc-candidate input[type="radio"]{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);flex:none}',
      '.mc-candidate-body{min-width:0;display:flex;flex-direction:column;gap:2px;flex:1}',
      '.mc-candidate-name{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mc-list-plain{margin:4px 0 0;padding-left:18px;display:flex;flex-direction:column;gap:2px;font-size:12px;',
      'color:var(--dsw-alias-label-primary)}',
      '.mc-init-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}',

      /* P1：几何单元树 / 接入就绪 */
      '.mc-readiness{flex:none;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.mc-unit-group{margin:2px 0}',
      '.mc-unit-group>summary{cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-primary);padding:3px 0}',
      '.mc-unit-sub{margin:4px 0 0 14px}',
      '.mc-unit-sub>summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mc-unit-pick{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    ].join('');

    function ensureStyles() {
      if (document.getElementById(STYLE_ID)) return;
      var tag = document.createElement('style');
      tag.id = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function removeStyles() {
      var tag = document.getElementById(STYLE_ID);
      if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
    }

    // ── 通用小工具 ──────────────────────────────────────────────────────────
    function isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    function isFiniteNumber(value) {
      return typeof value === 'number' && isFinite(value);
    }

    function safeString(value, maxLength) {
      if (typeof value !== 'string') return null;
      var text = value.trim();
      if (!text) return null;
      var limit = isFiniteNumber(maxLength) ? maxLength : 400;
      return text.length > limit ? text.slice(0, limit) : text;
    }

    function uid(prefix) {
      return (prefix || 'mc') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function formatTime(value) {
      try {
        if (!value) return '';
        var date = new Date(value);
        if (isNaN(date.getTime())) return String(value);
        return date.toLocaleString('zh-CN', { hour12: false });
      } catch (error) {
        return String(value);
      }
    }

    function shortJson(value) {
      if (value === null || value === undefined) return '';
      try {
        if (typeof value === 'string') return value;
        var text = JSON.stringify(value);
        if (typeof text !== 'string') return String(value);
        return text.length > 240 ? text.slice(0, 240) + '…' : text;
      } catch (error) {
        return String(value);
      }
    }

    function requestApi(action, sessionId, payload, signal) {
      var body = {};
      if (isPlainObject(payload)) {
        Object.keys(payload).forEach(function (key) { body[key] = payload[key]; });
      }
      body.action = action;
      body.sessionId = sessionId;
      var options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(body)
      };
      if (signal) options.signal = signal;
      return fetch(API_PATH, options).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          return { ok: response.ok && !(data && data.ok === false), http: response.status, data: data };
        });
      }).catch(function (error) {
        return { ok: false, http: 0, data: null, error: error };
      });
    }

    function describeApiError(result) {
      if (!result) return '未知错误';
      if (result.error) return '网络请求失败（' + String(result.error.message || result.error) + '）';
      var data = result.data;
      if (data && data.error) {
        if (typeof data.error === 'string') return data.error;
        var parts = [];
        if (data.error.code) parts.push(data.error.code);
        if (data.error.message) parts.push(data.error.message);
        if (parts.length) return parts.join('：');
      }
      if (data && typeof data.reason === 'string' && data.reason) return data.reason;
      if (data && typeof data.message === 'string' && data.message) return data.message;
      return 'HTTP ' + (result.http || 0);
    }

    // init/* 的错误对象：宿主的 errorBody 会把 extra 展开在 error 里（如 409 的 error.candidates）。
    function readInitApiError(result) {
      var data = result && result.data;
      var error = data && data.error;
      var info = { http: (result && result.http) || 0, code: null, message: null, candidates: null };
      if (isPlainObject(error)) {
        info.code = safeString(error.code, 80);
        info.message = safeString(error.message, 600);
        if (Array.isArray(error.candidates)) info.candidates = error.candidates;
      } else if (typeof error === 'string') {
        info.message = safeString(error, 600);
      }
      if (!info.code && (info.http === 401 || info.http === 403)) info.code = 'unauthorized';
      if (!info.message) {
        if (info.code === 'unauthorized') {
          info.message = '读取失败：浏览器会话未被宿主接纳（HTTP ' + info.http + '），请刷新页面后重试。';
        } else if (info.http === 404) {
          info.message = '未找到可初始化的模型项目。';
        } else if (info.http === 409) {
          info.message = '工作区里有多个候选项目，请选择其中一个。';
        } else {
          info.message = '请求失败（HTTP ' + info.http + '）';
        }
      }
      return info;
    }

    // .modelcheck 是否“真的初始化好了”：空目录、半成品、坏 JSON 都不算 ready。
    // 兼容旧宿主：只有 hasModelcheck 时按 ready/none 归类。
    function readModelcheckInfo(source) {
      var raw = source && isPlainObject(source.modelcheck) ? source.modelcheck : null;
      var state = raw && typeof raw.state === 'string' ? raw.state : null;
      if (state !== 'none' && state !== 'empty' && state !== 'partial' && state !== 'ready') {
        state = source && source.hasModelcheck === true ? 'ready' : 'none';
      }
      var files = raw && Array.isArray(raw.files)
        ? raw.files.filter(function (item) { return typeof item === 'string' && item; })
        : [];
      var missing = raw && Array.isArray(raw.missing)
        ? raw.missing.filter(function (item) { return typeof item === 'string' && item; })
        : [];
      var issues = raw && Array.isArray(raw.issues)
        ? raw.issues.filter(function (item) { return typeof item === 'string' && item; })
        : [];
      return {
        state: state,
        dirExists: !!(raw && raw.dirExists === true) || state !== 'none',
        empty: !!(raw && raw.empty === true) || state === 'empty',
        files: files,
        missing: missing,
        componentsCount: raw && isFiniteNumber(raw.componentsCount) ? raw.componentsCount : null,
        contractStatus: raw && typeof raw.contractStatus === 'string' ? raw.contractStatus : null,
        issues: issues
      };
    }

    function modelcheckStateLabel(info) {
      if (!info) return '未初始化';
      if (info.state === 'ready') return '已初始化';
      if (info.state === 'empty') return '空目录（无文件）';
      if (info.state === 'partial') {
        return info.missing.length > 0
          ? '部分初始化（缺 ' + info.missing.join('、') + '）'
          : '部分初始化';
      }
      return '未初始化';
    }

    function modelcheckStateBadgeClass(info) {
      if (info && info.state === 'ready') return ' mc-badge-ok';
      return ' mc-badge-warn';
    }

    function modelcheckStateTitle(info) {
      if (!info) return undefined;
      var lines = [];
      if (info.files.length > 0) lines.push('.modelcheck 文件：' + info.files.join('、'));
      else if (info.state === 'empty') lines.push('.modelcheck 目录存在，但里面没有任何文件');
      if (info.missing.length > 0) lines.push('缺失/无效：' + info.missing.join('、'));
      if (info.issues.length > 0) lines.push('问题：' + info.issues.join('；'));
      if (info.contractStatus) lines.push('契约状态：' + info.contractStatus);
      if (info.componentsCount !== null) lines.push('已登记组件：' + info.componentsCount);
      return lines.length > 0 ? lines.join('\n') : undefined;
    }

    // 空 / 半初始化的 .modelcheck 需要“补齐”，与全新初始化走同一个 init/apply。
    function modelcheckNeedsFill(info) {
      return !!info && (info.state === 'empty' || info.state === 'partial');
    }

    // P1：几何单元标识与 kind 分组（点选只针对模型几何，不针对标签/控件）。
    var KIND_LABELS = {
      structure: '结构',
      cell: '环流圈',
      belt: '气压带风带',
      arrow: '箭头',
      'image-region': '图像区域',
      region: '区域'
    };
    var KIND_ORDER = ['structure', 'cell', 'belt', 'arrow', 'image-region', 'region'];

    function kindLabelOf(kind) {
      return KIND_LABELS[kind] || '其它';
    }

    function unitSelectionId(componentId, partKey, instanceKey) {
      if (!componentId) return null;
      if (partKey) return componentId + '#' + partKey;
      if (instanceKey) return componentId + '#' + instanceKey;
      return componentId;
    }

    function readReadiness(source) {
      if (!isPlainObject(source)) return null;
      var readiness = isPlainObject(source.readiness) ? source.readiness : null;
      if (!readiness && typeof source.status === 'string' && source.status === 'blocked') {
        return {
          blocked: true,
          reason: safeString(source.reason, 500),
          remedy: safeString(source.remedy, 500),
          checks: Array.isArray(source.checks) ? source.checks : [],
          nextActions: Array.isArray(source.nextActions) ? source.nextActions : []
        };
      }
      return readiness;
    }

    function readProject(data) {
      return (data && isPlainObject(data.project)) ? data.project : {};
    }

    function readProjectId(data) {
      return safeString(readProject(data).projectId, 120);
    }

    function readRoute(data) {
      var route = safeString(readProject(data).route, 16);
      return route && ROUTE_LABELS[route] !== undefined ? route : null;
    }

    function readPreviewEntry(data) {
      var project = readProject(data);
      var preview = isPlainObject(project.preview) ? project.preview : {};
      return safeString(project.previewEntry, 300) || safeString(preview.entry, 300) || '';
    }

    function readUnitToPx(data) {
      var project = readProject(data);
      var preview = isPlainObject(project.preview) ? project.preview : {};
      var value = project.unitToPx;
      if (!isFiniteNumber(value) && isFiniteNumber(preview.unitToPx)) value = preview.unitToPx;
      if (!isFiniteNumber(value) && data && isFiniteNumber(data.unitToPx)) value = data.unitToPx;
      return isFiniteNumber(value) && value > 0 ? value : 1;
    }

    function readHashes(data) {
      var hashes = { buildHash: null, sourceHash: null };
      if (!data) return hashes;
      var project = readProject(data);
      var preview = isPlainObject(project.preview) ? project.preview : {};
      var candidates = [data.hashes, data.evidenceBuild, project.hashes, preview.hashes];
      candidates.forEach(function (candidate) {
        if (!isPlainObject(candidate)) return;
        if (!hashes.buildHash) hashes.buildHash = safeString(candidate.buildHash, 200);
        if (!hashes.sourceHash) hashes.sourceHash = safeString(candidate.sourceHash, 200);
      });
      if (!hashes.buildHash) hashes.buildHash = safeString(project.buildHash, 200);
      return hashes;
    }

    function readContract(data) {
      return (data && isPlainObject(data.contract)) ? data.contract : {};
    }

    function readCertification(data) {
      if (data && isPlainObject(data.certification)) return data.certification;
      if (data && isPlainObject(data.completion)) return data.completion;
      return {};
    }

    function readProposedHash(data) {
      var contract = readContract(data);
      var hash = safeString(contract.proposedHash, 200);
      if (hash) return hash;
      if (isPlainObject(contract.proposed)) {
        hash = safeString(contract.proposed.contentHash, 200);
        if (hash) return hash;
        if (isPlainObject(contract.proposed.contract)) {
          hash = safeString(contract.proposed.contract.contentHash, 200);
          if (hash) return hash;
        }
      }
      return null;
    }

    function hasProposal(data) {
      var contract = readContract(data);
      if (contract.proposed === true) return true;
      if (isPlainObject(contract.proposed) || typeof contract.proposed === 'string') return true;
      return !!readProposedHash(data);
    }

    function buildPreviewUrl(sessionId, entry, version) {
      // base 末尾已带 '/'；entry 为空时命中宿主的「空路径即预览入口」规则。
      var base = PREVIEW_PREFIX + '/' + encodeURIComponent(sessionId) + '/';
      var path = '';
      if (entry) {
        path = String(entry).split('/').filter(function (segment) { return segment.length > 0; })
          .map(function (segment) { return encodeURIComponent(segment); }).join('/');
      }
      return base + path + '?__VERIFY__=1&v=' + encodeURIComponent(String(version || Date.now()));
    }

    function summarizeCriteria(list) {
      var counts = { total: 0, pass: 0, fail: 0, inconclusive: 0, stale: 0, unverified: 0, blockingOpen: 0 };
      (Array.isArray(list) ? list : []).forEach(function (criterion) {
        counts.total += 1;
        var status = criterion && criterion.status;
        if (typeof status === 'string' && counts[status] !== undefined) counts[status] += 1;
        else counts.unverified += 1;
        if (criterion && criterion.blocking && status !== 'pass') counts.blockingOpen += 1;
      });
      return counts;
    }

    function criterionLocation(criterion) {
      if (!criterion) return '';
      var parts = [];
      var source = isPlainObject(criterion.source) ? criterion.source : {};
      var doc = safeString(source.doc, 200);
      var section = safeString(source.section, 80);
      if (doc) parts.push(section ? doc + ' ' + section : doc);
      if (isFiniteNumber(source.line)) parts.push('L' + source.line);
      if (criterion.evidenceKind) parts.push('证据：' + String(criterion.evidenceKind));
      if (criterion.capturedAt) parts.push(formatTime(criterion.capturedAt));
      var artifacts = [];
      if (Array.isArray(criterion.artifacts)) artifacts = criterion.artifacts;
      else if (criterion.evidence && Array.isArray(criterion.evidence.artifacts)) artifacts = criterion.evidence.artifacts;
      artifacts.forEach(function (artifact) {
        if (typeof artifact === 'string') parts.push(artifact);
        else if (artifact && (artifact.name || artifact.path || artifact.hash)) parts.push(String(artifact.name || artifact.path || artifact.hash));
      });
      return parts.join(' · ');
    }

    function readMeasured(criterion) {
      if (!criterion) return '';
      var measured = criterion.measured;
      if (measured === null || measured === undefined) return '';
      return shortJson(measured);
    }

    function readAssertion(criterion) {
      if (!criterion) return '';
      return safeString(criterion.assertion, 400) || safeString(criterion.claim, 400) || '';
    }

    function composeComponentLabel(componentId, component, fallback) {
      if (component && safeString(component.label, 200)) return safeString(component.label, 200);
      var text = safeString(fallback, 200);
      if (text && text !== componentId) return text;
      return componentId || '未命名组件';
    }

    function locateText(locator) {
      if (!isPlainObject(locator)) return '';
      var file = safeString(locator.file, 300);
      if (!file) return '';
      var symbol = safeString(locator.symbol, 120);
      var parts = [file];
      if (symbol) parts.push(symbol);
      if (isFiniteNumber(locator.line)) parts.push('L' + locator.line);
      return parts.join(':');
    }

    // 取证产物链接：宿主提供 /modelcheck/artifact/<sessionId>/<name>，
    // 只接受 artifacts 目录下的文件名（去掉任何目录前缀）。
    function artifactHref(base, value) {
      var text = typeof value === 'string' ? value : String((value && (value.name || value.path)) || '');
      if (!text) return null;
      var normalized = text.replace(/\\/g, '/');
      var slash = normalized.lastIndexOf('/');
      var file = slash >= 0 ? normalized.slice(slash + 1) : normalized;
      if (!file) return null;
      var prefix = typeof base === 'string' && base ? base : '';
      if (!prefix) return null;
      if (prefix.charAt(prefix.length - 1) !== '/') prefix += '/';
      return prefix + encodeURIComponent(file);
    }

    // ── 面板组件 ────────────────────────────────────────────────────────────
    function ModelCheckPanel(props) {
      var sessionPropId = typeof props.sessionId === 'string' ? props.sessionId : '';
      var sessionSnapshot = typeof props.useSession === 'function'
        ? props.useSession(function (value) { return value; })
        : null;
      var sessionId = sessionPropId || (sessionSnapshot && (sessionSnapshot.id || sessionSnapshot.sessionId)) || '';

      var instanceId = React.useRef(uid('mc-panel'));
      var mountedRef = React.useRef(true);
      var iframeRef = React.useRef(null);
      var iframeReadyRef = React.useRef(false);
      var statusDataRef = React.useRef(null);
      var componentsRef = React.useRef([]);
      var fingerprintsRef = React.useRef(null);
      var buildRef = React.useRef(null);
      var pendingEvidenceRef = React.useRef({});
      var screenshotPendingRef = React.useRef({});
      var sendingRef = React.useRef(false);
      var batchIdRef = React.useRef(null);
      var pendingItemsRef = React.useRef([]);
      var latestRef = React.useRef({});
      var proposalReadRef = React.useRef(false);

      var tabState = React.useState('verdict');
      var tab = tabState[0];
      var setTab = tabState[1];

      var modeState = React.useState('loading'); // loading | ready | inert | error
      var mode = modeState[0];
      var setMode = modeState[1];

      var statusDataState = React.useState(null);
      var statusData = statusDataState[0];
      var setStatusData = statusDataState[1];

      var statusErrorState = React.useState(null);
      var statusError = statusErrorState[0];
      var setStatusError = statusErrorState[1];

      var criteriaState = React.useState(null);
      var criteria = criteriaState[0];
      var setCriteria = criteriaState[1];

      var componentsState = React.useState(null);
      var components = componentsState[0];
      var setComponents = componentsState[1];

      var annotationsState = React.useState(null);
      var annotations = annotationsState[0];
      var setAnnotations = annotationsState[1];

      var reportState = React.useState(null);
      var report = reportState[0];
      var setReport = reportState[1];

      var noticeState = React.useState(null); // {kind, text}
      var notice = noticeState[0];
      var setNotice = noticeState[1];

      var iframeReadyState = React.useState(false);
      var iframeReady = iframeReadyState[0];
      var setIframeReady = iframeReadyState[1];

      var previewInfoState = React.useState(null);
      var previewInfo = previewInfoState[0];
      var setPreviewInfo = previewInfoState[1];

      var previewVersionState = React.useState(Date.now());
      var previewVersion = previewVersionState[0];
      var setPreviewVersion = previewVersionState[1];

      var previewErrorState = React.useState(null);
      var previewError = previewErrorState[0];
      var setPreviewError = previewErrorState[1];

      var pickModeState = React.useState(false);
      var pickMode = pickModeState[0];
      var setPickMode = pickModeState[1];

      var pickedState = React.useState(null); // {componentId, label, pick, locator, related, at}
      var picked = pickedState[0];
      var setPicked = pickedState[1];

      var draftTextState = React.useState('');
      var draftText = draftTextState[0];
      var setDraftText = draftTextState[1];

      var pendingItemsState = React.useState([]);
      var pendingItems = pendingItemsState[0];
      var setPendingItems = pendingItemsState[1];

      var sendingState = React.useState(false);
      var sending = sendingState[0];
      var setSending = sendingState[1];

      var sendErrorState = React.useState(null);
      var sendError = sendErrorState[0];
      var setSendError = sendErrorState[1];

      var changeSummaryState = React.useState(null);
      var changeSummary = changeSummaryState[0];
      var setChangeSummary = changeSummaryState[1];

      var evidencePendingState = React.useState(0);
      var evidencePending = evidencePendingState[0];
      var setEvidencePending = evidencePendingState[1];

      var confirmingState = React.useState(false);
      var confirming = confirmingState[0];
      var setConfirming = confirmingState[1];

      var rejectingState = React.useState(null); // {requestId, reason}
      var rejecting = rejectingState[0];
      var setRejecting = rejectingState[1];

      var withdrawingState = React.useState(null); // {requestId, reason}
      var withdrawing = withdrawingState[0];
      var setWithdrawing = withdrawingState[1];

      var busyRequestState = React.useState(null); // requestId 字符串
      var busyRequest = busyRequestState[0];
      var setBusyRequest = busyRequestState[1];

      // 初始化 / 切换项目（init/scan → init/apply | project/select）
      var initOpenState = React.useState(false);
      var initOpen = initOpenState[0];
      var setInitOpen = initOpenState[1];
      var initKindState = React.useState('inert'); // inert = 未初始化态进入；switch = header 切换
      var initKind = initKindState[0];
      var setInitKind = initKindState[1];
      var initScanState = React.useState(null); // init/scan 响应体：{mode, scan|candidates, selected, scannedDirs}
      var initScan = initScanState[0];
      var setInitScan = initScanState[1];
      var initBusyState = React.useState(null); // null | 'scan' | 'apply' | 'select'
      var initBusy = initBusyState[0];
      var setInitBusy = initBusyState[1];
      var initErrorState = React.useState(null); // {http, code, message}
      var initError = initErrorState[0];
      var setInitError = initErrorState[1];
      var initChoiceState = React.useState(null); // 选中候选的 relativeRoot
      var initChoice = initChoiceState[0];
      var setInitChoice = initChoiceState[1];
      var initApplyState = React.useState(null); // init/apply 响应体
      var initApply = initApplyState[0];
      var setInitApply = initApplyState[1];
      var readinessState = React.useState(null); // {data, error, at}
      var readiness = readinessState[0];
      var setReadiness = readinessState[1];
      var readinessOpenState = React.useState(false);
      var readinessOpen = readinessOpenState[0];
      var setReadinessOpen = readinessOpenState[1];

      iframeReadyRef.current = iframeReady;
      statusDataRef.current = statusData;
      componentsRef.current = Array.isArray(components) ? components : [];
      pendingItemsRef.current = pendingItems;

      // ── 数据读取 ──────────────────────────────────────────────────────────
      function loadStatus() {
        if (!sessionId) return Promise.resolve(null);
        return requestApi('status', sessionId, null).then(function (result) {
          if (!mountedRef.current) return result;
          if (result.http === 404 || (result.data && result.data.status === 'inactive')) {
            setMode('inert');
            setStatusData(null);
            setStatusError((result.data && safeString(result.data.reason, 200)) || '未发现 .modelcheck');
            return result;
          }
          if (!result.ok || !result.data) {
            setMode(function (previous) { return previous === 'ready' ? 'ready' : 'error'; });
            setStatusError(describeApiError(result));
            return result;
          }
          var data = result.data;
          setStatusData(data);
          setMode('ready');
          setStatusError(null);
          var hashes = readHashes(data);
          var build = hashes.buildHash;
          var previousBuild = buildRef.current;
          if (build) {
            if (previousBuild && build !== previousBuild) {
              setPreviewVersion(Date.now());
              setIframeReady(false);
              setChangeSummary({ buildHash: build, changed: null, unchanged: null, loading: true, at: Date.now() });
              loadComponents(false);
            } else if (!previousBuild) {
              loadComponents(true);
            }
            buildRef.current = build;
          }
          if (hasProposal(data) && !proposalReadRef.current) {
            proposalReadRef.current = true;
            requestApi('contract/read', sessionId, null).then(function (contractResult) {
              if (!mountedRef.current) return;
              if (contractResult.ok && contractResult.data && contractResult.data.proposed) {
                setStatusData(function (previous) {
                  if (!previous) return previous;
                  var next = {};
                  Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
                  var contract = isPlainObject(previous.contract) ? previous.contract : {};
                  var merged = {};
                  Object.keys(contract).forEach(function (key) { merged[key] = contract[key]; });
                  merged.proposed = contractResult.data.proposed;
                  next.contract = merged;
                  return next;
                });
              }
            });
          }
          return result;
        });
      }

      function loadCriteria() {
        if (!sessionId) return Promise.resolve(null);
        return requestApi('criteria/list', sessionId, null).then(function (result) {
          if (!mountedRef.current) return result;
          if (result.ok && result.data && Array.isArray(result.data.criteria)) {
            setCriteria(result.data.criteria);
          } else if (result.http !== 404) {
            setNotice({ kind: 'error', text: '判据读取失败：' + describeApiError(result) });
          }
          return result;
        });
      }

      function loadComponents(seedOnly) {
        if (!sessionId) return Promise.resolve(null);
        return requestApi('components/list', sessionId, null).then(function (result) {
          if (!mountedRef.current) return result;
          if (!result.ok || !result.data) return result;
          var list = Array.isArray(result.data.components) ? result.data.components : [];
          setComponents(list);
          var next = {};
          list.forEach(function (item) {
            if (item && typeof item.id === 'string') next[item.id] = typeof item.fingerprint === 'string' ? item.fingerprint : '';
          });
          var previous = fingerprintsRef.current;
          if (previous && !seedOnly) {
            var changed = [];
            var unchanged = 0;
            Object.keys(next).forEach(function (id) {
              if (!Object.prototype.hasOwnProperty.call(previous, id) || previous[id] !== next[id]) changed.push(id);
              else unchanged += 1;
            });
            Object.keys(previous).forEach(function (id) {
              if (!Object.prototype.hasOwnProperty.call(next, id)) changed.push(id);
            });
            setChangeSummary({ buildHash: buildRef.current, changed: changed, unchanged: unchanged, loading: false, at: Date.now() });
          }
          fingerprintsRef.current = next;
          return result;
        });
      }

      function loadAnnotations() {
        if (!sessionId) return Promise.resolve(null);
        return requestApi('annotations/list', sessionId, null).then(function (result) {
          if (!mountedRef.current) return result;
          if (result.ok && result.data) setAnnotations(result.data);
          return result;
        });
      }

      function loadReadiness() {
        if (!sessionId) return Promise.resolve(null);
        return requestApi('readiness', sessionId, null).then(function (result) {
          if (!mountedRef.current) return result;
          var readinessData = result && result.data ? readReadiness(result.data) : null;
          if (readinessData) {
            setReadiness({ data: readinessData, error: null, at: Date.now() });
            var checks = Array.isArray(readinessData.checks) ? readinessData.checks : [];
            if (readinessData.blocked || checks.some(function (check) { return check && check.ok !== true && check.severity === 'block'; })) {
              setReadinessOpen(true);
            }
          } else if (result && result.ok === false) {
            setReadiness({ data: null, error: describeApiError(result), at: Date.now() });
          }
          return result;
        });
      }

      function loadReport() {
        if (!sessionId) return Promise.resolve(null);
        return requestApi('report/latest', sessionId, null).then(function (result) {
          if (!mountedRef.current) return result;
          if (result.ok && result.data) setReport(result.data);
          return result;
        });
      }

      // ── 预览 iframe ↔ bridge ──────────────────────────────────────────────
      function postPreviewMessage(type, payload) {
        var frame = iframeRef.current;
        if (!frame || !frame.contentWindow) return false;
        var message = { channel: CHANNEL, type: type };
        if (isPlainObject(payload)) {
          Object.keys(payload).forEach(function (key) { message[key] = payload[key]; });
        }
        try {
          if (JSON.stringify(message).length > MAX_MESSAGE_CHARS) return false;
          // 目标源用 '*'：预览页 sandbox 成不透明源（origin='null'），精确 origin 无法命中。
          // 我们只发取证请求与组件表，不含机密；真正的把关在 iframe 侧 source 校验。
          frame.contentWindow.postMessage(message, '*');
          return true;
        } catch (error) {
          return false;
        }
      }

      function readPickComponents() {
        return componentsRef.current.map(function (item) {
          return {
            id: item.id,
            label: item.label,
            pick: item.pick,
            observables: item.observables,
            related: item.related,
            route: item.route
          };
        });
      }

      function togglePickMode(nextOn) {
        var on = nextOn === true;
        if (on && componentsRef.current.length === 0) {
          loadComponents(false).then(function () {
            if (!mountedRef.current) return;
            var sent = postPreviewMessage('mc:pick-mode', { on: true, components: readPickComponents() });
            setPickMode(sent);
            if (!sent) setNotice({ kind: 'error', text: '预览页尚未就绪，无法进入标注模式' });
          });
          return;
        }
        var sent = postPreviewMessage('mc:pick-mode', { on: on, components: readPickComponents() });
        if (!sent && on) {
          setNotice({ kind: 'error', text: '预览页尚未就绪，无法进入标注模式' });
          return;
        }
        setPickMode(on);
        if (!on) setPicked(null);
      }

      function requestScreenshot() {
        return new Promise(function (resolve) {
          if (!iframeReadyRef.current) { resolve(null); return; }
          var requestId = uid('shot');
          var timer = window.setTimeout(function () {
            delete screenshotPendingRef.current[requestId];
            resolve(null);
          }, SCREENSHOT_TIMEOUT_MS);
          screenshotPendingRef.current[requestId] = function (payload) {
            window.clearTimeout(timer);
            delete screenshotPendingRef.current[requestId];
            resolve(payload && typeof payload.dataUrl === 'string' ? payload.dataUrl : null);
          };
          var sent = postPreviewMessage('mc:screenshot', { requestId: requestId });
          if (!sent) {
            window.clearTimeout(timer);
            delete screenshotPendingRef.current[requestId];
            resolve(null);
          }
        });
      }

      function handlePickMessage(data) {
        var componentId = safeString(data.componentId, 120);
        var unknown = data.unknown === true || !componentId;
        var chain = Array.isArray(data.chain) ? data.chain.slice(0, 32).map(function (item) {
          return {
            name: safeString(item && item.name, 200) || '(unnamed)',
            mcId: safeString(item && item.mcId, 120),
            kind: safeString(item && item.kind, 24)
          };
        }) : [];
        var known = null;
        for (var i = 0; i < componentsRef.current.length; i += 1) {
          if (componentsRef.current[i] && componentsRef.current[i].id === componentId) { known = componentsRef.current[i]; break; }
        }
        var partKey = safeString(data.partKey, 120);
        var instanceKey = safeString(data.instanceKey, 120);
        var partLabel = null;
        var instanceLabel = null;
        if (known && partKey && Array.isArray(known.parts)) {
          for (var p = 0; p < known.parts.length; p += 1) {
            if (known.parts[p] && known.parts[p].key === partKey) partLabel = safeString(known.parts[p].label, 120);
          }
        }
        if (known && instanceKey && Array.isArray(known.instances)) {
          for (var q = 0; q < known.instances.length; q += 1) {
            if (known.instances[q] && known.instances[q].key === instanceKey) instanceLabel = safeString(known.instances[q].label, 120);
          }
        }
        setPicked({
          componentId: unknown ? null : componentId,
          unknown: unknown,
          kind: known ? safeString(known.kind, 24) : safeString(data.kind, 24),
          partKey: partKey,
          instanceKey: instanceKey,
          instanceId: isFiniteNumber(data.instanceId) ? data.instanceId : null,
          partLabel: partLabel,
          instanceLabel: instanceLabel,
          objectName: safeString(data.objectName, 200),
          chain: chain,
          worldPoint: isPlainObject(data.worldPoint) ? data.worldPoint : null,
          pick: data.pick !== undefined ? data.pick : componentId,
          label: unknown ? null : composeComponentLabel(componentId, known, safeString(data.label, 200)),
          locator: known && isPlainObject(known.locator) ? known.locator : null,
          related: known && Array.isArray(known.related) ? known.related : [],
          selection: unknown ? null : unitSelectionId(componentId, partKey, instanceKey),
          at: isPlainObject(data.at) ? data.at : null
        });
        setDraftText('');
      }

      function handleEvidenceMessage(data) {
        var requestId = safeString(data.requestId, 120);
        if (!requestId) return;
        var entry = pendingEvidenceRef.current[requestId];
        if (!entry) return; // 不在本次面板发出的请求里：丢弃
        delete pendingEvidenceRef.current[requestId];
        if (entry.timer) window.clearTimeout(entry.timer);
        setEvidencePending(Object.keys(pendingEvidenceRef.current).length);
        var request = isPlainObject(entry.request) ? entry.request : {};
        var expected = isPlainObject(request.expected) ? request.expected : {};
        var hashes = readHashes(statusDataRef.current);
        var response = {
          requestId: requestId,
          projectId: readProjectId(statusDataRef.current) || safeString(request.projectId, 120) || null,
          sessionId: sessionId,
          buildHash: safeString(data.buildHash, 200) || safeString(expected.buildHash, 200) || hashes.buildHash || null,
          sourceHash: safeString(expected.sourceHash, 200) || hashes.sourceHash || null,
          adapterVersion: safeString(data.adapterVersion, 80) || ADAPTER_VERSION,
          context: isPlainObject(data.context) ? data.context : {},
          components: isPlainObject(data.components) ? data.components : {},
          coverage: Array.isArray(data.coverage) ? data.coverage : [],
          errors: Array.isArray(data.errors) ? data.errors : [],
          capturedAt: safeString(data.capturedAt, 80) || new Date().toISOString(),
          evidenceKind: 'runtime'
        };
        requestApi('evidence/submit', sessionId, { response: response }).then(function (result) {
          if (!mountedRef.current) return;
          if (result.ok && result.data && result.data.accepted === true) {
            setNotice({ kind: 'success', text: '运行时取证已提交，判据将据此复核' });
            loadStatus();
          } else {
            setNotice({
              kind: 'error',
              text: '运行时取证未被接受：' + describeApiError(result) +
                (result.data && result.data.reason ? '（' + result.data.reason + '）' : '')
            });
          }
        });
      }

      function handleBridgeMessage(data) {
        if (data.type === 'mc:ready') {
          var info = {
            route: safeString(data.route, 16),
            capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
            buildHash: safeString(data.buildHash, 200),
            unitToPx: isFiniteNumber(data.unitToPx) ? data.unitToPx : null,
            entryUrl: safeString(data.entryUrl, 400),
            at: Date.now()
          };
          setPreviewInfo(info);
          setIframeReady(true);
          return;
        }
        if (data.type === 'mc:evidence') { handleEvidenceMessage(data); return; }
        if (data.type === 'mc:pick') { handlePickMessage(data); return; }
        if (data.type === 'mc:screenshot') {
          var requestId = safeString(data.requestId, 120);
          if (requestId && screenshotPendingRef.current[requestId]) {
            screenshotPendingRef.current[requestId](data);
            return;
          }
          if (!data.dataUrl && data.reason) setNotice({ kind: 'info', text: String(data.reason) });
          return;
        }
        if (data.type === 'mc:error') {
          setNotice({ kind: 'error', text: '取证桥接报告错误：' + (safeString(data.message, 300) || safeString(data.code, 80) || '未知') });
        }
      }

      function handleEvidenceRequest(request) {
        if (!isPlainObject(request)) return;
        var requestId = safeString(request.requestId, 120);
        if (!requestId) return;
        var componentsList = Array.isArray(request.components) ? request.components : [];
        var collectPayload = {
          requestId: requestId,
          components: componentsList.map(function (item) {
            return {
              id: item && item.id,
              label: item && item.label,
              pick: item && item.pick,
              observables: item && item.observables,
              related: item && item.related
            };
          }),
          context: isPlainObject(request.context) ? request.context : {},
          props: Array.isArray(request.props) ? request.props : []
        };
        var timeout = isFiniteNumber(request.timeoutMs) && request.timeoutMs > 0
          ? Math.min(request.timeoutMs, EVIDENCE_TIMEOUT_MS * 2)
          : EVIDENCE_TIMEOUT_MS;
        var timer = window.setTimeout(function () {
          if (!pendingEvidenceRef.current[requestId]) return;
          delete pendingEvidenceRef.current[requestId];
          setEvidencePending(Object.keys(pendingEvidenceRef.current).length);
          setNotice({ kind: 'error', text: '运行时取证超时：预览页未在 ' + timeout + ' ms 内回传（判据将记为无法判定）' });
        }, timeout);
        pendingEvidenceRef.current[requestId] = { request: request, timer: timer, at: Date.now() };
        setEvidencePending(Object.keys(pendingEvidenceRef.current).length);
        var sent = postPreviewMessage('mc:collect', collectPayload);
        if (!sent) {
          window.clearTimeout(timer);
          delete pendingEvidenceRef.current[requestId];
          setEvidencePending(Object.keys(pendingEvidenceRef.current).length);
          setNotice({ kind: 'error', text: '预览页尚未就绪，无法采集运行时取证（判据将记为无法判定）' });
        }
      }

      // ── 契约确认 / 标注发送 / 人工验收 ────────────────────────────────────
      function confirmContract() {
        var hash = readProposedHash(statusDataRef.current);
        if (!hash) {
          setNotice({ kind: 'error', text: '缺少待确认契约的内容哈希，已取消确认（不写未绑定哈希的确认）' });
          return;
        }
        setConfirming(true);
        requestApi('contract/confirm', sessionId, { contractHash: hash }).then(function (result) {
          if (!mountedRef.current) return;
          setConfirming(false);
          if (result.ok) {
            setNotice({ kind: 'success', text: '契约已由你确认（confirmedBy: user）' });
            loadStatus();
            loadCriteria();
          } else {
            setNotice({ kind: 'error', text: '契约确认失败：' + describeApiError(result) });
          }
        });
      }

      function addPendingItem() {
        if (!picked) return;
        var text = draftText;
        if (!text || !text.trim()) {
          setNotice({ kind: 'error', text: '请先写下这条标注的要求（原话会原文保存）' });
          return;
        }
        if (text.length > MAX_ITEM_TEXT) {
          setNotice({ kind: 'error', text: '单条标注超过 ' + MAX_ITEM_TEXT + ' 字，请拆分' });
          return;
        }
        if (pendingItemsRef.current.length >= MAX_PENDING_ITEMS) {
          setNotice({ kind: 'error', text: '单批最多 ' + MAX_PENDING_ITEMS + ' 条，请先发送' });
          return;
        }
        batchIdRef.current = null; // 条目变化后必须重新建批
        requestScreenshot().then(function (dataUrl) {
          if (!mountedRef.current) return;
          var item = {
            localId: uid('item'),
            componentId: picked.componentId,
            selection: picked.selection || null,
            label: picked.label,
            locator: picked.locator,
            related: picked.related,
            userText: text,
            screenshot: typeof dataUrl === 'string' ? dataUrl : null,
            createdAt: Date.now(),
            editing: false
          };
          setPendingItems(function (previous) { return previous.concat([item]); });
          setPicked(null);
          setDraftText('');
          if (typeof dataUrl === 'string') setNotice({ kind: 'success', text: '已加入待发送标注（含截图）' });
          else setNotice({ kind: 'info', text: '已加入待发送标注；该路线面板内无法截图，本条不带截图（未声称已截图）' });
        });
      }

      function deletePendingItem(localId) {
        batchIdRef.current = null;
        setPendingItems(function (previous) {
          return previous.filter(function (item) { return item.localId !== localId; });
        });
      }

      function toggleEditPendingItem(localId) {
        setPendingItems(function (previous) {
          return previous.map(function (item) {
            if (item.localId !== localId) return item;
            var next = {};
            Object.keys(item).forEach(function (key) { next[key] = item[key]; });
            next.editing = !item.editing;
            return next;
          });
        });
      }

      function updatePendingItemText(localId, text) {
        batchIdRef.current = null;
        setPendingItems(function (previous) {
          return previous.map(function (item) {
            if (item.localId !== localId) return item;
            var next = {};
            Object.keys(item).forEach(function (key) { next[key] = item[key]; });
            next.userText = text;
            return next;
          });
        });
      }

      function findCreatedBatch(result) {
        if (!result || !result.data) return null;
        if (isPlainObject(result.data.batch)) return result.data.batch;
        if (isPlainObject(result.data.data) && isPlainObject(result.data.data.batch)) return result.data.data.batch;
        return null;
      }

      function sendPendingItems() {
        if (sendingRef.current) return;
        var items = pendingItemsRef.current;
        if (!items.length) return;
        sendingRef.current = true;
        setSending(true);
        setSendError(null);
        var createdPromise;
        if (batchIdRef.current) {
          // 重试：复用上次创建成功的批次，不重复生成请求（幂等）
          createdPromise = Promise.resolve({ ok: true, data: { batch: { id: batchIdRef.current } } });
        } else {
          createdPromise = requestApi('annotations/create', sessionId, {
            items: items.map(function (item) {
              var payload = { componentId: item.componentId, userText: item.userText };
              if (item.selection) {
                // 发送文本带几何单元标识：组件#部件/实例（用户原话保持在最前，不改写）。
                payload.userText = item.userText + '\n\n[ModelCheck 选择] ' + item.selection;
              }
              if (typeof item.screenshot === 'string' && item.screenshot) payload.screenshot = item.screenshot;
              return payload;
            })
          });
        }
        createdPromise.then(function (created) {
          if (!created || !created.ok) {
            throw new Error('annotations/create 失败：' + describeApiError(created));
          }
          var batch = findCreatedBatch(created);
          var batchId = (batch && safeString(batch.id, 120)) || batchIdRef.current;
          if (!batchId) throw new Error('annotations/create 未返回批次 id，未发送');
          batchIdRef.current = batchId;
          return requestApi('annotations/send', sessionId, { batchId: batchId });
        }).then(function (sent) {
          if (!sent || !sent.ok) {
            throw new Error('annotations/send 失败：' + describeApiError(sent));
          }
          batchIdRef.current = null;
          setPendingItems([]);
          setSendError(null);
          setNotice({ kind: 'success', text: '本批标注已投递到会话' + (sent.data && sent.data.idempotent ? '（幂等重试，未重复生成请求）' : '') });
          loadAnnotations();
          loadStatus();
        }).catch(function (error) {
          if (!mountedRef.current) return;
          var message = String((error && error.message) || error);
          setSendError(message);
          setNotice({ kind: 'error', text: '发送失败：' + message + '。可点「重试发送」——会复用同一批次，不重复生成请求。' });
        }).then(function () {
          sendingRef.current = false;
          if (mountedRef.current) setSending(false);
        });
      }

      function sendExistingBatch(batchId) {
        if (sendingRef.current || !batchId) return;
        sendingRef.current = true;
        setSending(true);
        setSendError(null);
        requestApi('annotations/send', sessionId, { batchId: batchId }).then(function (result) {
          if (!result || !result.ok) throw new Error('annotations/send 失败：' + describeApiError(result));
          setNotice({ kind: 'success', text: '草稿批次 ' + batchId + ' 已投递' });
          loadAnnotations();
          loadStatus();
        }).catch(function (error) {
          if (!mountedRef.current) return;
          setSendError(String((error && error.message) || error));
        }).then(function () {
          sendingRef.current = false;
          if (mountedRef.current) setSending(false);
        });
      }

      function acceptRequest(requestId) {
        if (busyRequest) return;
        setBusyRequest(requestId);
        requestApi('annotations/accept', sessionId, { requestId: requestId, accepted: true }).then(function (result) {
          if (!mountedRef.current) return;
          setBusyRequest(null);
          if (result.ok) {
            setNotice({ kind: 'success', text: '已记录你的验收通过（绑定当前证据版本）' });
            loadAnnotations();
            loadStatus();
          } else {
            setNotice({ kind: 'error', text: '验收提交失败：' + describeApiError(result) });
          }
        });
      }

      function submitRejection() {
        if (!rejecting) return;
        var reason = String(rejecting.reason || '').trim();
        if (!reason) {
          setNotice({ kind: 'error', text: '「不通过」必须填写原因' });
          return;
        }
        if (busyRequest) return;
        var requestId = rejecting.requestId;
        setBusyRequest(requestId);
        requestApi('annotations/accept', sessionId, { requestId: requestId, accepted: false, reason: reason }).then(function (result) {
          if (!mountedRef.current) return;
          setBusyRequest(null);
          if (result.ok) {
            setRejecting(null);
            setNotice({ kind: 'success', text: '已记录不通过及原因，进入下一轮修改' });
            loadAnnotations();
            loadStatus();
          } else {
            setNotice({ kind: 'error', text: '验收提交失败：' + describeApiError(result) });
          }
        });
      }

      function submitWithdraw() {
        if (!withdrawing) return;
        var reason = String(withdrawing.reason || '').trim();
        if (!reason) {
          setNotice({ kind: 'error', text: '撤回必须填写原因' });
          return;
        }
        if (busyRequest) return;
        var requestId = withdrawing.requestId;
        setBusyRequest(requestId);
        requestApi('annotations/withdraw', sessionId, { requestId: requestId, reason: reason }).then(function (result) {
          if (!mountedRef.current) return;
          setBusyRequest(null);
          if (result.ok) {
            setWithdrawing(null);
            setNotice({ kind: 'success', text: '请求已撤回（保留原因）' });
            loadAnnotations();
            loadStatus();
          } else {
            setNotice({ kind: 'error', text: '撤回失败：' + describeApiError(result) });
          }
        });
      }

      // ── 初始化 / 切换项目 ────────────────────────────────────────────────
      function closeInit() {
        setInitOpen(false);
        setInitScan(null);
        setInitError(null);
        setInitChoice(null);
        setInitApply(null);
        setInitBusy(null);
      }

      function openInit(kind) {
        setInitKind(kind === 'switch' ? 'switch' : 'inert');
        setInitOpen(true);
        setInitScan(null);
        setInitError(null);
        setInitChoice(null);
        setInitApply(null);
        scanInitCandidates();
      }

      function pickDefaultCandidate(scanData) {
        if (!scanData || scanData.mode !== 'workspace') return null;
        var candidates = Array.isArray(scanData.candidates) ? scanData.candidates : [];
        var selectedRoot = safeString(scanData.selected, 400);
        if (!selectedRoot) return null;
        for (var i = 0; i < candidates.length; i += 1) {
          var item = candidates[i];
          if (item && (item.root === selectedRoot || item.relativeRoot === selectedRoot)) return item.relativeRoot;
        }
        return null;
      }

      function scanInitCandidates() {
        if (!sessionId || initBusy) return;
        setInitBusy('scan');
        setInitError(null);
        setInitApply(null);
        requestApi('init/scan', sessionId, null).then(function (result) {
          if (!mountedRef.current) return;
          setInitBusy(null);
          if (!result || !result.ok || !result.data) {
            setInitScan(null);
            setInitError(readInitApiError(result));
            return;
          }
          setInitScan(result.data);
          setInitChoice(pickDefaultCandidate(result.data));
        });
      }

      function applyInitScaffold() {
        if (!sessionId || initBusy || !initScan) return;
        var payload = {};
        if (initScan.mode === 'workspace') {
          if (!initChoice) {
            setInitError({ http: 0, code: 'pick-first', message: '请先选择一个候选项目' });
            return;
          }
          payload.path = initChoice;
        }
        setInitBusy('apply');
        setInitError(null);
        requestApi('init/apply', sessionId, payload).then(function (result) {
          if (!mountedRef.current) return;
          setInitBusy(null);
          if (!result || !result.ok || !result.data) {
            var info = readInitApiError(result);
            if (info.code === 'multiple-candidates') {
              // 409：候选列表在 error.candidates 里（Lead 更正：不在 details）
              setInitError(null);
              setInitScan({
                mode: 'workspace',
                candidates: Array.isArray(info.candidates) ? info.candidates : [],
                scannedDirs: null,
                selected: null
              });
              setInitChoice(null);
              setNotice({ kind: 'info', text: '工作区里有多个可初始化项目，请选择一个再初始化。' });
              return;
            }
            if (info.code === 'no-project-candidate') {
              // 404：回到空态（显示“未找到可初始化项目”+ 重新扫描），而不是一条报错
              setInitError(null);
              setInitScan({
                mode: 'workspace',
                candidates: Array.isArray(info.candidates) ? info.candidates : [],
                scannedDirs: null,
                selected: null
              });
              setInitChoice(null);
              setNotice({ kind: 'info', text: info.message || '未找到可初始化的模型项目。' });
              return;
            }
            setInitError(info);
            return;
          }
          setInitApply(result.data);
          setInitScan(null);
          setInitError(null);
          var written = Array.isArray(result.data.written) ? result.data.written : [];
          setNotice({ kind: 'success', text: '已生成 .modelcheck（写入 ' + written.length + ' 个文件），正在刷新状态。' });
          loadStatus();
        });
      }

      function selectInitCandidate() {
        if (!sessionId || initBusy) return;
        var candidates = initScan && Array.isArray(initScan.candidates) ? initScan.candidates : [];
        var chosen = null;
        for (var i = 0; i < candidates.length; i += 1) {
          if (candidates[i] && candidates[i].relativeRoot === initChoice) { chosen = candidates[i]; break; }
        }
        if (!chosen) {
          setInitError({ http: 0, code: 'pick-first', message: '请先选择一个候选项目' });
          return;
        }
        setInitBusy('select');
        setInitError(null);
        requestApi('project/select', sessionId, { path: chosen.relativeRoot || chosen.root }).then(function (result) {
          if (!mountedRef.current) return;
          setInitBusy(null);
          if (!result || !result.ok || !result.data) {
            var info = readInitApiError(result);
            if (info.code === 'no-modelcheck') {
              info.message = '该目录还没有 .modelcheck：请改用「初始化所选项目」。';
            }
            setInitError(info);
            return;
          }
          var label = safeString(chosen.relativeRoot, 300) || safeString(chosen.title, 120) || '';
          closeInit();
          setNotice({ kind: 'success', text: '已切换项目：' + label });
          loadStatus();
        });
      }

      function refreshAll() {
        setNotice(null);
        loadStatus().then(function () {
          if (tab === 'verdict') return loadCriteria();
          if (tab === 'annotate') return loadComponents(false);
          if (tab === 'requests') return loadAnnotations();
          if (tab === 'report') return loadReport();
          return null;
        });
      }

      function switchTab(nextTab) {
        setTab(nextTab);
      }

      // effect 里通过这个快照调用"最新"的处理函数，避免把普通函数塞进依赖数组。
      latestRef.current = {
        loadStatus: loadStatus,
        loadCriteria: loadCriteria,
        loadComponents: loadComponents,
        loadAnnotations: loadAnnotations,
        loadReport: loadReport,
        handleBridgeMessage: handleBridgeMessage,
        handleEvidenceRequest: handleEvidenceRequest,
        loadReadiness: loadReadiness
      };

      // ── effects ──────────────────────────────────────────────────────────
      React.useEffect(function () {
        mountedRef.current = true;
        return function () { mountedRef.current = false; };
      }, []);

      React.useEffect(function () {
        if (!sessionId) {
          setMode('inert');
          setStatusError('缺少会话身份，无法读取 ModelCheck 状态');
          return undefined;
        }
        setMode('loading');
        setStatusData(null);
        setStatusError(null);
        setCriteria(null);
        setComponents(null);
        setAnnotations(null);
        setReport(null);
        setPicked(null);
        setPendingItems([]);
        setChangeSummary(null);
        setPickMode(false);
        setIframeReady(false);
        setInitOpen(false);
        setInitScan(null);
        setInitError(null);
        setInitChoice(null);
        setInitApply(null);
        setInitBusy(null);
        fingerprintsRef.current = null;
        buildRef.current = null;
        batchIdRef.current = null;
        proposalReadRef.current = false;
        pendingEvidenceRef.current = {};
        latestRef.current.loadStatus();
        latestRef.current.loadCriteria();
        return undefined;
      }, [sessionId]);

      // 状态轮询：5 s；页面隐藏时暂停，回到前台立刻补一次。
      React.useEffect(function () {
        if (!sessionId) return undefined;
        var cancelled = false;
        var timer = null;
        function schedule() {
          if (cancelled) return;
          timer = window.setTimeout(tick, STATUS_POLL_MS);
        }
        function tick() {
          if (cancelled) return;
          if (document.hidden) { schedule(); return; }
          latestRef.current.loadStatus().then(schedule, schedule);
        }
        schedule();
        function onVisibilityChange() {
          if (cancelled) return;
          if (!document.hidden) {
            if (timer) window.clearTimeout(timer);
            latestRef.current.loadStatus().then(schedule, schedule);
          }
        }
        document.addEventListener('visibilitychange', onVisibilityChange);
        return function () {
          cancelled = true;
          if (timer) window.clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisibilityChange);
        };
      }, [sessionId]);

      // 切页签时补充该页需要的数据。
      React.useEffect(function () {
        if (!sessionId) return;
        if (tab === 'annotate') {
          latestRef.current.loadComponents(false);
          latestRef.current.loadAnnotations();
        }
        if (tab === 'requests') latestRef.current.loadAnnotations();
        if (tab === 'report') latestRef.current.loadReport();
        if (tab === 'verdict') latestRef.current.loadCriteria();
      }, [sessionId, tab]);

      // iframe 就绪后发 hello：把 route / unitToPx 交给 bridge（世界单位换算必需）。
      React.useEffect(function () {
        if (!iframeReady) return;
        var data = statusDataRef.current;
        postPreviewMessage('mc:hello', { route: readRoute(data), unitToPx: readUnitToPx(data) });
      }, [iframeReady]);

      // 接入就绪（readiness）：项目可用后读一次；失败只提示，不自动重试风暴。
      React.useEffect(function () {
        if (!sessionId || mode !== 'ready') return;
        latestRef.current.loadReadiness();
      }, [sessionId, mode, statusData && statusData.project && statusData.project.projectId]);

      // 只接受来自本 iframe、同源、channel 与类型白名单、大小上限内的消息。
      React.useEffect(function () {
        function onMessage(event) {
          var frame = iframeRef.current;
          if (!frame || !frame.contentWindow) return;
          // 唯一可信锚点：消息必须来自本 iframe 的 contentWindow。
          if (event.source !== frame.contentWindow) return;
          // 预览页被 sandbox 成不透明源时 event.origin 是字符串 'null'；同源页则是自身 origin。
          // 两种都放行，其余一律丢弃。
          var origin = typeof event.origin === 'string' ? event.origin : '';
          if (origin !== 'null' && origin !== window.location.origin) return;
          var data = event.data;
          if (!isPlainObject(data)) return;
          if (data.channel !== CHANNEL) return;
          if (typeof data.type !== 'string' || !INBOUND_TYPES[data.type]) return;
          try {
            if (JSON.stringify(data).length > MAX_MESSAGE_CHARS) return;
          } catch (error) {
            return;
          }
          latestRef.current.handleBridgeMessage(data);
        }
        window.addEventListener('message', onMessage);
        return function () { window.removeEventListener('message', onMessage); };
      }, []);

      // 运行时取证接力：只在「标注」页签、iframe 就绪、页面可见、项目可用时轮询。
      React.useEffect(function () {
        if (!sessionId || tab !== 'annotate' || !iframeReady || mode !== 'ready') return undefined;
        var cancelled = false;
        var timer = null;
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        function schedule(delay) {
          if (cancelled) return;
          timer = window.setTimeout(poll, isFiniteNumber(delay) ? delay : 400);
        }
        function poll() {
          if (cancelled) return;
          if (document.hidden) { schedule(1200); return; }
          requestApi('evidence/poll', sessionId, { waitMs: EVIDENCE_WAIT_MS }, controller ? controller.signal : undefined)
            .then(function (result) {
              if (cancelled) return;
              var request = result && result.data && isPlainObject(result.data.request) ? result.data.request : null;
              if (request) latestRef.current.handleEvidenceRequest(request);
              schedule(request ? 60 : 500);
            }, function () {
              if (cancelled) return;
              schedule(1500);
            });
        }
        poll();
        return function () {
          cancelled = true;
          if (timer) window.clearTimeout(timer);
          if (controller) controller.abort();
        };
      }, [sessionId, tab, iframeReady, mode]);

      // 卸载时清掉截图/取证的挂起定时器。
      React.useEffect(function () {
        return function () {
          Object.keys(pendingEvidenceRef.current).forEach(function (requestId) {
            var entry = pendingEvidenceRef.current[requestId];
            if (entry && entry.timer) window.clearTimeout(entry.timer);
          });
          pendingEvidenceRef.current = {};
          screenshotPendingRef.current = {};
        };
      }, []);

      // ── 渲染辅助 ──────────────────────────────────────────────────────────
      function describeScanLine(value) {
        if (typeof value === 'string') return value;
        if (value === null || value === undefined) return '';
        return shortJson(value);
      }

      function renderInitCandidate(candidate, index) {
        var relativeRoot = safeString(candidate && candidate.relativeRoot, 300) ||
          safeString(candidate && candidate.name, 200) || ('候选 ' + (index + 1));
        var title = safeString(candidate && candidate.title, 120);
        var route = safeString(candidate && candidate.route, 16);
        var entry = safeString(candidate && candidate.previewEntry, 300);
        var componentsCount = candidate && isFiniteNumber(candidate.componentsCount) ? candidate.componentsCount : null;
        var warnings = candidate && Array.isArray(candidate.warnings) ? candidate.warnings : [];
        var mcInfo = readModelcheckInfo(candidate);
        var selected = initChoice === relativeRoot;
        var inputId = instanceId.current + '-cand-' + index;
        return h('label', {
          key: relativeRoot + '-' + index,
          className: 'mc-candidate',
          'data-selected': selected ? 'true' : 'false',
          htmlFor: inputId
        },
          h('input', {
            id: inputId,
            type: 'radio',
            name: instanceId.current + '-candidate',
            checked: selected,
            value: relativeRoot,
            'aria-label': '选择候选项目 ' + relativeRoot,
            onChange: function () { setInitChoice(relativeRoot); }
          }),
          h('span', { className: 'mc-candidate-body' },
            h('span', { className: 'mc-candidate-name', title: relativeRoot },
              relativeRoot + (title && title !== relativeRoot ? ' · ' + title : '')),
            h('span', { className: 'mc-sub mc-mono' }, relativeRoot),
            entry ? h('span', { className: 'mc-sub' }, '预览入口：' + entry) : null,
            h('span', { className: 'mc-row', style: { gap: '6px', marginTop: '2px' } },
              route ? h('span', { className: 'mc-badge' }, ROUTE_LABELS[route] || route) : null,
              componentsCount !== null ? h('span', { className: 'mc-badge' }, '组件候选 ' + componentsCount) : null,
              h('span', {
                className: 'mc-badge' + modelcheckStateBadgeClass(mcInfo),
                title: modelcheckStateTitle(mcInfo)
              }, modelcheckStateLabel(mcInfo)),
              warnings.length > 0
                ? h('span', { className: 'mc-badge mc-badge-warn', title: warnings.join('\n') }, '警告 ' + warnings.length)
                : null
            )
          )
        );
      }

      function renderInitProjectScan() {
        var scan = initScan && initScan.scan ? initScan.scan : null;
        if (!scan) return h('p', { className: 'mc-init-note' }, '探测结果缺少 scan 摘要。');
        var components = Array.isArray(scan.components) ? scan.components : [];
        var sources = Array.isArray(scan.sources) ? scan.sources : [];
        var outputs = Array.isArray(scan.buildOutputs) ? scan.buildOutputs : [];
        var warnings = Array.isArray(scan.warnings) ? scan.warnings : [];
        var notes = Array.isArray(scan.notes) ? scan.notes : [];
        var route = safeString(scan.route, 16);
        var mcInfo = readModelcheckInfo(scan);
        return h('div', null,
          h('dl', { className: 'mc-kv' },
            h('dt', null, '标题'), h('dd', null, safeString(scan.title, 120) || '（未识别）'),
            h('dt', null, '项目 ID'), h('dd', { className: 'mc-mono' }, safeString(scan.projectId, 120) || '（未识别）'),
            h('dt', null, '路线'), h('dd', null, (route && ROUTE_LABELS[route]) || route || '（未识别）'),
            h('dt', null, '预览入口'), h('dd', { className: 'mc-mono' }, safeString(scan.previewEntry, 300) || '（未识别）'),
            h('dt', null, '目录'), h('dd', { className: 'mc-mono' },
              safeString(scan.relativeRoot, 300) || safeString(scan.root, 400) || ''),
            h('dt', null, '源码'), h('dd', null, String(sources.length) + ' 个文件'),
            h('dt', null, '构建产物'), h('dd', null, outputs.length > 0 ? outputs.join('、') : '未发现'),
            h('dt', null, '组件候选'), h('dd', null, String(components.length) + ' 个'),
            h('dt', null, '.modelcheck'), h('dd', null,
              h('span', {
                className: 'mc-badge' + modelcheckStateBadgeClass(mcInfo),
                title: modelcheckStateTitle(mcInfo)
              }, modelcheckStateLabel(mcInfo)),
              mcInfo.files.length > 0 ? h('span', { className: 'mc-sub mc-mono' }, ' ' + mcInfo.files.join('、')) : null)
          ),
          components.length > 0
            ? h('ul', { className: 'mc-list-plain' }, components.slice(0, 8).map(function (item, index) {
              return h('li', { key: 'cand-' + index },
                (safeString(item && item.label, 120) || safeString(item && item.id, 120) || '未命名') +
                '（' + (safeString(item && item.id, 120) || '?') + '，' +
                (safeString(item && item.candidateKind, 60) || '未标注来源') + '）');
            }))
            : null,
          warnings.length > 0
            ? h('ul', { className: 'mc-list-plain', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
              warnings.slice(0, 8).map(function (text, index) {
                return h('li', { key: 'warn-' + index }, describeScanLine(text));
              }))
            : null,
          notes.length > 0
            ? h('ul', { className: 'mc-list-plain' }, notes.slice(0, 8).map(function (text, index) {
              return h('li', { key: 'note-' + index }, describeScanLine(text));
            }))
            : null
        );
      }

      function renderInitApplied() {
        var data = initApply || {};
        var written = Array.isArray(data.written) ? data.written : [];
        var skipped = Array.isArray(data.skipped) ? data.skipped : [];
        var nextSteps = Array.isArray(data.nextSteps) ? data.nextSteps : [];
        var notes = Array.isArray(data.notes) ? data.notes : [];
        var where = safeString(data.relativeRoot, 300) || safeString(data.root, 400) || '';
        var beforeInfo = readModelcheckInfo({ modelcheck: isPlainObject(data.before) ? data.before : null });
        var stateInfo = readModelcheckInfo({
          modelcheck: {
            state: typeof data.state === 'string' ? data.state : (isPlainObject(data.after) ? data.after.state : null),
            componentsCount: isPlainObject(data.after) && isFiniteNumber(data.after.componentsCount) ? data.after.componentsCount : null,
            contractStatus: isPlainObject(data.after) && typeof data.after.contractStatus === 'string' ? data.after.contractStatus : null
          }
        });
        return h('div', null,
          h('p', { className: 'mc-init-note' },
            '已生成 .modelcheck' + (where ? '（' + where + '）' : '') +
            '。只生成 config.json 与 components.json，不生成判据；判据仍需依据项目文档用 modelcheck_contract 起草，并由你在面板确认。'),
          h('p', { className: 'mc-init-note' },
            '空的 .modelcheck 目录不算已初始化：本次会补齐 config.json 与 components.json（已有效的不覆盖）。',
            h('span', { style: { marginLeft: '6px' } },
              h('span', {
                className: 'mc-badge' + modelcheckStateBadgeClass(beforeInfo),
                title: modelcheckStateTitle(beforeInfo)
              }, '处理前：' + modelcheckStateLabel(beforeInfo))),
            h('span', { style: { marginLeft: '4px' } },
              h('span', {
                className: 'mc-badge' + modelcheckStateBadgeClass(stateInfo),
                title: modelcheckStateTitle(stateInfo)
              }, '处理后：' + modelcheckStateLabel(stateInfo)))
          ),
          notes.length > 0
            ? h('div', null,
              h('div', { className: 'mc-sub' }, '处理说明'),
              h('ul', { className: 'mc-list-plain' }, notes.map(function (text, index) {
                return h('li', { key: 'note-' + index }, describeScanLine(text));
              })))
            : null,
          written.length > 0
            ? h('div', null,
              h('div', { className: 'mc-sub' }, '写入'),
              h('ul', { className: 'mc-list-plain' }, written.map(function (name, index) {
                return h('li', { key: 'written-' + index, className: 'mc-mono' }, describeScanLine(name));
              })))
            : null,
          skipped.length > 0
            ? h('div', null,
              h('div', { className: 'mc-sub' }, '跳过（已存在且有效，未覆盖）'),
              h('ul', { className: 'mc-list-plain' }, skipped.map(function (name, index) {
                return h('li', { key: 'skipped-' + index }, describeScanLine(name));
              })))
            : null,
          nextSteps.length > 0
            ? h('div', null,
              h('div', { className: 'mc-sub' }, '下一步'),
              h('ol', { className: 'mc-list-plain' }, nextSteps.map(function (step, index) {
                return h('li', { key: 'step-' + index }, describeScanLine(step));
              })))
            : null
        );
      }

      function renderInitPanel() {
        if (!initOpen) return null;
        var candidates = initScan && initScan.mode === 'workspace' && Array.isArray(initScan.candidates)
          ? initScan.candidates : [];
        var chosen = null;
        for (var i = 0; i < candidates.length; i += 1) {
          if (candidates[i] && candidates[i].relativeRoot === initChoice) { chosen = candidates[i]; break; }
        }
        var chosenInfo = chosen ? readModelcheckInfo(chosen) : null;
        var chosenReady = !!(chosenInfo && chosenInfo.state === 'ready');
        var chosenNeedsFill = modelcheckNeedsFill(chosenInfo);
        var busyLabel = initBusy === 'scan' ? '正在扫描可初始化的项目…'
          : initBusy === 'apply' ? '正在生成 .modelcheck…'
            : initBusy === 'select' ? '正在切换项目…' : null;

        var primary = null;
        if (initApply) {
          primary = h('button', {
            type: 'button',
            className: 'mc-btn mc-btn-sm mc-btn-primary',
            'aria-label': '完成初始化并刷新状态',
            onClick: function () { closeInit(); loadStatus(); }
          }, '完成');
        } else if (initScan && initScan.mode === 'project') {
          var bound = !!(initScan.selected && initScan.scan && initScan.selected === initScan.scan.root);
          var projectInfo = readModelcheckInfo(initScan.scan);
          var projectNeedsFill = modelcheckNeedsFill(projectInfo);
          var projectReady = projectInfo.state === 'ready';
          primary = h('button', {
            type: 'button',
            className: 'mc-btn mc-btn-sm mc-btn-primary',
            disabled: initBusy !== null,
            title: projectReady
              ? '该项目已完整初始化；这里只会检查并按需补齐，不会覆盖已有有效文件'
              : (bound ? '当前会话已绑定该目录；会补齐缺失的 config/components 与空目录' : '只写入 config.json 与 components.json，不生成判据'),
            'aria-label': projectNeedsFill ? '初始化并补齐此项目' : '初始化此项目',
            onClick: applyInitScaffold
          }, initBusy === 'apply' ? '初始化中…'
            : projectNeedsFill ? '初始化并补齐此项目'
              : projectReady ? '检查并按需补齐'
                : '初始化此项目');
        } else if (initScan && initScan.mode === 'workspace' && candidates.length > 0) {
          var primaryLabel = chosenReady ? '打开此项目'
            : chosenNeedsFill ? '初始化并补齐所选项目'
              : '初始化所选项目';
          var primaryAria = chosenReady ? '打开所选项目'
            : chosenNeedsFill ? '初始化并补齐所选项目'
              : '初始化所选项目';
          primary = h('button', {
            type: 'button',
            className: 'mc-btn mc-btn-sm mc-btn-primary',
            disabled: initBusy !== null || !chosen,
            title: chosenInfo ? modelcheckStateTitle(chosenInfo) : undefined,
            'aria-label': primaryAria,
            onClick: chosenReady ? selectInitCandidate : applyInitScaffold
          }, initBusy === 'select' ? '切换中…'
            : initBusy === 'apply' ? '初始化中…'
              : primaryLabel);
        }

        return h('div', { className: 'mc-init', role: 'region', 'aria-label': initTitleLabel() },
          h('div', { className: 'mc-init-head' },
            h('span', { className: 'mc-init-title' }, initTitleLabel()),
            initScan && initScan.mode ? h('span', { className: 'mc-badge' },
              initScan.mode === 'project' ? '单项目目录' : '工作区候选') : null,
            h('span', { className: 'mc-spacer' }),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm mc-btn-ghost',
              'aria-label': '关闭初始化面板',
              onClick: closeInit
            }, '关闭')
          ),
          h('p', { className: 'mc-init-note' },
            '这一步只生成 .modelcheck/config.json 与 components.json，不生成判据；' +
            '判据仍需依据项目《科学性文档》《开发文档》用 modelcheck_contract 起草，并由你在面板确认。'),
          h('p', { className: 'mc-init-note' },
            '注意：空的 .modelcheck 目录不算已初始化（空目录或半成品都按未完成处理），会补齐 config.json + components.json；' +
            '已有且有效的文件不会被覆盖。'),
          busyLabel ? h('p', { className: 'mc-init-note' }, busyLabel) : null,
          initError ? h('div', { className: 'mc-notice mc-notice-error' }, initError.message || '操作失败') : null,
          initApply && initApply.readiness ? renderReadinessChecks(initApply.readiness) : null,
          !initApply && initScan && initScan.readiness ? renderReadinessChecks(initScan.readiness) : null,
          initApply ? renderInitApplied() : null,
          !initApply && initScan && initScan.mode === 'project' ? renderInitProjectScan() : null,
          !initApply && initScan && initScan.mode === 'workspace' && candidates.length > 0
            ? h('div', null,
              h('div', { className: 'mc-sub' },
                '扫描 ' + (isFiniteNumber(initScan.scannedDirs) ? initScan.scannedDirs + ' 个目录' : '会话工作区') +
                (initScan.selected ? ' · 当前已绑定一个项目' : '') +
                ' · 选择要初始化的项目（已初始化的可直接打开；空目录/部分初始化会补齐）'),
              h('div', { className: 'mc-candidates', role: 'radiogroup', 'aria-label': '可初始化的模型项目' },
                candidates.map(function (candidate, index) { return renderInitCandidate(candidate, index); }))
            )
            : null,
          !initApply && initScan && initScan.mode === 'workspace' && candidates.length === 0
            ? h('div', { className: 'mc-empty' },
              '未找到可初始化的模型项目：目录里需要 index.html、dist/index.html 或 package.json 之一。')
            : null,
          h('div', { className: 'mc-init-actions' },
            primary,
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              disabled: initBusy !== null,
              'aria-label': '重新扫描可初始化项目',
              onClick: scanInitCandidates
            }, initBusy === 'scan' ? '扫描中…' : '重新扫描'),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm mc-btn-ghost',
              onClick: closeInit
            }, '取消')
          )
        );
      }

      function initTitleLabel() {
        return initKind === 'switch' ? '切换项目' : '初始化 .modelcheck';
      }

      function renderTabs() {
        var requestList = Array.isArray(annotations && annotations.requests) ? annotations.requests : [];
        var openRequests = requestList.filter(function (request) {
          return request && request.state !== 'closed' && request.state !== 'withdrawn';
        }).length;
        return h('div', { className: 'mc-tabs', role: 'tablist', 'aria-label': '建模判定页签' },
          TABS.map(function (item) {
            var selected = tab === item.id;
            var count = item.id === 'requests' && openRequests > 0 ? openRequests : 0;
            return h('button', {
              key: item.id,
              type: 'button',
              role: 'tab',
              id: instanceId.current + '-tab-' + item.id,
              'aria-controls': instanceId.current + '-panel-' + item.id,
              'aria-selected': selected ? 'true' : 'false',
              tabIndex: selected ? 0 : -1,
              className: 'mc-tab',
              onClick: function () { switchTab(item.id); },
              onKeyDown: function (event) {
                var index = -1;
                for (var i = 0; i < TABS.length; i += 1) if (TABS[i].id === item.id) index = i;
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                event.preventDefault();
                var nextIndex = event.key === 'ArrowRight'
                  ? (index + 1) % TABS.length
                  : (index - 1 + TABS.length) % TABS.length;
                var nextTab = TABS[nextIndex];
                switchTab(nextTab.id);
                var nextButton = document.getElementById(instanceId.current + '-tab-' + nextTab.id);
                if (nextButton) nextButton.focus();
              }
            },
              h('span', null, item.label),
              count > 0
                ? h('span', { className: 'mc-tab-count', 'aria-label': openRequests + ' 个待处理请求' }, String(count))
                : null
            );
          })
        );
      }

      function renderHeader() {
        var project = readProject(statusData);
        var title = safeString(project.title, 120) || safeString(project.projectId, 120) || 'ModelCheck';
        var route = readRoute(statusData);
        var contract = readContract(statusData);
        var version = safeString(contract.version || contract.contractVersion, 40);
        var confirmed = contract.confirmed === true || contract.status === 'confirmed';
        var certification = readCertification(statusData);
        var certified = certification.certified === true;
        var selection = isPlainObject(statusData && statusData.selection) ? statusData.selection : {};
        var selectedRoot = safeString(selection.root, 400);
        return h('div', { className: 'mc-header' },
          h('h2', { className: 'mc-title', title: selectedRoot || title },
            title + (selection.selected ? '（已绑定）' : '')),
          h('div', { className: 'mc-meta' },
            route ? h('span', { className: 'mc-badge' }, '路线：' + ROUTE_LABELS[route]) : null,
            version
              ? h('span', { className: 'mc-badge' + (confirmed ? ' mc-badge-ok' : ' mc-badge-warn') },
                '契约 v' + version + (confirmed ? ' · 已确认' : ' · 待确认'))
              : h('span', { className: 'mc-badge' }, '契约未建立'),
            h('span', { className: 'mc-badge' + (certified ? ' mc-badge-ok' : '') }, certified ? '已认证' : '未认证')
          ),
          h('div', { className: 'mc-header-actions' },
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-label': '切换项目（扫描会话工作区里的其它模型目录）',
              title: selectedRoot ? '当前绑定：' + selectedRoot : '扫描并切换模型项目',
              onClick: function () { openInit('switch'); }
            }, '切换项目'),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-label': '重新读取项目状态',
              title: '重新读取项目状态',
              onClick: refreshAll
            }, '刷新')
          )
        );
      }

      function renderReadinessChecks(data) {
        var checks = data && Array.isArray(data.checks) ? data.checks : [];
        if (checks.length === 0) return null;
        return h('ul', { className: 'mc-item-list', style: { marginTop: 6 } }, checks.map(function (check, index) {
          var ok = !!(check && check.ok === true);
          var block = !!(check && check.severity === 'block');
          return h('li', { key: (check && check.id) || ('chk-' + index), className: 'mc-item' },
            h('div', { className: 'mc-row', style: { alignItems: 'flex-start' } },
              h('span', { className: 'mc-badge' + (ok ? ' mc-badge-ok' : ' mc-badge-warn') },
                ok ? '通过' : (block ? '阻塞' : '提醒')),
              h('span', { className: 'mc-mono' }, safeString(check && check.id, 80) || ''),
              h('span', { className: 'mc-sub', style: { flex: 1 } }, safeString(check && check.detail, 400) || '')),
            !ok && check && check.remedy
              ? h('div', { className: 'mc-sub', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                '补救：' + safeString(check.remedy, 400))
              : null);
        }));
      }

      function renderReadinessBanner() {
        if (!readiness) return null;
        var data = readiness.data || null;
        var checks = data && Array.isArray(data.checks) ? data.checks : [];
        var blocks = checks.filter(function (check) { return check && check.ok !== true && check.severity === 'block'; }).length;
        var warns = checks.filter(function (check) { return check && check.ok !== true && check.severity !== 'block'; }).length;
        var summary = data && data.blocked
          ? '接入就绪：被阻塞' + (data.reason ? '（' + safeString(data.reason, 200) + '）' : '')
          : '接入就绪 ' + String(checks.length - blocks - warns) + '/' + String(checks.length) +
            (blocks > 0 ? ' · ' + blocks + ' 个阻塞' : '') + (warns > 0 ? ' · ' + warns + ' 个提醒' : '');
        return h('div', { className: 'mc-readiness' },
          h('div', { className: 'mc-row' },
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-expanded': readinessOpen ? 'true' : 'false',
              'aria-label': '展开或收起接入就绪检查',
              onClick: function () { setReadinessOpen(!readinessOpen); }
            }, (readinessOpen ? '▾ ' : '▸ ') + summary),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm mc-btn-ghost',
              'aria-label': '重新读取接入就绪',
              onClick: loadReadiness
            }, '刷新')
          ),
          readinessOpen ? renderReadinessChecks(data) : null,
          readinessOpen && data && data.blocked && data.remedy
            ? h('p', { className: 'mc-sub' }, '补救：' + safeString(data.remedy, 400))
            : null,
          readinessOpen && data && Array.isArray(data.nextActions) && data.nextActions.length > 0
            ? h('ol', { className: 'mc-list-plain' }, data.nextActions.slice(0, 8).map(function (item, index) {
              return h('li', { key: 'na-' + index }, String(item));
            }))
            : null,
          readiness.error ? h('div', { className: 'mc-notice mc-notice-error' }, readiness.error) : null
        );
      }

      function renderProposal() {
        if (!hasProposal(statusData)) return null;
        var contract = readContract(statusData);
        var proposedVersion = null;
        if (isPlainObject(contract.proposed)) {
          proposedVersion = safeString(contract.proposed.contractVersion, 40) ||
            (isPlainObject(contract.proposed.contract) ? safeString(contract.proposed.contract.contractVersion, 40) : null);
        }
        var hash = readProposedHash(statusData);
        return h('div', { className: 'mc-proposal', role: 'status' },
          h('strong', null, '契约待确认'),
          h('span', null, proposedVersion ? '提议版本 v' + proposedVersion : '存在一份 agent 提议的契约'),
          h('span', { className: 'mc-mono' }, hash ? '哈希 ' + hash.slice(0, 18) + '…' : '缺少内容哈希'),
          h('span', { className: 'mc-spacer' }),
          h('button', {
            type: 'button',
            className: 'mc-btn mc-btn-sm mc-btn-primary',
            disabled: confirming || !hash,
            'aria-label': '确认这份契约（以你的身份记录确认）',
            onClick: confirmContract
          }, confirming ? '确认中…' : '确认契约'),
          h('span', { className: 'mc-sub' }, '确认只由你的点击产生，agent 工具没有这个能力')
        );
      }

      function renderNotice() {
        if (!notice) return null;
        var extra = '';
        if (notice.kind === 'error') extra = ' mc-notice-error';
        else if (notice.kind === 'success') extra = ' mc-notice-success';
        return h('div', { className: 'mc-notice' + extra, role: 'status', 'aria-live': 'polite' }, notice.text);
      }

      function renderInert() {
        return h('div', { className: 'mc-body' },
          h('div', { className: 'mc-inert' },
            h('div', { className: 'mc-inert-title' }, '建模判定面板处于待命状态'),
            h('p', { style: { margin: 0 } },
              statusError || '当前项目未初始化 .modelcheck，本面板不参与验收，也不会影响正常对话。'),
            h('p', { style: { margin: 0 } },
              '可以直接在这里扫描会话工作区里的模型目录并生成 .modelcheck（只写 config.json 与 components.json）；' +
              '也可以让 agent 建立，再点「刷新」。'),
            h('div', { className: 'mc-row', style: { marginTop: 8 } },
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btn-sm mc-btn-primary',
                'aria-label': '扫描可初始化的模型项目',
                onClick: function () { openInit('inert'); }
              }, '扫描可初始化项目'),
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btn-sm',
                'aria-label': '直接刷新项目状态',
                onClick: refreshAll
              }, '刷新状态')
            )
          ),
          initOpen ? h('div', { style: { marginTop: 10 } }, renderInitPanel()) : null
        );
      }

      function renderLoading() {
        return h('div', { className: 'mc-body' }, h('div', { className: 'mc-empty' }, '正在读取项目状态…'));
      }

      function renderError() {
        return h('div', { className: 'mc-body' },
          h('div', { className: 'mc-inert' },
            h('div', { className: 'mc-inert-title' }, '读取项目状态失败'),
            h('p', { style: { margin: 0 } }, statusError || '宿主接口暂不可用。'),
            h('div', { className: 'mc-row' },
              h('button', { type: 'button', className: 'mc-btn mc-btn-sm', onClick: refreshAll }, '重试')
            )
          )
        );
      }

      function maybeSourceFallback(criterion) {
        var source = criterion && isPlainObject(criterion.source) ? criterion.source : null;
        if (source) {
          var doc = safeString(source.doc, 200);
          if (doc) return doc + (safeString(source.section, 80) ? ' ' + safeString(source.section, 80) : '');
        }
        return '—';
      }

      function renderVerdict() {
        var list = Array.isArray(criteria) ? criteria : (statusData && Array.isArray(statusData.criteria) ? statusData.criteria : []);
        var counts = summarizeCriteria(list);
        var contract = readContract(statusData);
        var version = safeString(contract.version || contract.contractVersion, 40);
        var confirmed = contract.confirmed === true || contract.status === 'confirmed';
        return h('div', { className: 'mc-body' },
          h('div', { className: 'mc-summary' },
            h('span', { className: 'mc-chip' }, h('b', null, String(counts.total)), '条判据'),
            h('span', { className: 'mc-chip' }, '通过 ', h('b', null, String(counts.pass))),
            h('span', { className: 'mc-chip' }, '未通过 ', h('b', null, String(counts.fail))),
            h('span', { className: 'mc-chip' }, '无法判定 ', h('b', null, String(counts.inconclusive + counts.stale))),
            h('span', { className: 'mc-chip' }, '未验证 ', h('b', null, String(counts.unverified))),
            counts.blockingOpen > 0
              ? h('span', { className: 'mc-chip', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                '阻塞未通过 ', h('b', null, String(counts.blockingOpen)))
              : null,
            hasProposal(statusData) ? h('span', { className: 'mc-chip' }, '契约有未确认提案') : null,
            h('span', { className: 'mc-spacer' }),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-label': '重新读取判据',
              onClick: function () { loadCriteria(); loadStatus(); }
            }, '重新读取')
          ),
          version && !confirmed
            ? h('p', { className: 'mc-hint' }, '契约尚未由你确认：判据可以读取，但完成门禁不会签发认证。')
            : null,
          list.length === 0
            ? h('div', { className: 'mc-empty' }, '未发现判据：契约可能尚未建立或尚未确认。')
            : h('div', { className: 'mc-table-wrap' },
              h('table', { className: 'mc-table' },
                h('thead', null,
                  h('tr', null,
                    h('th', { scope: 'col' }, '判据'),
                    h('th', { scope: 'col' }, '级别'),
                    h('th', { scope: 'col' }, '阻塞'),
                    h('th', { scope: 'col' }, '状态'),
                    h('th', { scope: 'col' }, '实测'),
                    h('th', { scope: 'col' }, '断言'),
                    h('th', { scope: 'col' }, '证据位置')
                  )
                ),
                h('tbody', null,
                  list.map(function (criterion) {
                    var id = safeString(criterion.id, 120) || '（无 id）';
                    var status = typeof criterion.status === 'string' ? criterion.status : 'unverified';
                    var label = STATUS_LABELS[status] || status;
                    return h('tr', { key: id },
                      h('td', { className: 'mc-col-id' }, id),
                      h('td', { className: 'mc-col-nowrap' }, safeString(criterion.level, 8) || '—'),
                      h('td', { className: 'mc-col-nowrap' }, criterion.blocking === true ? '是' : '否'),
                      h('td', { className: 'mc-col-nowrap mc-status-' + status }, label),
                      h('td', null,
                        readMeasured(criterion)
                          ? h('span', { className: 'mc-mono' }, readMeasured(criterion))
                          : h('span', { className: 'mc-sub' }, '—'),
                        criterion.detail ? h('div', { className: 'mc-sub' }, String(criterion.detail).slice(0, 200)) : null,
                        criterion.remedy ? h('div', { className: 'mc-sub' }, String(criterion.remedy).slice(0, 200)) : null
                      ),
                      h('td', null, readAssertion(criterion) || h('span', { className: 'mc-sub' }, '—')),
                      h('td', null, criterionLocation(criterion) || h('span', { className: 'mc-sub' }, maybeSourceFallback(criterion)))
                    );
                  })
                )
              )
            )
        );
      }

      function selectUnit(component, partKey, instanceKey) {
        if (!component || !safeString(component.id, 120)) return;
        var partLabel = null;
        var instanceLabel = null;
        if (partKey && Array.isArray(component.parts)) {
          for (var p = 0; p < component.parts.length; p += 1) {
            if (component.parts[p] && component.parts[p].key === partKey) partLabel = safeString(component.parts[p].label, 120);
          }
        }
        if (instanceKey && Array.isArray(component.instances)) {
          for (var q = 0; q < component.instances.length; q += 1) {
            if (component.instances[q] && component.instances[q].key === instanceKey) instanceLabel = safeString(component.instances[q].label, 120);
          }
        }
        setPicked({
          componentId: component.id,
          unknown: false,
          kind: safeString(component.kind, 24),
          partKey: partKey || null,
          instanceKey: instanceKey || null,
          instanceId: null,
          partLabel: partLabel,
          instanceLabel: instanceLabel,
          objectName: null,
          chain: [],
          worldPoint: null,
          pick: component.pick,
          label: composeComponentLabel(component.id, component, null),
          locator: isPlainObject(component.locator) ? component.locator : null,
          related: Array.isArray(component.related) ? component.related : [],
          selection: unitSelectionId(component.id, partKey || null, instanceKey || null),
          at: null
        });
        setDraftText('');
      }

      function renderUnknownPickCard() {
        var chain = Array.isArray(picked && picked.chain) ? picked.chain : [];
        return h('div', { className: 'mc-card' },
          h('div', { className: 'mc-card-title' },
            h('span', null, '未登记的几何'),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm mc-btn-ghost',
              'aria-label': '取消选中',
              onClick: function () { setPicked(null); setDraftText(''); }
            }, '取消')
          ),
          h('p', { className: 'mc-hint', style: { margin: '0 0 6px' } },
            '该几何未登记，请让 agent 用 modelcheck_components 登记（含 kind/instances）。面板不会自动写盘。'),
          h('dl', { className: 'mc-kv' },
            picked && picked.objectName ? h('dt', null, '命中对象') : null,
            picked && picked.objectName ? h('dd', { className: 'mc-mono' }, picked.objectName) : null,
            isFiniteNumber(picked && picked.instanceId) ? h('dt', null, 'instanceId') : null,
            isFiniteNumber(picked && picked.instanceId) ? h('dd', { className: 'mc-mono' }, String(picked.instanceId)) : null,
            picked && picked.worldPoint ? h('dt', null, '世界坐标') : null,
            picked && picked.worldPoint ? h('dd', { className: 'mc-mono' },
              shortJson(picked.worldPoint)) : null
          ),
          chain.length > 0
            ? h('div', null,
              h('div', { className: 'mc-sub', style: { marginTop: 6 } }, '命中链（由近到远）'),
              h('ul', { className: 'mc-list-plain' }, chain.slice(0, 12).map(function (item, index) {
                return h('li', { key: 'chain-' + index },
                  (item.name || '(unnamed)') + (item.mcId ? ' · mcId=' + item.mcId : '') + (item.kind ? ' · ' + kindLabelOf(item.kind) : ''));
              }))
            )
            : null
        );
      }

      function renderComponentTree() {
        var list = (Array.isArray(components) ? components : []).filter(function (component) {
          return component && safeString(component.id, 120) && component.annotatable !== false;
        });
        if (list.length === 0) return null;
        var groups = {};
        list.forEach(function (component) {
          var kind = safeString(component.kind, 24) || 'other';
          if (!groups[kind]) groups[kind] = [];
          groups[kind].push(component);
        });
        var order = KIND_ORDER.filter(function (kind) { return groups[kind]; });
        Object.keys(groups).forEach(function (kind) { if (order.indexOf(kind) < 0) order.push(kind); });
        function unitRow(component, partKey, instanceKey, label, selection) {
          var key = selection || unitSelectionId(component.id, partKey, instanceKey);
          var active = picked && picked.selection === key;
          return h('li', { key: key, className: 'mc-item' },
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm' + (active ? ' mc-btn-primary' : ' mc-btn-ghost') + ' mc-unit-pick',
              'aria-label': '选择几何单元 ' + key,
              onClick: function () { selectUnit(component, partKey, instanceKey); }
            }, label),
            h('span', { className: 'mc-sub mc-mono', style: { marginLeft: 6 } }, key)
          );
        }
        return h('div', { className: 'mc-card' },
          h('div', { className: 'mc-card-title' },
            h('span', null, '几何单元'),
            h('span', { className: 'mc-sub' }, '按 kind 分组，可展开部件/实例')),
          order.map(function (kind) {
            return h('details', { key: 'kind-' + kind, className: 'mc-unit-group', open: true },
              h('summary', null, kindLabelOf(kind) + '（' + groups[kind].length + '）'),
              h('ul', { className: 'mc-item-list' }, groups[kind].map(function (component) {
                return h('li', { key: component.id, className: 'mc-item' },
                  unitRow(component, null, null,
                    (safeString(component.label, 120) || component.id) + '（' + component.id + '）'),
                  Array.isArray(component.parts) && component.parts.length > 0
                    ? h('details', { className: 'mc-unit-sub' },
                      h('summary', null, '部件（' + component.parts.length + '）'),
                      h('ul', { className: 'mc-item-list' }, component.parts.map(function (part) {
                        var pk = safeString(part && part.key, 120);
                        if (!pk) return null;
                        return unitRow(component, pk, null, (safeString(part.label, 120) || pk) + ' · ' + pk);
                      })))
                    : null,
                  Array.isArray(component.instances) && component.instances.length > 0
                    ? h('details', { className: 'mc-unit-sub' },
                      h('summary', null, '实例（' + component.instances.length + '）'),
                      h('ul', { className: 'mc-item-list' }, component.instances.map(function (instance) {
                        var ik = safeString(instance && instance.key, 120);
                        if (!ik) return null;
                        return unitRow(component, null, ik, (safeString(instance.label, 120) || ik) + ' · ' + ik);
                      })))
                    : null
                );
              }))
            );
          })
        );
      }

      function renderPickCard() {
        if (!picked) {
          return h('div', { className: 'mc-card' },
            h('div', { className: 'mc-card-title' }, h('span', null, '点选组件')),
            h('p', { className: 'mc-hint', style: { margin: 0 } },
              pickMode
                ? '已进入标注模式：在左侧预览里点击组件。'
                : '点「标注模式」后，在左侧预览里点中要改的组件。'),
            pickMode ? null : h('div', { className: 'mc-row', style: { marginTop: 8 } },
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btn-sm',
                disabled: !iframeReady,
                'aria-label': '进入标注模式',
                onClick: function () { togglePickMode(true); }
              }, iframeReady ? '进入标注模式' : '预览未就绪')
            )
          );
        }
        if (picked.unknown) return renderUnknownPickCard();
        var related = Array.isArray(picked.related) ? picked.related : [];
        var breadcrumb = [picked.label || picked.componentId];
        if (picked.partKey) breadcrumb.push(picked.partLabel || picked.partKey);
        if (picked.instanceKey) breadcrumb.push(picked.instanceLabel || picked.instanceKey);
        var locator = locateText(picked.locator);
        return h('div', { className: 'mc-card' },
          h('div', { className: 'mc-card-title' },
            h('span', null, '已选中组件'),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm mc-btn-ghost',
              'aria-label': '取消选中',
              onClick: function () { setPicked(null); setDraftText(''); }
            }, '取消')
          ),
          h('dl', { className: 'mc-kv' },
            h('dt', null, '几何单元'), h('dd', { className: 'mc-item-name' }, breadcrumb.join(' › ')),
            picked.kind ? h('dt', null, '类型') : null,
            picked.kind ? h('dd', null, kindLabelOf(picked.kind)) : null,
            picked.selection ? h('dt', null, '选择标识') : null,
            picked.selection ? h('dd', { className: 'mc-mono' }, picked.selection) : null,
            locator ? h('dt', null, '代码位置') : null,
            locator ? h('dd', { className: 'mc-mono' }, locator) : null,
            related.length ? h('dt', null, '关联判据') : null,
            related.length ? h('dd', { className: 'mc-mono' }, related.join(', ')) : null
          ),
          h('div', { className: 'mc-field', style: { marginTop: 8 } },
            h('label', { className: 'mc-field-label', htmlFor: instanceId.current + '-req' },
              '要改什么（你的原话会原文保存，不改写）'),
            h('textarea', {
              id: instanceId.current + '-req',
              className: 'mc-textarea',
              value: draftText,
              rows: 4,
              maxLength: MAX_ITEM_TEXT,
              placeholder: '例如：这个箭头方向反了，应该是从东北吹向西南',
              'aria-label': '这条标注的要求',
              onChange: function (event) { setDraftText(event.target.value); }
            })
          ),
          h('div', { className: 'mc-row' },
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm mc-btn-primary',
              disabled: !draftText || !draftText.trim(),
              'aria-label': '保存为待发送标注',
              onClick: addPendingItem
            }, '保存为待发送'),
            h('span', { className: 'mc-sub' }, pendingItems.length + ' 条待发送')
          )
        );
      }

      function renderPendingItems() {
        return h('div', { className: 'mc-card' },
          h('div', { className: 'mc-card-title' },
            h('span', null, '待发送标注（' + pendingItems.length + '）'),
            h('span', { className: 'mc-sub' }, '可编辑 / 删除；发送后才生成请求')
          ),
          pendingItems.length === 0
            ? h('p', { className: 'mc-hint', style: { margin: 0 } }, '还没有待发送标注。')
            : h('ul', { className: 'mc-item-list' },
              pendingItems.map(function (item) {
                var editing = item.editing === true;
                var locator = locateText(item.locator);
                return h('li', { key: item.localId, className: 'mc-item' },
                  h('div', { className: 'mc-item-head' },
                    h('div', { style: { minWidth: 0 } },
                      h('div', { className: 'mc-item-name' }, item.label || item.componentId),
                      h('div', { className: 'mc-sub mc-mono' }, item.componentId + (item.selection ? ' · ' + item.selection : '')),
                      locator ? h('div', { className: 'mc-sub mc-mono' }, locator) : null,
                      h('div', { className: 'mc-sub' },
                        item.screenshot ? '含截图（three 画布）' : '无截图（该路线面板内不可截图，未伪造）')
                    ),
                    h('div', { className: 'mc-item-actions' },
                      h('button', {
                        type: 'button',
                        className: 'mc-btn mc-btn-sm mc-btn-ghost',
                        'aria-label': editing ? '完成编辑这条标注' : '编辑这条标注',
                        onClick: function () { toggleEditPendingItem(item.localId); }
                      }, editing ? '完成' : '编辑'),
                      h('button', {
                        type: 'button',
                        className: 'mc-btn mc-btn-sm mc-btn-ghost mc-btn-danger',
                        'aria-label': '删除这条标注',
                        onClick: function () { deletePendingItem(item.localId); }
                      }, '删除')
                    )
                  ),
                  editing
                    ? h('div', { style: { marginTop: 6 } },
                      h('textarea', {
                        className: 'mc-textarea mc-input-sm',
                        value: item.userText,
                        rows: 3,
                        maxLength: MAX_ITEM_TEXT,
                        'aria-label': '编辑标注要求',
                        onChange: function (event) { updatePendingItemText(item.localId, event.target.value); }
                      })
                    )
                    : h('p', { className: 'mc-item-text' }, item.userText)
                );
              })
            ),
          h('div', { className: 'mc-row', style: { marginTop: 8 } },
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm mc-btn-primary',
              disabled: sending || pendingItems.length === 0,
              'aria-label': '发送本批标注到会话',
              onClick: sendPendingItems
            }, sending ? '发送中…' : (sendError ? '重试发送' : '发送本批')),
            h('span', { className: 'mc-sub' }, '失败可重试：复用同一批次，不重复生成请求')
          ),
          sendError ? h('div', { className: 'mc-notice mc-notice-error' }, sendError) : null
        );
      }

      function renderDraftBatches() {
        var batches = Array.isArray(annotations && annotations.batches) ? annotations.batches : [];
        var drafts = batches.filter(function (batch) { return batch && batch.status === 'draft'; });
        if (drafts.length === 0) return null;
        return h('div', { className: 'mc-card' },
          h('div', { className: 'mc-card-title' }, h('span', null, '磁盘上的未发送批次')),
          h('ul', { className: 'mc-item-list' },
            drafts.map(function (batch) {
              var batchId = safeString(batch.id, 120);
              var items = Array.isArray(batch.items) ? batch.items : [];
              return h('li', { key: batchId || uid('batch'), className: 'mc-item' },
                h('div', { className: 'mc-item-head' },
                  h('div', { style: { minWidth: 0 } },
                    h('div', { className: 'mc-item-name mc-mono' }, batchId || '（无 id）'),
                    h('div', { className: 'mc-sub' },
                      items.length + ' 条 · 创建于 ' + (formatTime(batch.createdAt) || '未知时间'))
                  ),
                  h('div', { className: 'mc-item-actions' },
                    h('button', {
                      type: 'button',
                      className: 'mc-btn mc-btn-sm',
                      disabled: sending || !batchId,
                      'aria-label': '发送这个草稿批次',
                      onClick: function () { sendExistingBatch(batchId); }
                    }, '发送')
                  )
                ),
                items.slice(0, 6).map(function (item, index) {
                  return h('p', { key: (batchId || 'batch') + '-' + index, className: 'mc-item-text' },
                    '· ' + (safeString(item.componentId, 120) || '未命名组件') + '：' +
                    (safeString(item.userText, 500) || '（无文字）'));
                })
              );
            })
          )
        );
      }

      function renderPreviewPane() {
        var entry = readPreviewEntry(statusData);
        var url = buildPreviewUrl(sessionId, entry, previewVersion);
        var route = readRoute(statusData);
        var unitToPx = readUnitToPx(statusData);
        return h('div', { className: 'mc-preview-pane' },
          h('div', { className: 'mc-preview-bar' },
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-pressed': pickMode ? 'true' : 'false',
              disabled: !iframeReady,
              title: '打开后点击预览里的组件即可选中',
              'aria-label': '标注模式开关',
              onClick: function () { togglePickMode(!pickMode); }
            }, pickMode ? '标注模式：开' : '标注模式：关'),
            h('span', { className: 'mc-sub' },
              (iframeReady ? '预览已连接' : '预览未连接') +
              (previewInfo && previewInfo.route ? ' · 桥接路线 ' + (ROUTE_LABELS[previewInfo.route] || previewInfo.route) : '') +
              ' · unitToPx ' + String(unitToPx) +
              (evidencePending > 0 ? ' · 取证中 ' + evidencePending : '')),
            h('span', { className: 'mc-spacer' }),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-label': '重新加载预览',
              title: '重新加载预览（新构建号）',
              onClick: function () {
                setIframeReady(false);
                setPreviewError(null);
                setPreviewVersion(Date.now());
              }
            }, '重载预览')
          ),
          h('div', { className: 'mc-preview-frame' },
            h('iframe', {
              ref: iframeRef,
              key: 'mc-preview-' + String(previewVersion),
              title: '模型预览（ModelCheck 标注）',
              src: url,
              // 关键信任边界：不加 allow-same-origin，预览页是不透明源，
              // 模型页脚本无法同源 fetch('/modelcheck/api') 伪造契约确认或人工验收。
              sandbox: 'allow-scripts allow-forms allow-modals',
              onLoad: function () {
                // 不在 load 时清 ready：bridge 的 mc:ready 可能先于 load 到达（两帧稳定很快），
                // 清掉会永久卡在"预览未连接"。这里主动补发一次 hello，让 bridge 再回一次 ready。
                var data = statusDataRef.current;
                postPreviewMessage('mc:hello', {
                  route: readRoute(data),
                  unitToPx: readUnitToPx(data)
                });
              },
              onError: function () { setPreviewError('预览页加载失败（可能是预览入口不存在或不可访问）'); }
            }),
            !iframeReady
              ? h('div', { className: 'mc-preview-overlay' }, previewError || '正在等待预览页与取证桥接握手…')
              : null
          ),
          h('div', { className: 'mc-preview-bar' },
            h('span', { className: 'mc-sub' },
              (route ? '路线 ' + (ROUTE_LABELS[route] || route) : '路线未知') +
              (previewInfo && Array.isArray(previewInfo.capabilities) && previewInfo.capabilities.length
                ? ' · 能力：' + previewInfo.capabilities.join('、')
                : '')),
            h('span', { className: 'mc-spacer' }),
            h('span', { className: 'mc-sub' }, '__VERIFY__=1 才注入桥接；交付版不注入'),
            h('span', { className: 'mc-sub' },
              '预览页运行在不透明源沙箱（无 allow-same-origin）：它不能调用 /modelcheck/api，'
              + '因此模型页里的 fetch()/相对请求可能失败；需要网络数据时请改用内联数据或 svg/dom 路线。')
          )
        );
      }

      function renderAnnotate() {
        var changeText = null;
        if (changeSummary) {
          if (changeSummary.loading) changeText = '构建已变化，正在对比组件指纹…';
          else if (changeSummary.changed && changeSummary.changed.length > 0) {
            changeText = '本次改动：' + changeSummary.changed.length + ' 个组件已变（' +
              changeSummary.changed.slice(0, 8).join('、') +
              (changeSummary.changed.length > 8 ? '…' : '') + '）；其余 ' +
              changeSummary.unchanged + ' 个未变';
          } else if (changeSummary.changed && changeSummary.changed.length === 0) {
            changeText = '构建已变化，但已监测组件的指纹未变（' + changeSummary.unchanged + ' 个）';
          }
        }
        var route = readRoute(statusData);
        return h('div', { className: 'mc-body mc-body-fixed' },
          changeText ? h('div', { className: 'mc-notice', role: 'status' }, changeText) : null,
          route === 'image'
            ? h('p', { className: 'mc-hint' },
              'image 路线：点选只报告登记区域的像素坐标，几何与方向类判据会返回「无法判定」。')
            : null,
          renderNotice(),
          h('div', { className: 'mc-annotate' },
            renderPreviewPane(),
            h('div', { className: 'mc-side' },
              renderPickCard(),
              renderComponentTree(),
              renderPendingItems(),
              renderDraftBatches()
            )
          )
        );
      }

      function renderRequestCard(request) {
        var requestId = safeString(request.id, 120);
        var state = typeof request.state === 'string' ? request.state : 'draft';
        var acceptance = safeString(request.acceptance, 40) || 'auto';
        // 宿主允许 manual / visual / user 三类非自动验收；auto 只能由 modelcheck_verify 关单。
        var manual = acceptance !== 'auto';
        var acceptanceLabel = acceptance === 'auto'
          ? '自动验收'
          : (acceptance === 'visual' ? '视觉验收' : '人工验收');
        var criteriaIds = Array.isArray(request.criteriaIds) ? request.criteriaIds : [];
        var isRejecting = !!(rejecting && rejecting.requestId === requestId);
        var isWithdrawing = !!(withdrawing && withdrawing.requestId === requestId);
        var busy = busyRequest === requestId;
        var closed = state === 'closed' || state === 'withdrawn';
        return h('div', { key: requestId || uid('req'), className: 'mc-request' },
          h('div', { className: 'mc-request-head' },
            h('span', { className: 'mc-request-id' }, requestId || '（无请求 id）'),
            h('span', { className: 'mc-badge' }, REQUEST_STATE_LABELS[state] || state),
            h('span', { className: 'mc-badge' }, acceptanceLabel),
            safeString(request.level, 8) ? h('span', { className: 'mc-badge' }, '级别 ' + safeString(request.level, 8)) : null,
            request.blocking === true ? h('span', { className: 'mc-badge mc-badge-warn' }, '阻塞') : null
          ),
          h('div', { className: 'mc-steps', 'aria-label': '请求状态' },
            REQUEST_STATES.map(function (step) {
              return h('span', {
                key: step,
                className: 'mc-step' + (step === state ? ' mc-step-current' : '')
              }, REQUEST_STATE_LABELS[step] || step);
            })
          ),
          safeString(request.userText, 4000)
            ? h('p', { className: 'mc-item-text' }, safeString(request.userText, 4000))
            : h('p', { className: 'mc-hint' }, '（该请求没有用户原话）'),
          safeString(request.claim, 600)
            ? h('p', { className: 'mc-sub' }, '整理后的要求：' + safeString(request.claim, 600))
            : null,
          criteriaIds.length ? h('p', { className: 'mc-sub mc-mono' }, '关联判据：' + criteriaIds.join(', ')) : null,
          safeString(request.reason, 400) ? h('p', { className: 'mc-sub' }, '原因：' + safeString(request.reason, 400)) : null,
          closed
            ? null
            : h('div', { className: 'mc-row', style: { marginTop: 8 } },
              manual
                ? h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btn-sm mc-btn-primary',
                  disabled: busy,
                  'aria-label': '验收通过这个请求',
                  onClick: function () { acceptRequest(requestId); }
                }, busy ? '提交中…' : '通过')
                : h('span', { className: 'mc-sub' }, '该请求由自动验证关闭；如需人工复核，请让 agent 把验收方式改为 manual/visual/user。'),
              manual
                ? h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btn-sm',
                  disabled: busy,
                  'aria-label': '验收不通过这个请求',
                  onClick: function () { setRejecting({ requestId: requestId, reason: '' }); }
                }, '不通过')
                : null,
              h('button', {
                type: 'button',
                className: 'mc-btn mc-btn-sm mc-btn-ghost',
                disabled: busy,
                'aria-label': '撤回这个请求',
                onClick: function () { setWithdrawing({ requestId: requestId, reason: '' }); }
              }, '撤回')
            ),
          isRejecting
            ? h('div', { style: { marginTop: 8 } },
              h('label', { className: 'mc-field-label', htmlFor: instanceId.current + '-rej-' + requestId },
                '不通过原因（必填）'),
              h('textarea', {
                id: instanceId.current + '-rej-' + requestId,
                className: 'mc-textarea mc-input-sm',
                rows: 2,
                value: rejecting.reason,
                'aria-label': '不通过原因',
                onChange: function (event) { setRejecting({ requestId: requestId, reason: event.target.value }); }
              }),
              h('div', { className: 'mc-row', style: { marginTop: 6 } },
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btn-sm mc-btn-primary',
                  disabled: busy || !String(rejecting.reason || '').trim(),
                  onClick: submitRejection
                }, '确认不通过'),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btn-sm mc-btn-ghost',
                  onClick: function () { setRejecting(null); }
                }, '取消')
              )
            )
            : null,
          isWithdrawing
            ? h('div', { style: { marginTop: 8 } },
              h('label', { className: 'mc-field-label', htmlFor: instanceId.current + '-wd-' + requestId },
                '撤回原因（必填）'),
              h('textarea', {
                id: instanceId.current + '-wd-' + requestId,
                className: 'mc-textarea mc-input-sm',
                rows: 2,
                value: withdrawing.reason,
                'aria-label': '撤回原因',
                onChange: function (event) { setWithdrawing({ requestId: requestId, reason: event.target.value }); }
              }),
              h('div', { className: 'mc-row', style: { marginTop: 6 } },
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btn-sm mc-btn-primary',
                  disabled: busy || !String(withdrawing.reason || '').trim(),
                  onClick: submitWithdraw
                }, '确认撤回'),
                h('button', {
                  type: 'button',
                  className: 'mc-btn mc-btn-sm mc-btn-ghost',
                  onClick: function () { setWithdrawing(null); }
                }, '取消')
              )
            )
            : null
        );
      }

      function renderRequests() {
        var requests = Array.isArray(annotations && annotations.requests) ? annotations.requests : [];
        var open = requests.filter(function (request) {
          return request && request.state !== 'closed' && request.state !== 'withdrawn';
        }).length;
        return h('div', { className: 'mc-body' },
          renderNotice(),
          h('div', { className: 'mc-summary' },
            h('span', { className: 'mc-chip' }, '共 ', h('b', null, String(requests.length)), ' 条请求'),
            h('span', { className: 'mc-chip' }, '待处理 ', h('b', null, String(open))),
            h('span', { className: 'mc-spacer' }),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-label': '重新读取请求',
              onClick: loadAnnotations
            }, '重新读取')
          ),
          requests.length === 0
            ? h('div', { className: 'mc-empty' },
              '没有变更请求。在「标注」里点选组件并发送一批标注后，请求会出现在这里。')
            : requests.map(function (request) { return renderRequestCard(request); })
        );
      }

      function renderReport() {
        var text = null;
        var certification = readCertification(statusData);
        if (report) {
          if (typeof report.report === 'string') text = report.report;
          else if (typeof report.text === 'string') text = report.text;
          else if (typeof report.reportText === 'string') text = report.reportText;
          else if (isPlainObject(report.report)) text = JSON.stringify(report.report, null, 2);
        }
        var artifacts = [];
        if (report && Array.isArray(report.artifacts)) artifacts = report.artifacts;
        else if (report && report.record && Array.isArray(report.record.artifacts)) artifacts = report.record.artifacts;
        else if (certification && Array.isArray(certification.artifacts)) artifacts = certification.artifacts;
        var at = report && (report.at || report.capturedAt) ? formatTime(report.at || report.capturedAt) : '';
        var path = report ? safeString(report.path, 400) : null;
        var artifactBase = safeString(report && report.artifactBase, 300) ||
          ('/modelcheck/artifact/' + encodeURIComponent(sessionId) + '/');
        var certified = certification && certification.certified === true;
        return h('div', { className: 'mc-body' },
          renderNotice(),
          h('div', { className: 'mc-summary' },
            h('span', { className: 'mc-chip' }, certified ? '认证：已签发' : '认证：未签发'),
            at ? h('span', { className: 'mc-chip' }, '报告时间 ', h('b', null, at)) : null,
            h('span', { className: 'mc-spacer' }),
            h('button', {
              type: 'button',
              className: 'mc-btn mc-btn-sm',
              'aria-label': '重新读取最近报告',
              onClick: loadReport
            }, '重新读取')
          ),
          text
            ? h('pre', { className: 'mc-pre' }, text)
            : h('div', { className: 'mc-empty' },
              '尚无报告。完成门禁通过（或生成未认证记录）后，这里会有最近一份一页式报告。'),
          path ? h('p', { className: 'mc-sub' }, '报告文件：' + path + '（磁盘路径，浏览器内不可直接打开）') : null,
          artifacts.length > 0
            ? h('div', { className: 'mc-card', style: { marginTop: 10 } },
              h('div', { className: 'mc-card-title' }, h('span', null, '取证产物')),
              h('ul', { className: 'mc-link-list' },
                artifacts.map(function (artifact, index) {
                  var name = typeof artifact === 'string'
                    ? artifact
                    : (artifact.name || artifact.path || artifact.hash || '');
                  var href = artifactHref(artifactBase, name);
                  return h('li', { key: 'artifact-' + index, className: 'mc-mono' },
                    href
                      ? h('a', {
                        href: href,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        title: '在浏览器里打开该取证产物'
                      }, String(name))
                      : String(name) + '（无法构造产物链接）');
                })
              )
            )
            : null
        );
      }

      function renderBody() {
        if (!sessionId) return renderInert();
        if (mode === 'inert') return renderInert();
        if (mode === 'loading') return renderLoading();
        if (mode === 'error') return renderError();
        if (tab === 'annotate') return renderAnnotate();
        if (tab === 'requests') return renderRequests();
        if (tab === 'report') return renderReport();
        return renderVerdict();
      }

      // ── 组装 ──────────────────────────────────────────────────────────────
      var showChrome = !!sessionId && mode === 'ready';
      return h('div', {
        className: 'mc-panel',
        'data-mc-panel': 'modelcheck',
        'data-session': sessionId || undefined
      },
        showChrome ? renderHeader() : null,
        showChrome ? renderProposal() : null,
        showChrome ? renderReadinessBanner() : null,
        showChrome ? renderTabs() : null,
        showChrome && initOpen ? h('div', { className: 'mc-init-slot' }, renderInitPanel()) : null,
        showChrome ? null : renderNotice(),
        h('div', {
          role: 'tabpanel',
          id: instanceId.current + '-panel-' + tab,
          'aria-labelledby': instanceId.current + '-tab-' + tab,
          style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 }
        }, renderBody())
      );
    }

    // ── 插件本体 ────────────────────────────────────────────────────────────
    return {
      name: 'modelcheck-client',
      inject: ['slots'],
      apply: function (ctx) {
        ensureStyles();
        ctx.effect(function () {
          return function () { removeStyles(); };
        }, 'modelcheck-client:styles');

        ctx.effect(function () {
          var dispose = ctx.slots.inject(SLOT, function () {
            return ctx.slots.register(
              {
                name: SLOT,
                id: 'modelcheck-panel',
                order: 90,
                label: function () { return '建模判定'; }
              },
              ModelCheckPanel
            );
          });
          return function () {
            if (typeof dispose === 'function') dispose();
          };
        }, 'modelcheck-client:view');
      }
    };
  }
});
