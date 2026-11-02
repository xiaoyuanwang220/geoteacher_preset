/*
 * ModelCheck · 取证与点选桥接（assets/bridge.js）
 *
 * 形态：普通脚本 IIFE，零构建、无 import、不依赖任何宿主包，也不要求页面把 THREE 挂到全局。
 * 注入：由宿主半边 server/preview.js 注入到模型预览页入口 HTML 的 </body> 前，地址
 *       /modelcheck/assets/bridge.js（可带 data-mc-build="<构建哈希>"）。
 *
 * 职责（只做这三件事）：
 *   1. 握手：页面加载 + 2 帧稳定后向父面板发 mc:ready（route / entryUrl / capabilities / buildHash）。
 *   2. 取证：收到 mc:collect 后，按组件 pick 导出**实际运行时**属性——
 *      three：worldPosition（matrixWorld 平移）、worldDirection（世界基向量 × 约定轴）、
 *             visibility 链、属性白名单、父链名称；
 *      svg/dom：getBoundingClientRect（按 unitToPx 换算世界单位）、path 端点（getTotalLength /
 *             getPointAtLength + getScreenCTM）、起止方向方位角、计算样式可见性与透明度、属性白名单；
 *      image：只导出登记区域的像素矩形，不声称几何。
 *   3. 点选：mc:pick-mode 打开后做命中测试（three 优先 raycaster，拿不到 THREE 时退化为
 *      屏幕空间包围盒投影；svg/dom 用 event.target 向上找 [data-mc-id]），非破坏性高亮，退出还原。
 *   另：mc:screenshot 只在 three 真有 renderer.domElement.toDataURL 时截图；DOM/SVG 明确返回
 *      null + 原因，绝不声称已截图。
 *
 * 铁律：
 *   · 只听 window.parent、只认 channel==='modelcheck' 与类型白名单、JSON 结构/大小；
 *     预览页被宿主 sandbox 成不透明源（不带 allow-same-origin），自身 origin 是 'null'，
 *     所以出站目标源用 '*'，入站不做 origin 等值判断（source 校验才是锚点）；
 *   · 不修改模型数据（高亮只改材质发光/透明度或缩放，并在退出时逐个还原）、不写任何存储、
 *     不接受模型页里的"指令"，不伪造用户确认；
 *   · 测不到的值一律省略并在 errors 里写原因，绝不编造。
 */
(function () {
  'use strict';

  // 幂等：重复注入（例如宿主多次插入脚本）只保留第一份。
  try {
    if (window.__MODELCHECK_BRIDGE__ === true) return;
    Object.defineProperty(window, '__MODELCHECK_BRIDGE__', {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false
    });
  } catch (error) {
    if (window.__MODELCHECK_BRIDGE__ === true) return;
    window.__MODELCHECK_BRIDGE__ = true;
  }

  var CHANNEL = 'modelcheck';
  // 与 lib 侧 evidence.json 的 adapterVersion 保持同一口径，避免证据键无谓漂移。
  var ADAPTER_VERSION = 'modelcheck-adapter/1';
  var MAX_MESSAGE_CHARS = 1024 * 1024; // 单条消息上限 1 MiB（按 JSON 字符数保守计）
  var MAX_SCREENSHOT_CHARS = 900 * 1024; // 截图预算：留出 JSON 包装与其它字段的余量
  var MAX_COMPONENTS = 500;
  var READY_WAIT_MS = 4000;
  var MAX_STABLE_FRAMES = 120;
  var MAX_PARENT_DEPTH = 64;
  var HIGHLIGHT_STYLE_ID = 'modelcheck-bridge-highlight-style';
  var HIGHLIGHT_CLASS = 'mc-bridge-pick-highlight';
  var INCOMING_TYPES = {
    'mc:hello': true,
    'mc:collect': true,
    'mc:pick-mode': true,
    'mc:screenshot': true,
    'mc:reload': true
  };

  // ── 小工具 ────────────────────────────────────────────────────────────────

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }

  function isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function round(value) {
    if (!isFiniteNumber(value)) return null;
    var scaled = Math.round(value * 1e6) / 1e6;
    return scaled === 0 ? 0 : scaled;
  }

  function safeString(value, maxLength) {
    if (typeof value !== 'string') return null;
    var text = value.trim();
    if (!text) return null;
    var limit = isFiniteNumber(maxLength) ? maxLength : 200;
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function describePick(pick) {
    try {
      var text = typeof pick === 'string' ? pick : JSON.stringify(pick);
      if (typeof text !== 'string') return '（无法描述）';
      return text.length > 120 ? text.slice(0, 120) + '…' : text;
    } catch (error) {
      return '（无法描述）';
    }
  }

  function normalizeVec(vector) {
    if (!vector || !isFiniteNumber(vector.x) || !isFiniteNumber(vector.y) || !isFiniteNumber(vector.z)) return null;
    var length = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
    if (!isFiniteNumber(length) || length < 1e-9) return null;
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function sleep(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function nextFrame() {
    return new Promise(function (resolve) {
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(function () { resolve(); });
      else window.setTimeout(resolve, 16);
    });
  }

  function whenDomReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') return Promise.resolve();
    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        resolve();
      }
      document.addEventListener('DOMContentLoaded', finish, { once: true });
      window.addEventListener('load', finish, { once: true });
      window.setTimeout(finish, 3000);
    });
  }

  // 注入时读取 <script data-mc-build>；此时 document.currentScript 正是本脚本。
  function readBuildHash() {
    try {
      var current = document.currentScript;
      if (current && current.dataset && current.dataset.mcBuild) return String(current.dataset.mcBuild);
      var tagged = document.querySelectorAll('script[data-mc-build]');
      if (tagged.length > 0) {
        var last = tagged[tagged.length - 1];
        var value = last.getAttribute('data-mc-build');
        if (value) return String(value);
      }
    } catch (error) { /* 忽略 */ }
    try {
      if (window.__MC_BUILD__ && typeof window.__MC_BUILD__.buildHash === 'string') return window.__MC_BUILD__.buildHash;
      if (window.__MC_PREVIEW__ && typeof window.__MC_PREVIEW__.buildHash === 'string') return window.__MC_PREVIEW__.buildHash;
    } catch (error2) { /* 忽略 */ }
    return null;
  }

  // ── 桥状态 ───────────────────────────────────────────────────────────────

  var state = {
    routeHint: null, // 面板通过 mc:hello 提供的路线（config.json 的 route）
    route: null, // 实际判定出的路线
    unitToPx: 1, // 世界单位 = 像素 * unitToPx（夹具 35px * 0.001 = 0.035）
    preview: null, // window.__MC_PREVIEW__（three 路线）
    buildHash: readBuildHash(),
    pickMode: false,
    pickTargets: [], // 最近一次收到的组件清单（点选时用来补 label/related）
    highlight: null, // 高亮还原记录
    readyAnnounced: false,
    cleaned: false
  };

  function getThreeNamespace() {
    try {
      if (state.preview && state.preview.THREE && typeof state.preview.THREE.Raycaster === 'function') return state.preview.THREE;
      if (window.THREE && typeof window.THREE.Raycaster === 'function') return window.THREE;
    } catch (error) { /* 忽略 */ }
    return null;
  }

  function detectThree() {
    var preview = null;
    try { preview = window.__MC_PREVIEW__; } catch (error) { preview = null; }
    if (preview && preview.scene && typeof preview.scene === 'object' && typeof preview.scene.traverse === 'function') {
      state.preview = preview;
      return true;
    }
    return false;
  }

  function detectRoute() {
    if (detectThree()) return 'three';
    var element = null;
    try { element = document.querySelector('[data-mc-id]'); } catch (error) { element = null; }
    if (element) {
      var isSvg = false;
      try {
        isSvg = element.namespaceURI === 'http://www.w3.org/2000/svg' || !!element.ownerSVGElement;
      } catch (error2) { isSvg = false; }
      return isSvg ? 'svg' : 'dom';
    }
    return 'image';
  }

  function resolveRoute() {
    if (state.routeHint) return state.routeHint;
    return detectRoute();
  }

  function canNativeScreenshot() {
    try {
      var preview = state.preview;
      return !!(preview && preview.renderer && preview.renderer.domElement &&
        typeof preview.renderer.domElement.toDataURL === 'function');
    } catch (error) {
      return false;
    }
  }

  function capabilities() {
    var route = resolveRoute();
    var list = ['evidence', 'visibility', 'attributes', 'pick'];
    if (route === 'three') {
      list.push('three-world-geometry');
      if (getThreeNamespace()) list.push('three-raycaster');
      else list.push('three-projection-hit-test');
    } else if (route === 'svg') {
      list.push('dom-rect', 'svg-path-endpoint', 'svg-azimuth');
    } else if (route === 'dom') {
      list.push('dom-rect');
    } else {
      list.push('image-regions');
    }
    list.push('screenshot:' + (canNativeScreenshot() ? 'native' : 'unavailable'));
    return list;
  }

  // ── 与父面板通信（唯一出口）──────────────────────────────────────────────

  function postToParent(message, isFallback) {
    if (state.cleaned) return false;
    try {
      if (window.parent === window) return false; // 直接打开预览页时没有面板，不发
      var payload = {};
      var source = message && typeof message === 'object' ? message : {};
      Object.keys(source).forEach(function (key) { payload[key] = source[key]; });
      payload.channel = CHANNEL;
      var json = JSON.stringify(payload);
      if (json.length > MAX_MESSAGE_CHARS) {
        if (isFallback) return false;
        // 超限时只回一条精简错误，避免把超限内容再发一遍。
        return postToParent({
          type: 'mc:error',
          requestId: typeof payload.requestId === 'string' ? payload.requestId : null,
          code: 'message-too-large',
          message: '消息超过 1 MiB 上限，已丢弃（' + json.length + ' 字符）'
        }, true);
      }
      // 预览页是不透明源：目标源只能是 '*'。消息里不含机密，面板侧用
      // event.source === iframe.contentWindow 把关。
      window.parent.postMessage(payload, '*');
      return true;
    } catch (error) {
      try { console.warn('modelcheck-bridge: 向面板发送消息失败', error); } catch (ignored) { /* 忽略 */ }
      return false;
    }
  }

  // ── 稳定性等待 ───────────────────────────────────────────────────────────

  function matrixSignature() {
    var parts = [];
    try {
      if (detectThree()) {
        var scene = state.preview.scene;
        if (typeof scene.updateMatrixWorld === 'function') scene.updateMatrixWorld(true);
        var count = 0;
        scene.traverse(function (object) {
          count += 1;
          if (count > 4000 || !object || !object.matrixWorld || !object.matrixWorld.elements) return;
          var e = object.matrixWorld.elements;
          parts.push(
            (object.type || '?') + ':' +
            round(e[12]) + ',' + round(e[13]) + ',' + round(e[14]) + ':' +
            (object.visible === false ? 0 : 1)
          );
        });
        parts.push('count=' + count);
      } else {
        var nodes = document.querySelectorAll('[data-mc-id]');
        parts.push('nodes=' + nodes.length);
        for (var i = 0; i < nodes.length && i < 400; i += 1) {
          var rect = nodes[i].getBoundingClientRect();
          parts.push(round(rect.left) + ',' + round(rect.top) + ',' + round(rect.width) + ',' + round(rect.height));
        }
      }
    } catch (error) {
      parts.push('err');
    }
    return parts.join('|');
  }

  // 等模型挂载（three 可能需要等 __MC_PREVIEW__），再等连续两帧几何签名不变。
  // 非 three 路线不空等：只在很短窗口内探测 __MC_PREVIEW__ 是否出现（例如预览壳晚挂载），
  // 避免 svg/dom/image 每次取证都白等 READY_WAIT_MS。
  function whenStable() {
    var wantsThree = function () { return resolveRoute() === 'three' || detectThree(); };
    var startedAt = Date.now();
    var poll = function () {
      if (detectThree()) return Promise.resolve(true);
      if (!wantsThree() && Date.now() - startedAt >= 300) return Promise.resolve(false);
      if (Date.now() - startedAt >= READY_WAIT_MS) return Promise.resolve(false);
      return sleep(40).then(poll);
    };
    return poll().then(function () {
      var lastSignature = null;
      var stableFrames = 0;
      var loop = function (frameIndex) {
        if (stableFrames >= 2) return Promise.resolve(true);
        if (!isFiniteNumber(frameIndex) || frameIndex >= MAX_STABLE_FRAMES) return Promise.resolve(stableFrames >= 2);
        return nextFrame().then(function () {
          var signature = matrixSignature();
          if (signature === lastSignature) stableFrames += 1;
          else stableFrames = 0;
          lastSignature = signature;
          return loop(frameIndex + 1);
        });
      };
      return loop(0);
    });
  }

  // ── 工具：轴 / 材质 / 可见性 ─────────────────────────────────────────────

  function parseAxis(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      var text = value.trim().toLowerCase();
      if (!text) return null;
      if (text.charAt(0) === '[') {
        try { return parseAxis(JSON.parse(text)); } catch (error) { return null; }
      }
      var sign = 1;
      if (text.charAt(0) === '-') { sign = -1; text = text.slice(1); }
      else if (text.charAt(0) === '+') { text = text.slice(1); }
      text = text.replace(/^axis[:=]/, '').trim();
      if (text === 'x' || text === 'east') return { x: sign, y: 0, z: 0 };
      if (text === 'y' || text === 'north') return { x: 0, y: sign, z: 0 };
      if (text === 'z' || text === 'up') return { x: 0, y: 0, z: sign };
      return null;
    }
    if (Array.isArray(value) && value.length === 3) {
      return normalizeVec({ x: Number(value[0]), y: Number(value[1]), z: Number(value[2]) });
    }
    if (isPlainObject(value)) {
      if (value.axis !== undefined) return parseAxis(value.axis);
      if (isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)) {
        return normalizeVec({ x: value.x, y: value.y, z: value.z });
      }
    }
    return null;
  }

  function observableList(component) {
    var list = [];
    if (!component || !Array.isArray(component.observables)) return list;
    component.observables.forEach(function (item) {
      if (typeof item === 'string') list.push({ name: item, unit: null });
      else if (isPlainObject(item) && typeof item.name === 'string') list.push({ name: item.name, unit: item.unit || null, raw: item });
    });
    return list;
  }

  function resolveDirectionAxis(component, object) {
    var candidates = [];
    if (component && component.directionAxis !== undefined) candidates.push({ value: component.directionAxis, source: 'component.directionAxis' });
    if (component && component.axis !== undefined) candidates.push({ value: component.axis, source: 'component.axis' });
    if (object && object.userData) {
      if (object.userData.mcAxis !== undefined) candidates.push({ value: object.userData.mcAxis, source: 'userData.mcAxis' });
      if (object.userData.directionAxis !== undefined) candidates.push({ value: object.userData.directionAxis, source: 'userData.directionAxis' });
    }
    observableList(component).forEach(function (item) {
      if (item.raw && item.raw.axis !== undefined) candidates.push({ value: item.raw.axis, source: 'observables.' + item.name + '.axis' });
      if (item.raw && item.raw.directionAxis !== undefined) candidates.push({ value: item.raw.directionAxis, source: 'observables.' + item.name + '.directionAxis' });
    });
    if (candidates.length === 0 && object && object.dir) candidates.push({ value: object.dir, source: 'arrow.dir' });
    for (var i = 0; i < candidates.length; i += 1) {
      var axis = parseAxis(candidates[i].value);
      if (axis) return { axis: axis, source: candidates[i].source };
    }
    // 约定：箭头类对象默认 +X（文档 §3.5 的"约定基准轴"）。
    return { axis: { x: 1, y: 0, z: 0 }, source: 'default:+X' };
  }

  function readWorldPosition(object) {
    var e = object && object.matrixWorld && object.matrixWorld.elements;
    if (!e || e.length < 16) return null;
    var position = { x: round(e[12]), y: round(e[13]), z: round(e[14]) };
    if (position.x === null || position.y === null || position.z === null) return null;
    return position;
  }

  function readWorldDirection(object, axis) {
    var e = object && object.matrixWorld && object.matrixWorld.elements;
    if (!e || e.length < 16) return null;
    var basisX = normalizeVec({ x: e[0], y: e[1], z: e[2] });
    var basisY = normalizeVec({ x: e[4], y: e[5], z: e[6] });
    var basisZ = normalizeVec({ x: e[8], y: e[9], z: e[10] });
    if (!basisX || !basisY || !basisZ) return null;
    var vector = {
      x: axis.x * basisX.x + axis.y * basisY.x + axis.z * basisZ.x,
      y: axis.x * basisX.y + axis.y * basisY.y + axis.z * basisZ.y,
      z: axis.x * basisX.z + axis.y * basisY.z + axis.z * basisZ.z
    };
    var unit = normalizeVec(vector);
    if (!unit) return null;
    return { x: round(unit.x), y: round(unit.y), z: round(unit.z) };
  }

  // 把局部点用对象世界矩阵换到世界坐标（列主序；只做仿射变换）。
  function transformLocalPoint(matrix, point) {
    if (!matrix || matrix.length < 16 || !point) return null;
    var x = matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12];
    var y = matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13];
    var z = matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14];
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) return null;
    return { x: round(x), y: round(y), z: round(z) };
  }

  function readAttributePoint(attribute, index) {
    try {
      if (!attribute || index < 0 || index >= attribute.count) return null;
      var x = attribute.getX(index);
      var y = attribute.getY(index);
      var z = attribute.getZ ? attribute.getZ(index) : 0;
      if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
      return { x: x, y: y, z: isFiniteNumber(z) ? z : 0 };
    } catch (error) {
      return null;
    }
  }

  // three 的端点：优先取线几何的真实首末顶点，其次 ArrowHelper 的 origin→tip，
  // 最后退到对象世界坐标（start=end=worldPosition，并在 source 里如实标注）。
  function readThreeEndpoints(object, worldPosition) {
    var matrix = object && object.matrixWorld && object.matrixWorld.elements;
    var geometry = object && object.geometry;
    var positionAttribute = geometry && geometry.attributes ? geometry.attributes.position : null;
    if (positionAttribute && positionAttribute.count >= 2 && matrix) {
      var startLocal = readAttributePoint(positionAttribute, 0);
      var endLocal = readAttributePoint(positionAttribute, positionAttribute.count - 1);
      if (startLocal && endLocal) {
        var startPoint = transformLocalPoint(matrix, startLocal);
        var endPoint = transformLocalPoint(matrix, endLocal);
        if (startPoint && endPoint) return { start: startPoint, end: endPoint, source: 'geometry-vertices' };
      }
    }
    if (object && object.isArrowHelper === true && object.dir && isFiniteNumber(object.length) && matrix) {
      var basisX = normalizeVec({ x: matrix[0], y: matrix[1], z: matrix[2] });
      var basisY = normalizeVec({ x: matrix[4], y: matrix[5], z: matrix[6] });
      var basisZ = normalizeVec({ x: matrix[8], y: matrix[9], z: matrix[10] });
      var direction = normalizeVec({ x: object.dir.x, y: object.dir.y, z: object.dir.z });
      if (basisX && basisY && basisZ && direction) {
        var tip = {
          x: (worldPosition ? worldPosition.x : 0) +
            object.length * (direction.x * basisX.x + direction.y * basisY.x + direction.z * basisZ.x),
          y: (worldPosition ? worldPosition.y : 0) +
            object.length * (direction.x * basisX.y + direction.y * basisY.y + direction.z * basisZ.y),
          z: (worldPosition ? worldPosition.z : 0) +
            object.length * (direction.x * basisX.z + direction.y * basisY.z + direction.z * basisZ.z)
        };
        var origin = { x: round(worldPosition ? worldPosition.x : 0), y: round(worldPosition ? worldPosition.y : 0), z: round(worldPosition ? worldPosition.z : 0) };
        return { start: origin, end: { x: round(tip.x), y: round(tip.y), z: round(tip.z) }, source: 'arrow' };
      }
    }
    if (worldPosition) {
      return {
        start: { x: worldPosition.x, y: worldPosition.y, z: worldPosition.z },
        end: { x: worldPosition.x, y: worldPosition.y, z: worldPosition.z },
        source: 'object-position'
      };
    }
    return null;
  }

  function isVisibleInScene(object) {
    var node = object;
    var depth = 0;
    while (node && depth < MAX_PARENT_DEPTH) {
      if (node.visible === false) return false;
      node = node.parent;
      depth += 1;
    }
    return true;
  }

  function parentChain(object) {
    var chain = [];
    var node = object && object.parent;
    var depth = 0;
    while (node && depth < 32) {
      chain.push(typeof node.name === 'string' && node.name ? node.name : '(unnamed)');
      node = node.parent;
      depth += 1;
    }
    return chain;
  }

  function collectMaterials(object) {
    var list = [];
    var seen = [];
    var node = object;
    var depth = 0;
    while (node && depth < 8) {
      var material = node.material;
      if (Array.isArray(material)) {
        material.forEach(function (item) {
          if (item && seen.indexOf(item) < 0) { seen.push(item); list.push(item); }
        });
      } else if (material && seen.indexOf(material) < 0) {
        seen.push(material);
        list.push(material);
      }
      node = node.parent;
      depth += 1;
    }
    return list;
  }

  function materialColor(material) {
    var color = material && material.color;
    if (!color) return null;
    try {
      if (typeof color.getHexString === 'function') return '#' + color.getHexString();
      if (typeof color.getHex === 'function') return '#' + ('000000' + color.getHex().toString(16)).slice(-6);
      if (isFiniteNumber(color.r) && isFiniteNumber(color.g) && isFiniteNumber(color.b)) {
        var toByte = function (value) {
          var byte = Math.round(Math.max(0, Math.min(1, value)) * 255);
          var text = byte.toString(16);
          return text.length === 1 ? '0' + text : text;
        };
        return '#' + toByte(color.r) + toByte(color.g) + toByte(color.b);
      }
    } catch (error) { return null; }
    return null;
  }

  // three：只导出白名单属性，取值都来自对象本身。
  var THREE_ATTRIBUTE_NAMES = {
    position: true,
    rotation: true,
    quaternion: true,
    scale: true,
    color: true,
    opacity: true,
    name: true,
    type: true
  };

  function readThreeAttributes(object, component) {
    var values = {};
    var props = [];
    var unknown = [];
    observableList(component).forEach(function (item) {
      var name = item.name;
      if (!THREE_ATTRIBUTE_NAMES[name]) { unknown.push(name); return; }
      if (name === 'position' && object.position) values.position = { x: round(object.position.x), y: round(object.position.y), z: round(object.position.z) };
      else if (name === 'rotation' && object.rotation) values.rotation = { x: round(object.rotation.x), y: round(object.rotation.y), z: round(object.rotation.z) };
      else if (name === 'quaternion' && object.quaternion) values.quaternion = { x: round(object.quaternion.x), y: round(object.quaternion.y), z: round(object.quaternion.z), w: round(object.quaternion.w) };
      else if (name === 'scale' && object.scale) values.scale = { x: round(object.scale.x), y: round(object.scale.y), z: round(object.scale.z) };
      else if (name === 'name') values.name = typeof object.name === 'string' ? object.name : null;
      else if (name === 'type') values.type = typeof object.type === 'string' ? object.type : null;
      else if (name === 'color') {
        var materials = collectMaterials(object);
        var color = null;
        for (var i = 0; i < materials.length && !color; i += 1) color = materialColor(materials[i]);
        if (color) values.color = color;
      } else if (name === 'opacity') {
        var firstMaterial = collectMaterials(object)[0];
        if (firstMaterial && isFiniteNumber(firstMaterial.opacity)) values.opacity = round(firstMaterial.opacity);
      }
      if (values[name] !== undefined && values[name] !== null) props.push('attributes.' + name);
    });
    return { values: values, props: props, unknown: unknown };
  }

  // ── three 采集 ───────────────────────────────────────────────────────────

  function resolveThreeObject(scene, pick, id) {
    if (!scene || typeof scene.traverse !== 'function') return null;
    var keys = [];
    if (pick !== null && pick !== undefined) {
      if (typeof pick === 'string') keys.push(pick.trim());
      else if (isPlainObject(pick)) {
        if (typeof pick.name === 'string') keys.push(pick.name.trim());
        if (typeof pick.mcId === 'string') keys.push(pick.mcId.trim());
        if (typeof pick.selector === 'string') keys.push(pick.selector.trim());
      }
    }
    if (id) keys.push(id);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (!key) continue;
      key = key.replace(/^name=/, '');
      var found = null;
      try { found = typeof scene.getObjectByName === 'function' ? scene.getObjectByName(key) : null; } catch (error) { found = null; }
      if (found) return found;
    }
    var hit = null;
    var wanted = [];
    keys.forEach(function (key) { if (key) wanted.push(key); });
    try {
      scene.traverse(function (object) {
        if (hit || !object || !object.userData) return;
        for (var k = 0; k < wanted.length; k += 1) {
          if (object.userData.mcId === wanted[k] || object.userData.mc === wanted[k]) { hit = object; return; }
        }
      });
    } catch (error2) { /* 忽略 */ }
    return hit;
  }

  function collectThree(components, options) {
    var result = { components: {}, coverage: [], errors: [] };
    var collectOptions = options || {};
    var wantInstances = collectOptions.includeInstances !== false;
    var wantParts = collectOptions.includeParts !== false;
    var scene = state.preview && state.preview.scene;
    if (!scene) {
      result.errors.push({ id: null, reason: '未找到 __MC_PREVIEW__.scene，无法采集 three 运行时几何' });
      return result;
    }
    try {
      if (typeof scene.updateMatrixWorld === 'function') scene.updateMatrixWorld(true);
    } catch (error) { /* 继续，matrixWorld 可能仍是旧的 */ }
    components.forEach(function (component) {
      var id = safeString(component && component.id, 120);
      if (!id) {
        result.errors.push({ id: null, reason: '组件缺少 id，已跳过' });
        return;
      }
      var object = resolveThreeObject(scene, component.pick, id);
      if (!object) {
        result.errors.push({ id: id, reason: '按 pick 未在 __MC_PREVIEW__.scene 中找到对象：' + describePick(component.pick) });
        return;
      }
      var record = {};
      var props = [];
      var axisInfo = resolveDirectionAxis(component, object);
      var worldPosition = readWorldPosition(object);
      if (worldPosition) { record.worldPosition = worldPosition; props.push('worldPosition'); }
      else result.errors.push({ id: id, reason: '对象没有可用的 matrixWorld，无法导出世界坐标' });
      var worldDirection = readWorldDirection(object, axisInfo.axis);
      if (worldDirection) {
        record.worldDirection = worldDirection;
        record.directionAxis = axisInfo.source;
        props.push('worldDirection', 'directionAxis');
      } else {
        result.errors.push({ id: id, reason: '对象 world matrix 基向量退化，无法导出世界方向' });
      }
      record.visible = isVisibleInScene(object);
      props.push('visible');
      var endpoints = readThreeEndpoints(object, worldPosition);
      if (endpoints) {
        // source 如实标注端点来源：geometry-vertices / arrow / object-position（兜底）。
        record.endpoints = endpoints;
        props.push('endpoints');
      }
      var attributes = readThreeAttributes(object, component);
      if (attributes.unknown.length > 0) {
        result.errors.push({ id: id, reason: 'three 路线不支持的可观测属性（已省略）：' + attributes.unknown.join(', ') });
      }
      if (Object.keys(attributes.values).length > 0) {
        record.attributes = attributes.values;
        props = props.concat(attributes.props);
      }
      record.parentChain = parentChain(object);
      props.push('parentChain');
      // P1：按请求（默认按组件声明）导出实例与部件的实测几何。
      if (wantInstances && Array.isArray(component.instances) && component.instances.length > 0) {
        var instanceRecords = collectThreeInstances(object, component, result, id);
        if (instanceRecords) {
          record.instances = instanceRecords;
          props.push('instances');
        }
      }
      if (wantParts && Array.isArray(component.parts) && component.parts.length > 0) {
        var partRecords = collectThreeParts(object, component, result, id);
        if (partRecords) {
          record.parts = partRecords;
          props.push('parts');
        }
      }
      result.components[id] = record;
      result.coverage.push({ id: id, props: props });
    });
    return result;
  }

  // ── DOM / SVG 采集 ───────────────────────────────────────────────────────

  function findElement(pick, id) {
    var candidates = [];
    if (typeof pick === 'string') candidates.push(pick.trim());
    else if (isPlainObject(pick)) {
      if (typeof pick.selector === 'string') candidates.push(pick.selector.trim());
      if (typeof pick.mcId === 'string') candidates.push('[data-mc-id="' + escapeAttribute(pick.mcId) + '"]');
    }
    if (id) candidates.push('[data-mc-id="' + escapeAttribute(id) + '"]');
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (!candidate) continue;
      var direct = null;
      try { direct = document.querySelector('[data-mc-id="' + escapeAttribute(candidate) + '"]'); } catch (error) { direct = null; }
      if (direct) return direct;
      if (candidate.length <= 300) {
        var selected = null;
        try { selected = document.querySelector(candidate); } catch (error2) { selected = null; }
        if (selected) return selected;
      }
      var byId = null;
      try { byId = document.getElementById(candidate); } catch (error3) { byId = null; }
      if (byId) return byId;
    }
    return null;
  }

  function escapeAttribute(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function transformScreenPoint(matrix, point) {
    if (!matrix || !isFiniteNumber(matrix.a)) return { x: point.x, y: point.y };
    return {
      x: matrix.a * point.x + matrix.c * point.y + matrix.e,
      y: matrix.b * point.x + matrix.d * point.y + matrix.f
    };
  }

  function readPathEndpoints(element, viewportHeight, unitToPx) {
    if (!element || typeof element.getTotalLength !== 'function' || typeof element.getPointAtLength !== 'function') return null;
    var total = null;
    try { total = element.getTotalLength(); } catch (error) { return null; }
    if (!isFiniteNumber(total) || total <= 0) return null;
    var startPoint = null;
    var endPoint = null;
    try {
      startPoint = element.getPointAtLength(0);
      endPoint = element.getPointAtLength(total);
    } catch (error2) { return null; }
    if (!startPoint || !endPoint) return null;
    var matrix = null;
    try { matrix = element.getScreenCTM(); } catch (error3) { matrix = null; }
    function toWorld(point) {
      var screen = transformScreenPoint(matrix, point);
      return {
        x: round(screen.x * unitToPx),
        y: round((viewportHeight - screen.y) * unitToPx),
        z: 0
      };
    }
    return { start: toWorld(startPoint), end: toWorld(endPoint) };
  }

  // 罗盘帧：x=东、y=北、z=上（屏幕 y 向下，换算世界单位时已取反，所以世界 +y 就是北）。
  // 方位角定义：北 = 0°，顺时针为正 → azimuth = atan2(东分量, 北分量)。
  function azimuthOfVector(vector) {
    var degrees = Math.atan2(vector.x, vector.y) * 180 / Math.PI;
    return (degrees + 360) % 360;
  }

  function directionFromEndpoints(start, end) {
    if (!start || !end) return null;
    var dx = end.x - start.x;
    var dy = end.y - start.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
    var unit = normalizeVec({ x: dx, y: dy, z: 0 });
    if (!unit) return null;
    return {
      vector: { x: round(unit.x), y: round(unit.y), z: 0 },
      azimuthDeg: round(azimuthOfVector(unit))
    };
  }

  function computedStyleOf(element) {
    try { return window.getComputedStyle(element); } catch (error) { return null; }
  }

  function computedOpacity(element) {
    var node = element;
    var depth = 0;
    var opacity = 1;
    while (node && node.nodeType === 1 && depth < MAX_PARENT_DEPTH) {
      var style = computedStyleOf(node);
      if (style && style.opacity !== '') {
        var value = parseFloat(style.opacity);
        if (isFiniteNumber(value)) opacity *= value;
      }
      node = node.parentNode;
      depth += 1;
    }
    return round(opacity);
  }

  function isElementVisible(element) {
    var node = element;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < MAX_PARENT_DEPTH) {
      if (node.hidden === true) return false;
      var style = computedStyleOf(node);
      if (style) {
        if (style.display === 'none') return false;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      node = node.parentNode;
      depth += 1;
    }
    var opacity = computedOpacity(element);
    if (opacity !== null && opacity <= 0) return false;
    return true;
  }

  var DOM_ATTRIBUTE_NAMES = {
    position: true,
    bbox: true,
    color: true,
    opacity: true,
    text: true,
    endpoint: true,
    direction: true,
    visible: true
  };

  function readDomAttributes(element, component, geometry) {
    var values = {};
    var props = [];
    var unknown = [];
    observableList(component).forEach(function (item) {
      var name = item.name;
      if (name.indexOf('attr:') === 0) {
        var attributeName = name.slice(5);
        if (attributeName) {
          var raw = null;
          try { raw = element.getAttribute(attributeName); } catch (error) { raw = null; }
          if (raw !== null && raw !== undefined) {
            values[attributeName] = String(raw).slice(0, 400);
            props.push('attributes.' + attributeName);
          }
        }
        return;
      }
      if (!DOM_ATTRIBUTE_NAMES[name]) { unknown.push(name); return; }
      if (name === 'position' && geometry && geometry.center) values.position = geometry.center;
      else if (name === 'bbox' && geometry && geometry.bbox) values.bbox = geometry.bbox;
      else if (name === 'text') values.text = (element.textContent || '').trim().slice(0, 200);
      else if (name === 'visible') values.visible = isElementVisible(element);
      else if (name === 'opacity') values.opacity = computedOpacity(element);
      else if (name === 'endpoint' && geometry && geometry.endpoints) values.endpoint = geometry.endpoints;
      else if (name === 'direction' && geometry && geometry.direction) values.direction = geometry.direction;
      else if (name === 'color') {
        var style = computedStyleOf(element);
        if (style) {
          var color = style.stroke && style.stroke !== 'none' ? style.stroke : style.color;
          if (color) values.color = String(color);
        }
      }
      if (values[name] !== undefined) props.push('attributes.' + name);
    });
    return { values: values, props: props, unknown: unknown };
  }

  function readDomGeometry(element, viewportHeight) {
    var unitToPx = state.unitToPx;
    var rect = null;
    try { rect = element.getBoundingClientRect(); } catch (error) { return null; }
    if (!rect || !isFiniteNumber(rect.width) || !isFiniteNumber(rect.height)) return null;
    var centerX = rect.left + rect.width / 2;
    var centerY = rect.top + rect.height / 2;
    var geometry = {
      center: {
        x: round(centerX * unitToPx),
        y: round((viewportHeight - centerY) * unitToPx),
        z: 0
      },
      bbox: {
        x: round(rect.left * unitToPx),
        y: round((viewportHeight - rect.top - rect.height) * unitToPx),
        width: round(rect.width * unitToPx),
        height: round(rect.height * unitToPx)
      },
      pixel: {
        left: round(rect.left),
        top: round(rect.top),
        width: round(rect.width),
        height: round(rect.height)
      }
    };
    var endpoints = readPathEndpoints(element, viewportHeight, unitToPx);
    if (endpoints) {
      geometry.endpoints = endpoints;
      var direction = directionFromEndpoints(endpoints.start, endpoints.end);
      if (direction) geometry.direction = direction;
    } else if (typeof element.getAttribute === 'function') {
      // 非 path 元素：只有在页面显式声明时才认方向，绝不按 bbox 猜。
      var declared = element.getAttribute('data-mc-direction') || element.getAttribute('data-mc-axis');
      if (declared) {
        var text = String(declared).trim();
        var degrees = parseFloat(text);
        var vector = null;
        if (isFiniteNumber(degrees)) {
          var radians = degrees * Math.PI / 180;
          vector = { x: Math.sin(radians), y: Math.cos(radians), z: 0 };
        } else {
          vector = parseAxis(text);
        }
        if (vector) {
          var unit = normalizeVec(vector);
          if (unit) geometry.direction = { vector: { x: round(unit.x), y: round(unit.y), z: round(unit.z) }, azimuthDeg: round(azimuthOfVector(unit)) };
        }
      }
    }
    return geometry;
  }

  function collectDom(components) {
    var result = { components: {}, coverage: [], errors: [] };
    var viewportHeight = window.innerHeight;
    components.forEach(function (component) {
      var id = safeString(component && component.id, 120);
      if (!id) {
        result.errors.push({ id: null, reason: '组件缺少 id，已跳过' });
        return;
      }
      var element = findElement(component.pick, id);
      if (!element) {
        result.errors.push({ id: id, reason: '未找到匹配元素：' + describePick(component.pick) });
        return;
      }
      var geometry = readDomGeometry(element, viewportHeight);
      if (!geometry) {
        result.errors.push({ id: id, reason: '元素没有可用的 getBoundingClientRect 几何' });
        return;
      }
      var record = {
        worldPosition: geometry.center,
        bbox: geometry.bbox,
        visible: isElementVisible(element)
      };
      var props = ['worldPosition', 'bbox', 'visible'];
      if (geometry.direction) {
        record.worldDirection = geometry.direction.vector;
        record.directionDeg = geometry.direction.azimuthDeg;
        props.push('worldDirection', 'directionDeg');
      }
      if (geometry.endpoints) {
        record.endpoints = geometry.endpoints;
        props.push('endpoints');
      } else {
        // 非 path 元素没有真实端点：退化为 bbox 中心，并如实标注来源。
        var center = geometry.center;
        record.endpoints = {
          start: { x: center.x, y: center.y, z: center.z || 0 },
          end: { x: center.x, y: center.y, z: center.z || 0 },
          source: 'bbox-center'
        };
        props.push('endpoints');
      }
      var attributes = readDomAttributes(element, component, geometry);
      if (attributes.unknown.length > 0) {
        result.errors.push({ id: id, reason: 'DOM/SVG 路线不支持的可观测属性（已省略）：' + attributes.unknown.join(', ') });
      }
      if (Object.keys(attributes.values).length > 0) {
        record.attributes = attributes.values;
        props = props.concat(attributes.props);
      }
      result.components[id] = record;
      result.coverage.push({ id: id, props: props });
    });
    return result;
  }

  // image 路线：只报告登记区域的像素矩形，不声称任何几何或方向。
  function normalizeRegion(value) {
    if (!isPlainObject(value)) return null;
    var width = Number(value.width !== undefined ? value.width : value.w);
    var height = Number(value.height !== undefined ? value.height : value.h);
    var x = Number(value.x !== undefined ? value.x : value.left);
    var y = Number(value.y !== undefined ? value.y : value.top);
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    if (width <= 0 || height <= 0) return null;
    return { x: round(x), y: round(y), width: round(width), height: round(height) };
  }

  function collectImage(components) {
    var result = { components: {}, coverage: [], errors: [] };
    components.forEach(function (component) {
      var id = safeString(component && component.id, 120);
      if (!id) {
        result.errors.push({ id: null, reason: '组件缺少 id，已跳过' });
        return;
      }
      var region = normalizeRegion(component.pick) || normalizeRegion(component.region) || normalizeRegion(component.area);
      if (!region) {
        result.errors.push({ id: id, reason: 'image 路线只支持登记区域：pick 需为 {x,y,width,height} 像素矩形' });
        return;
      }
      var record = { attributes: { region: region } };
      result.components[id] = record;
      result.coverage.push({ id: id, props: ['attributes.region'] });
    });
    return result;
  }

  // ── 上下文（只写实际观测到的，不照抄请求）────────────────────────────────

  function observeContext(requested) {
    var route = resolveRoute();
    var context = {
      route: route,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      requested: isPlainObject(requested) ? requested : {}
    };
    var unobservable = [];
    // 请求里要求、但本适配器实际观测不到的上下文键：如实列出，绝不照抄请求值。
    Object.keys(context.requested).forEach(function (key) {
      if (key === 'requested') return;
      if (context[key] === undefined) unobservable.push(key);
    });
    if (route === 'three' && state.preview) {
      var camera = state.preview.camera;
      if (camera) {
        if (typeof camera.updateMatrixWorld === 'function') {
          try { camera.updateMatrixWorld(); } catch (error) { /* 忽略 */ }
        }
        var e = camera.matrixWorld && camera.matrixWorld.elements;
        if (e) {
          context.camera = {
            position: { x: round(e[12]), y: round(e[13]), z: round(e[14]) },
            fov: isFiniteNumber(camera.fov) ? round(camera.fov) : null,
            up: camera.up ? { x: round(camera.up.x), y: round(camera.up.y), z: round(camera.up.z) } : null
          };
        }
      }
      var renderer = state.preview.renderer;
      if (renderer && renderer.domElement) {
        context.viewport = { width: renderer.domElement.width, height: renderer.domElement.height };
      }
      if (isFiniteNumber(state.preview.time)) context.animationTime = round(state.preview.time);
    }
    var pageState = null;
    try { pageState = window.__MC_STATE__ || (state.preview && state.preview.state) || null; } catch (error2) { pageState = null; }
    if (isPlainObject(pageState)) {
      ['step', 'mode', 'view'].forEach(function (key) {
        if (pageState[key] !== undefined) {
          context[key] = pageState[key];
          var index = unobservable.indexOf(key);
          if (index >= 0) unobservable.splice(index, 1);
        }
      });
      if (isFiniteNumber(pageState.time) && context.animationTime === undefined) {
        context.animationTime = round(pageState.time);
        var timeIndex = unobservable.indexOf('time');
        if (timeIndex >= 0) unobservable.splice(timeIndex, 1);
      }
    }
    context.static = unobservable.length > 0 && route !== 'three';
    if (unobservable.length > 0) context.unobservable = unobservable;
    return context;
  }

  // ── 高亮（非破坏性 + 退出还原）──────────────────────────────────────────

  function ensureHighlightStyle() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
    try {
      var style = document.createElement('style');
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent = '.' + HIGHLIGHT_CLASS + '{outline:2px dashed #f0b429 !important;outline-offset:2px !important}';
      (document.head || document.documentElement).appendChild(style);
    } catch (error) { /* 忽略 */ }
  }

  function restoreHighlight() {
    var highlight = state.highlight;
    state.highlight = null;
    if (!highlight) return;
    try {
      if (highlight.kind === 'dom' && highlight.element) highlight.element.classList.remove(HIGHLIGHT_CLASS);
      if (highlight.kind === 'three' && Array.isArray(highlight.restores)) {
        highlight.restores.forEach(function (restore) {
          try {
            if (restore.type === 'emissive' && restore.material && restore.material.emissive) {
              if (typeof restore.material.emissive.setHex === 'function') restore.material.emissive.setHex(restore.previousEmissive);
              if (restore.material.emissiveIntensity !== undefined) restore.material.emissiveIntensity = restore.previousIntensity;
            } else if (restore.type === 'opacity' && restore.material) {
              restore.material.opacity = restore.previousOpacity;
              restore.material.transparent = restore.previousTransparent;
            } else if (restore.type === 'scale' && restore.object && restore.object.scale) {
              restore.object.scale.set(restore.previousScale.x, restore.previousScale.y, restore.previousScale.z);
            }
          } catch (error) { /* 单个材质还原失败不影响其它 */ }
        });
      }
    } catch (error2) { /* 忽略 */ }
  }

  function highlightThree(object) {
    var restores = [];
    collectMaterials(object).forEach(function (material) {
      if (!material) return;
      try {
        if (material.emissive && typeof material.emissive.getHex === 'function') {
          restores.push({
            type: 'emissive',
            material: material,
            previousEmissive: material.emissive.getHex(),
            previousIntensity: material.emissiveIntensity
          });
          material.emissive.setHex(0xf0b429);
          material.emissiveIntensity = 1;
        } else if (isFiniteNumber(material.opacity)) {
          restores.push({
            type: 'opacity',
            material: material,
            previousOpacity: material.opacity,
            previousTransparent: material.transparent
          });
          material.transparent = true;
          material.opacity = Math.max(0.35, Math.min(1, material.opacity * 0.55));
        }
      } catch (error) { /* 该材质不支持高亮，跳过 */ }
    });
    if (restores.length === 0 && object && object.scale && isFiniteNumber(object.scale.x)) {
      restores.push({
        type: 'scale',
        object: object,
        previousScale: { x: object.scale.x, y: object.scale.y, z: object.scale.z }
      });
      object.scale.set(object.scale.x * 1.06, object.scale.y * 1.06, object.scale.z * 1.06);
    }
    state.highlight = { kind: 'three', object: object, restores: restores };
  }

  function highlightDom(element) {
    ensureHighlightStyle();
    try {
      element.classList.add(HIGHLIGHT_CLASS);
      state.highlight = { kind: 'dom', element: element };
    } catch (error) { /* 忽略 */ }
  }

  // ── 点选 ─────────────────────────────────────────────────────────────────

  function targetLabel(target) {
    return target && typeof target.label === 'string' ? target.label : undefined;
  }

  function matchComponentForObject(object, targets) {
    var node = object;
    var depth = 0;
    while (node && depth < 32) {
      for (var i = 0; i < targets.length; i += 1) {
        var target = targets[i];
        var pickName = null;
        if (typeof target.pick === 'string') pickName = target.pick;
        else if (isPlainObject(target.pick)) pickName = target.pick.name || target.pick.mcId || target.pick.selector || null;
        if (pickName && typeof node.name === 'string' && node.name === pickName) return { component: target, object: node };
        if (target.id && node.name === target.id) return { component: target, object: node };
        if (target.id && node.userData && (node.userData.mcId === target.id || node.userData.mc === target.id)) {
          return { component: target, object: node };
        }
      }
      node = node.parent;
      depth += 1;
    }
    return null;
  }

  function cameraMatrices(camera) {
    try {
      if (typeof camera.updateMatrixWorld === 'function') camera.updateMatrixWorld();
      if (!camera.projectionMatrix || !camera.matrixWorldInverse) return null;
      var projection = camera.projectionMatrix.elements;
      var view = camera.matrixWorldInverse.elements;
      if (!projection || !view) return null;
      var combined = new Array(16);
      for (var column = 0; column < 4; column += 1) {
        for (var row = 0; row < 4; row += 1) {
          combined[column * 4 + row] =
            projection[row] * view[column * 4] +
            projection[4 + row] * view[column * 4 + 1] +
            projection[8 + row] * view[column * 4 + 2] +
            projection[12 + row] * view[column * 4 + 3];
        }
      }
      return combined;
    } catch (error) {
      return null;
    }
  }

  function projectPoint(matrix, point) {
    if (!matrix || !point) return null;
    var x = matrix[0] * point.x + matrix[4] * point.y + matrix[8] * point.z + matrix[12];
    var y = matrix[1] * point.x + matrix[5] * point.y + matrix[9] * point.z + matrix[13];
    var z = matrix[2] * point.x + matrix[6] * point.y + matrix[10] * point.z + matrix[14];
    var w = matrix[3] * point.x + matrix[7] * point.y + matrix[11] * point.z + matrix[15];
    if (!isFiniteNumber(w) || Math.abs(w) < 1e-9) return null;
    return { x: x / w, y: y / w, z: z / w };
  }

  function objectWorldCorners(object) {
    var geometry = object && object.geometry;
    if (!geometry) return null;
    try {
      if (!geometry.boundingBox && typeof geometry.computeBoundingBox === 'function') geometry.computeBoundingBox();
    } catch (error) { /* 可能无 position 属性 */ }
    var box = geometry.boundingBox;
    if (!box || !box.min || !box.max) return null;
    var e = object.matrixWorld && object.matrixWorld.elements;
    if (!e) return null;
    var xs = [box.min.x, box.max.x];
    var ys = [box.min.y, box.max.y];
    var zs = [box.min.z, box.max.z];
    var corners = [];
    for (var i = 0; i < 2; i += 1) {
      for (var j = 0; j < 2; j += 1) {
        for (var k = 0; k < 2; k += 1) {
          var localX = xs[i];
          var localY = ys[j];
          var localZ = zs[k];
          corners.push({
            x: e[0] * localX + e[4] * localY + e[8] * localZ + e[12],
            y: e[1] * localX + e[5] * localY + e[9] * localZ + e[13],
            z: e[2] * localX + e[6] * localY + e[10] * localZ + e[14]
          });
        }
      }
    }
    return corners;
  }

  function canvasRect() {
    var canvas = state.preview && state.preview.renderer && state.preview.renderer.domElement;
    if (canvas && typeof canvas.getBoundingClientRect === 'function') return canvas.getBoundingClientRect();
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function clickToNdc(event) {
    var rect = canvasRect();
    if (!rect || !isFiniteNumber(rect.width) || rect.width <= 0 || !isFiniteNumber(rect.height) || rect.height <= 0) return null;
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1
    };
  }

  function isClickInsideCanvas(event) {
    var canvas = state.preview && state.preview.renderer && state.preview.renderer.domElement;
    if (!canvas) return true;
    if (event.target === canvas) return true;
    try { return typeof canvas.contains === 'function' && canvas.contains(event.target); } catch (error) { return false; }
  }

  // ── P1：几何单元识别（组件 › 部件 / 实例）────────────────────────────────

  // 命中对象的祖先链：[{name, mcId?, kind?}]；只描述模型几何，不涉及页面控件。
  function describeChain(object) {
    var chain = [];
    var node = object;
    var depth = 0;
    while (node && depth < 32) {
      var item = { name: typeof node.name === 'string' && node.name ? node.name : '(unnamed)' };
      if (node.userData) {
        var mcId = node.userData.mcId !== undefined ? node.userData.mcId : node.userData.mc;
        if (typeof mcId === 'string' && mcId) item.mcId = mcId;
        var kind = node.userData.mcKind !== undefined ? node.userData.mcKind : node.userData.mcType;
        if (typeof kind === 'string' && kind) item.kind = kind;
      }
      chain.push(item);
      node = node.parent;
      depth += 1;
    }
    return chain;
  }

  function columnMultiply4(a, b) {
    var out = new Array(16);
    for (var column = 0; column < 4; column += 1) {
      for (var row = 0; row < 4; row += 1) {
        out[column * 4 + row] =
          a[row] * b[column * 4] +
          a[4 + row] * b[column * 4 + 1] +
          a[8 + row] * b[column * 4 + 2] +
          a[12 + row] * b[column * 4 + 3];
      }
    }
    return out;
  }

  function readInstanceMatrixElements(mesh, index) {
    if (!mesh || !mesh.instanceMatrix || !mesh.instanceMatrix.array) return null;
    var count = isFiniteNumber(mesh.count) ? mesh.count : (isFiniteNumber(mesh.instanceMatrix.count) ? mesh.instanceMatrix.count : 0);
    if (!isFiniteNumber(index) || index < 0 || index >= count) return null;
    var array = mesh.instanceMatrix.array;
    var offset = index * 16;
    if (!array || offset + 16 > array.length) return null;
    var out = new Array(16);
    for (var i = 0; i < 16; i += 1) out[i] = array[offset + i];
    return out;
  }

  function positionFromMatrix(matrix) {
    if (!matrix || matrix.length < 16) return null;
    return { x: round(matrix[12]), y: round(matrix[13]), z: round(matrix[14]) };
  }

  function directionFromMatrix(matrix, axis) {
    if (!matrix || matrix.length < 16) return null;
    var basisX = normalizeVec({ x: matrix[0], y: matrix[1], z: matrix[2] });
    var basisY = normalizeVec({ x: matrix[4], y: matrix[5], z: matrix[6] });
    var basisZ = normalizeVec({ x: matrix[8], y: matrix[9], z: matrix[10] });
    if (!basisX || !basisY || !basisZ) return null;
    var vector = {
      x: axis.x * basisX.x + axis.y * basisY.x + axis.z * basisZ.x,
      y: axis.x * basisX.y + axis.y * basisY.y + axis.z * basisZ.y,
      z: axis.x * basisX.z + axis.y * basisY.z + axis.z * basisZ.z
    };
    var unit = normalizeVec(vector);
    if (!unit) return null;
    return { x: round(unit.x), y: round(unit.y), z: round(unit.z) };
  }

  // 在组件对象子树/祖先 userData.mcParts/场景里解析部件对象。
  function resolvePartObject(rootObject, scene, key) {
    if (!key) return null;
    var node = rootObject;
    var depth = 0;
    while (node && depth < 32) {
      var parts = node.userData && node.userData.mcParts;
      if (parts && typeof parts === 'object' && Object.prototype.hasOwnProperty.call(parts, key)) {
        var def = parts[key];
        if (def && def.isObject3D) return def;
        if (def && def.object && def.object.isObject3D) return def.object;
        if (def && typeof def.name === 'string' && typeof node.getObjectByName === 'function') {
          var byName = node.getObjectByName(def.name);
          if (byName) return byName;
        }
        if (typeof def === 'string' && typeof node.getObjectByName === 'function') {
          var named = node.getObjectByName(def);
          if (named) return named;
        }
      }
      node = node.parent;
      depth += 1;
    }
    if (rootObject && typeof rootObject.getObjectByName === 'function') {
      var child = rootObject.getObjectByName(key);
      if (child) return child;
    }
    if (scene && typeof scene.getObjectByName === 'function') return scene.getObjectByName(key);
    return null;
  }

  function resolveSelectorObject(rootObject, scene, selector) {
    if (!selector) return null;
    if (typeof selector === 'string') {
      var byName = rootObject && typeof rootObject.getObjectByName === 'function' ? rootObject.getObjectByName(selector) : null;
      if (byName) return byName;
      return scene && typeof scene.getObjectByName === 'function' ? scene.getObjectByName(selector) : null;
    }
    if (isPlainObject(selector)) {
      var type = selector.type;
      var value = selector.value !== undefined ? selector.value : selector.name;
      if (type === 'part') return resolvePartObject(rootObject, scene, String(value));
      if (type === 'name') {
        var named = rootObject && typeof rootObject.getObjectByName === 'function' ? rootObject.getObjectByName(String(value)) : null;
        if (named) return named;
        return scene && typeof scene.getObjectByName === 'function' ? scene.getObjectByName(String(value)) : null;
      }
      if (type === 'index' && rootObject && Array.isArray(rootObject.children)) {
        return rootObject.children[Number(value)] || null;
      }
      if (typeof selector.name === 'string') return resolveSelectorObject(rootObject, scene, selector.name);
    }
    return null;
  }

  // 命中 → 组件/部件/实例的完整归属判定（不改模型，只读 userData）。
  function matchPickTarget(object, targets, instanceId) {
    var chainNodes = [];
    var node = object;
    var depth = 0;
    while (node && depth < 32) { chainNodes.push(node); node = node.parent; depth += 1; }

    var matched = { component: null, node: null, partKey: null, instanceKey: null, instanceId: isFiniteNumber(instanceId) ? instanceId : null };

    for (var i = 0; i < chainNodes.length && !matched.component; i += 1) {
      var candidateNode = chainNodes[i];
      for (var t = 0; t < targets.length; t += 1) {
        var target = targets[t];
        if (!target) continue;
        var pickName = null;
        if (typeof target.pick === 'string') pickName = target.pick.replace(/^name=/, '');
        else if (isPlainObject(target.pick)) pickName = target.pick.name || target.pick.mcId || null;
        var id = typeof target.id === 'string' ? target.id : null;
        var nodeName = typeof candidateNode.name === 'string' ? candidateNode.name : '';
        var ud = candidateNode.userData || null;
        var nameHit = (!!pickName && nodeName === pickName) || (!!id && nodeName === id);
        var idHit = !!(ud && id && (ud.mcId === id || ud.mc === id));
        var pickHit = !!(ud && pickName && (ud.mcId === pickName || ud.mc === pickName));
        if (nameHit || idHit || pickHit) {
          matched.component = target;
          matched.node = candidateNode;
          break;
        }
      }
    }

    // 实例：命中对象或祖先上的 userData.mcInstances 目录
    for (var j = 0; j < chainNodes.length && !matched.instanceKey; j += 1) {
      var instanceData = chainNodes[j].userData && chainNodes[j].userData.mcInstances;
      if (!Array.isArray(instanceData)) continue;
      for (var k = 0; k < instanceData.length; k += 1) {
        var entry = instanceData[k];
        if (!entry || typeof entry !== 'object') continue;
        var key = entry.k !== undefined ? entry.k : entry.key;
        var entryIndex = isFiniteNumber(entry.index) ? entry.index
          : (isFiniteNumber(entry.instanceId) ? entry.instanceId : null);
        if (matched.instanceId === null) continue;
        if (entryIndex === matched.instanceId || entry.instanceId === matched.instanceId || key === matched.instanceId) {
          matched.instanceKey = key !== undefined && key !== null ? String(key).slice(0, 120) : String(matched.instanceId);
          break;
        }
      }
    }

    // 部件：祖先 userData.mcParts 映射，或命中对象名等于注册 partKey
    for (var m = 0; m < chainNodes.length && !matched.partKey; m += 1) {
      var partNode = chainNodes[m];
      var parts = partNode.userData && partNode.userData.mcParts;
      if (parts && typeof parts === 'object' && !Array.isArray(parts)) {
        for (var partKey in parts) {
          if (!Object.prototype.hasOwnProperty.call(parts, partKey)) continue;
          var def = parts[partKey];
          var partObject = null;
          if (def && typeof def === 'object') {
            if (def.isObject3D) partObject = def;
            else if (def.object && def.object.isObject3D) partObject = def.object;
          }
          if (partObject) {
            var probe = object;
            while (probe) {
              if (probe === partObject) { matched.partKey = partKey; break; }
              probe = probe.parent;
            }
          } else if (typeof def === 'string' && object && object.name === def) {
            matched.partKey = partKey;
          } else if (def && typeof def === 'object' && typeof def.name === 'string' && object && object.name === def.name) {
            matched.partKey = partKey;
          }
          if (matched.partKey) break;
        }
      }
    }
    if (!matched.partKey && matched.component && Array.isArray(matched.component.parts)) {
      for (var p = 0; p < matched.component.parts.length; p += 1) {
        var partDef = matched.component.parts[p];
        var partKeyValue = partDef && typeof partDef.key === 'string' ? partDef.key : null;
        if (partKeyValue && object && object.name === partKeyValue) { matched.partKey = partKeyValue; break; }
      }
    }

    matched.chain = describeChain(object);
    return matched;
  }

  // 实例取证：InstancedMesh 用 instanceMatrix 组合世界矩阵；也接受 catalog 里的静态位置。
  function collectThreeInstances(object, component, result, id) {
    var catalog = Array.isArray(component.instances) ? component.instances : [];
    if (catalog.length === 0) return null;
    var isInstanced = !!(object && object.isInstancedMesh === true);
    var meshWorld = object && object.matrixWorld && object.matrixWorld.elements;
    var defaultAxisValue;
    var defaultAxisSource;
    if (object && object.userData && object.userData.mcAxis !== undefined) {
      defaultAxisValue = object.userData.mcAxis;
      defaultAxisSource = 'userData.mcAxis';
    } else if (component.directionAxis !== undefined) {
      defaultAxisValue = component.directionAxis;
      defaultAxisSource = 'component.directionAxis';
    } else if (component.axis !== undefined) {
      defaultAxisValue = component.axis;
      defaultAxisSource = 'component.axis';
    } else {
      defaultAxisValue = { x: 0, y: 0, z: 1 };
      defaultAxisSource = 'default:+Z';
    }
    var list = [];
    catalog.slice(0, 2000).forEach(function (entry, index) {
      var key = safeString(entry && (entry.key !== undefined ? entry.key : entry.k), 120) || ('i' + index);
      var instanceId = entry && isFiniteNumber(entry.instanceId) ? entry.instanceId : index;
      var axisValue = entry && entry.axis !== undefined ? entry.axis : defaultAxisValue;
      var axisSource = entry && entry.axis !== undefined ? 'instances.axis' : defaultAxisSource;
      var axis = parseAxis(axisValue) || { x: 0, y: 0, z: 1 };
      var record = { instanceKey: key, instanceId: instanceId };
      var worldMatrix = null;
      if (isInstanced && meshWorld) {
        var localMatrix = readInstanceMatrixElements(object, instanceId);
        if (localMatrix) worldMatrix = columnMultiply4(meshWorld, localMatrix);
      }
      if (worldMatrix) {
        record.worldPosition = positionFromMatrix(worldMatrix);
        record.worldDirection = directionFromMatrix(worldMatrix, axis);
        record.directionAxis = axisSource;
      } else if (entry && isPlainObject(entry.worldPosition) &&
        isFiniteNumber(entry.worldPosition.x) && isFiniteNumber(entry.worldPosition.y)) {
        // 小规模场景允许 catalog 直接给静态世界坐标（只做位置，不推断方向）。
        record.worldPosition = {
          x: round(entry.worldPosition.x),
          y: round(entry.worldPosition.y),
          z: isFiniteNumber(entry.worldPosition.z) ? round(entry.worldPosition.z) : 0
        };
        record.directionAxis = 'catalog.static-position';
        result.errors.push({ id: id, reason: 'instance-direction-unavailable（静态坐标目录不推断方向）:' + key });
      } else {
        result.errors.push({
          id: id,
          reason: isInstanced ? 'instance-matrix-unavailable:' + instanceId : 'instance-not-instanced-and-no-static-position:' + key
        });
        return;
      }
      record.visible = isVisibleInScene(object);
      if (axisSource === 'default:+Z') {
        result.errors.push({ id: id, reason: 'direction-axis-default:' + key });
      }
      list.push(record);
    });
    return list.length > 0 ? list : null;
  }

  // 部件取证：selector {type:'name'|'part'|'index', value} 或直接 partKey。
  function collectThreeParts(object, component, result, id) {
    var defs = Array.isArray(component.parts) ? component.parts : [];
    if (defs.length === 0) return null;
    var scene = state.preview && state.preview.scene;
    var out = {};
    defs.slice(0, 500).forEach(function (def) {
      var key = safeString(def && def.key, 120);
      if (!key) return;
      var partObject = resolveSelectorObject(object, scene, def.selector) || resolvePartObject(object, scene, key);
      if (!partObject) {
        result.errors.push({ id: id, reason: 'part-not-found:' + key });
        return;
      }
      var position = readWorldPosition(partObject);
      if (!position) {
        result.errors.push({ id: id, reason: 'part-no-world-position:' + key });
        return;
      }
      out[key] = { worldPosition: position, visible: isVisibleInScene(partObject) };
    });
    return Object.keys(out).length > 0 ? out : null;
  }

  function pickThreeByRaycaster(event, targets) {
    var three = getThreeNamespace();
    if (!three) return null;
    var preview = state.preview;
    if (!preview || !preview.camera || !preview.scene) return null;
    if (!isClickInsideCanvas(event)) return null;
    var ndc = clickToNdc(event);
    if (!ndc) return null;
    var raycaster = preview.raycaster;
    if (!raycaster || typeof raycaster.setFromCamera !== 'function') {
      try { raycaster = new three.Raycaster(); } catch (error) { raycaster = null; }
    }
    if (!raycaster || typeof raycaster.setFromCamera !== 'function') return null;
    try { raycaster.setFromCamera(ndc, preview.camera); } catch (error2) { return null; }
    var meshes = [];
    preview.scene.traverse(function (object) {
      if (!object) return;
      if (object.geometry && (object.isMesh === true || object.isInstancedMesh === true ||
        object.isLine === true || object.isPoints === true)) meshes.push(object);
    });
    if (meshes.length === 0) return null;
    var hits = [];
    try { hits = raycaster.intersectObjects(meshes, false); } catch (error3) { hits = []; }
    var firstUnknown = null;
    for (var i = 0; i < hits.length; i += 1) {
      var hit = hits[i];
      var matched = matchPickTarget(hit.object, targets, isFiniteNumber(hit.instanceId) ? hit.instanceId : null);
      matched.hitObject = hit.object || null;
      matched.object = matched.node || hit.object || null;
      matched.unknown = !matched.component;
      matched.worldPoint = hit.point && isFiniteNumber(hit.point.x)
        ? { x: round(hit.point.x), y: round(hit.point.y), z: round(hit.point.z) }
        : readWorldPosition(hit.object);
      if (matched.component) return matched;
      if (!firstUnknown) firstUnknown = matched;
    }
    // 全部命中都未登记：仍回报最前面的几何（unknown:true），面板据此提示“未登记”。
    return firstUnknown;
  }

  // 拿不到 THREE 构造器时的退化命中测试：把组件包围盒投影到屏幕，做近似矩形命中。
  // 能力差异会在 mc:ready.capabilities 里如实声明。
  function pickThreeByProjection(event, targets) {
    var preview = state.preview;
    if (!preview || !preview.camera || !preview.scene) return null;
    if (!isClickInsideCanvas(event)) return null;
    var ndc = clickToNdc(event);
    if (!ndc) return null;
    var matrix = cameraMatrices(preview.camera);
    if (!matrix) return null;
    var best = null;
    targets.forEach(function (target) {
      var object = resolveThreeObject(preview.scene, target.pick, target.id);
      if (!object) return;
      var corners = objectWorldCorners(object);
      if (!corners || corners.length === 0) {
        var position = readWorldPosition(object);
        if (!position) return;
        corners = [position];
      }
      var projected = [];
      corners.forEach(function (corner) {
        var point = projectPoint(matrix, corner);
        if (point) projected.push(point);
      });
      if (projected.length === 0) return;
      var minX = Infinity;
      var maxX = -Infinity;
      var minY = Infinity;
      var maxY = -Infinity;
      var depthSum = 0;
      projected.forEach(function (point) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
        depthSum += point.z;
      });
      var center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      var size = Math.max(maxX - minX, maxY - minY);
      var inside = ndc.x >= minX && ndc.x <= maxX && ndc.y >= minY && ndc.y <= maxY;
      var distance = Math.sqrt(Math.pow(ndc.x - center.x, 2) + Math.pow(ndc.y - center.y, 2));
      var threshold = Math.max(size * 0.5, 0.04);
      if (!inside && distance > threshold) return;
      var depth = depthSum / projected.length;
      if (best === null || depth < best.depth) best = { component: target, object: object, depth: depth };
    });
    return best;
  }

  function pickDomTarget(event) {
    var node = event.target;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 32) {
      var hasId = false;
      try { hasId = typeof node.hasAttribute === 'function' && node.hasAttribute('data-mc-id'); } catch (error) { hasId = false; }
      if (hasId) {
        var mcId = node.getAttribute('data-mc-id');
        for (var i = 0; i < state.pickTargets.length; i += 1) {
          if (state.pickTargets[i].id === mcId) return { component: state.pickTargets[i], object: node };
        }
        return { component: { id: mcId, pick: '[data-mc-id="' + escapeAttribute(mcId) + '"]' }, object: node };
      }
      node = node.parentNode;
      depth += 1;
    }
    return null;
  }

  function emitPick(matched, event) {
    if (!matched) return;
    var component = matched.component || null;
    var componentId = component ? safeString(component.id, 120) : null;
    restoreHighlight();
    try {
      var highlightObject = matched.object || matched.hitObject || null;
      if (highlightObject) {
        if (state.route === 'three' || detectThree()) highlightThree(highlightObject);
        else highlightDom(highlightObject);
      }
    } catch (error) { /* 高亮失败不影响点选结果上报 */ }

    var hitObject = matched.hitObject || matched.object || null;
    var isThree = state.route === 'three' || detectThree();
    var message = {
      type: 'mc:pick',
      componentId: componentId,
      unknown: !componentId,
      at: { x: round(event.clientX), y: round(event.clientY) }
    };
    if (component) {
      message.pick = component.pick !== undefined ? component.pick : componentId;
      if (component.kind) message.kind = component.kind;
      var label = targetLabel(component);
      if (label) message.label = label;
    }
    if (matched.partKey) message.partKey = matched.partKey;
    if (matched.instanceKey) message.instanceKey = matched.instanceKey;
    if (isFiniteNumber(matched.instanceId)) message.instanceId = matched.instanceId;
    if (hitObject && typeof hitObject.name === 'string' && hitObject.name) message.objectName = hitObject.name;
    if (matched.worldPoint) message.worldPoint = matched.worldPoint;
    if (isThree) {
      message.chain = Array.isArray(matched.chain) && matched.chain.length > 0
        ? matched.chain.slice(0, 32)
        : describeChain(hitObject);
    }
    postToParent(message);
  }

  // image 路线没有 DOM 组件：按登记区域（像素矩形）做命中，只回报像素坐标。
  function imageRegionAt(event) {
    for (var i = 0; i < state.pickTargets.length; i += 1) {
      var target = state.pickTargets[i];
      if (!target) continue;
      var region = normalizeRegion(target.pick) || normalizeRegion(target.region) || normalizeRegion(target.area);
      if (!region) continue;
      if (event.clientX >= region.x && event.clientX <= region.x + region.width &&
        event.clientY >= region.y && event.clientY <= region.y + region.height) {
        return { component: target, object: null };
      }
    }
    return null;
  }

  function onDocumentClick(event) {
    if (!state.pickMode) return;
    var matched = null;
    if (detectThree() || state.route === 'three') {
      matched = pickThreeByRaycaster(event, state.pickTargets) || pickThreeByProjection(event, state.pickTargets);
    } else if (state.route === 'image') {
      matched = imageRegionAt(event) || pickDomTarget(event);
    } else {
      matched = pickDomTarget(event);
    }
    if (matched) emitPick(matched, event);
  }

  // ── 截图 ─────────────────────────────────────────────────────────────────

  function downscaleDataUrl(dataUrl, maxWidth) {
    return new Promise(function (resolve) {
      try {
        var image = new Image();
        image.onload = function () {
          try {
            var ratio = Math.min(1, maxWidth / image.width);
            var width = Math.max(1, Math.round(image.width * ratio));
            var height = Math.max(1, Math.round(image.height * ratio));
            var canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            var context = canvas.getContext('2d');
            if (!context) { resolve(null); return; }
            context.drawImage(image, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png'));
          } catch (error) { resolve(null); }
        };
        image.onerror = function () { resolve(null); };
        image.src = dataUrl;
      } catch (error2) { resolve(null); }
    });
  }

  function screenshotUnavailable(requestId, reason) {
    postToParent({
      type: 'mc:screenshot',
      requestId: requestId || null,
      dataUrl: null,
      mime: null,
      reason: reason,
      route: resolveRoute(),
      capturedAt: nowIso()
    });
  }

  function handleScreenshot(requestId) {
    var route = resolveRoute();
    if (route !== 'three' || !canNativeScreenshot()) {
      // DOM / SVG / image：浏览器不给插件截取父页面之外的合成画面，如实拒绝。
      screenshotUnavailable(requestId, '浏览器无法在插件内截取 DOM/SVG，未声称已截图');
      return;
    }
    var preview = state.preview;
    var renderer = preview.renderer;
    var dataUrl = null;
    try {
      if (typeof renderer.render === 'function' && preview.scene && preview.camera) {
        renderer.render(preview.scene, preview.camera);
      }
      dataUrl = renderer.domElement.toDataURL('image/png');
    } catch (error) {
      screenshotUnavailable(requestId, 'renderer.domElement.toDataURL 抛错：' + String((error && error.message) || error));
      return;
    }
    if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/png') !== 0) {
      screenshotUnavailable(requestId, 'renderer.domElement.toDataURL 未返回 PNG 数据');
      return;
    }
    if (dataUrl.length <= MAX_SCREENSHOT_CHARS) {
      postToParent({
        type: 'mc:screenshot',
        requestId: requestId || null,
        dataUrl: dataUrl,
        mime: 'image/png',
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        capturedAt: nowIso()
      });
      return;
    }
    downscaleDataUrl(dataUrl, 640).then(function (smaller) {
      if (typeof smaller === 'string' && smaller.length <= MAX_SCREENSHOT_CHARS) {
        postToParent({
          type: 'mc:screenshot',
          requestId: requestId || null,
          dataUrl: smaller,
          mime: 'image/png',
          width: renderer.domElement.width,
          height: renderer.domElement.height,
          downscaled: true,
          capturedAt: nowIso()
        });
      } else {
        screenshotUnavailable(requestId, '截图超过 1 MiB 上限且降采样失败，未声称已截图');
      }
    });
  }

  // ── 入站消息（唯一的指令入口）────────────────────────────────────────────

  function handleHello(input) {
    if (typeof input.route === 'string' && /^(three|svg|dom|image)$/.test(input.route)) state.routeHint = input.route;
    if (isFiniteNumber(input.unitToPx) && input.unitToPx > 0) state.unitToPx = input.unitToPx;
    state.route = resolveRoute();
    postToParent({
      type: 'mc:ready',
      route: state.route,
      entryUrl: window.location.pathname + window.location.search,
      capabilities: capabilities(),
      buildHash: state.buildHash,
      adapterVersion: ADAPTER_VERSION,
      unitToPx: state.unitToPx,
      ack: 'hello'
    });
  }

  function handleCollect(input) {
    var requestId = safeString(input.requestId, 120);
    if (!requestId) {
      postToParent({ type: 'mc:error', requestId: null, code: 'bad-request', message: 'mc:collect 缺少 requestId' });
      return;
    }
    var components = Array.isArray(input.components) ? input.components.slice(0, MAX_COMPONENTS) : [];
    if (components.length === 0) {
      postToParent({ type: 'mc:error', requestId: requestId, code: 'bad-request', message: 'mc:collect 未提供 components' });
      return;
    }
      // P1：提供 pick 时的目标目录（含 parts/instances 用于归属判定）。
      state.pickTargets = components;
    whenStable().then(function (stable) {
      var route = resolveRoute();
      state.route = route;
      var collected = route === 'three'
        ? collectThree(components, {
          includeInstances: input.includeInstances,
          includeParts: input.includeParts
        })
        : route === 'image' ? collectImage(components)
          : collectDom(components);
      if (!stable) {
        collected.errors.push({ id: null, reason: '模型画面在限定帧数内未稳定，证据按实际采集时刻记录' });
      }
      var evidence = {
        type: 'mc:evidence',
        requestId: requestId,
        route: route,
        adapterVersion: ADAPTER_VERSION,
        buildHash: state.buildHash,
        sourceHash: null,
        context: observeContext(input.context),
        capturedAt: nowIso(),
        components: collected.components,
        coverage: collected.coverage,
        errors: collected.errors
      };
      postToParent(evidence);
    }).catch(function (error) {
      postToParent({
        type: 'mc:error',
        requestId: requestId,
        code: 'collect-failed',
        message: String((error && error.message) || error)
      });
    });
  }

  function handlePickMode(input) {
    var on = input.on === true;
    if (on && Array.isArray(input.components) && input.components.length > 0) {
      state.pickTargets = input.components.slice(0, MAX_COMPONENTS);
    }
    if (!on) {
      restoreHighlight();
      state.pickMode = false;
      return;
    }
    state.pickMode = true;
    if (!detectThree()) state.route = resolveRoute();
  }

  function onWindowMessage(event) {
    if (!event) return;
    // 唯一可信锚点：消息必须来自父面板窗口。
    if (event.source !== window.parent) return;
    // 不比较 event.origin：沙箱化的预览页是不透明源（'null'），且父面板与自身可能不同源；
    // 来源身份已由 source 判定，结构上再靠 channel/type/大小白名单收窄。
    var data = event.data;
    if (!isPlainObject(data)) return;
    if (data.channel !== CHANNEL) return;
    if (typeof data.type !== 'string' || !INCOMING_TYPES[data.type]) return;
    try {
      if (JSON.stringify(data).length > MAX_MESSAGE_CHARS) return;
    } catch (error) {
      return;
    }
    var payload = isPlainObject(data.request) ? data.request : data;
    if (data.type === 'mc:reload') {
      window.location.reload();
      return;
    }
    if (data.type === 'mc:hello') { handleHello(payload); return; }
    if (data.type === 'mc:collect') { handleCollect(payload); return; }
    if (data.type === 'mc:pick-mode') { handlePickMode(payload); return; }
    if (data.type === 'mc:screenshot') { handleScreenshot(safeString(payload.requestId, 120)); return; }
  }

  // ── 启动 ─────────────────────────────────────────────────────────────────

  function announceReady() {
    return whenStable().then(function () {
      state.route = resolveRoute();
      state.readyAnnounced = true;
      postToParent({
        type: 'mc:ready',
        route: state.route,
        entryUrl: window.location.pathname + window.location.search,
        capabilities: capabilities(),
        buildHash: state.buildHash,
        adapterVersion: ADAPTER_VERSION,
        unitToPx: state.unitToPx
      });
    });
  }

  function start() {
    if (state.cleaned) return;
    document.addEventListener('click', onDocumentClick, true);
    announceReady().catch(function (error) {
      postToParent({
        type: 'mc:error',
        requestId: null,
        code: 'ready-failed',
        message: String((error && error.message) || error)
      });
    });
  }

  window.addEventListener('message', onWindowMessage, false);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
