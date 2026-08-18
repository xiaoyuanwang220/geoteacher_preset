// GeoTeacher Agent — 内核插件（geo.kernel）
// 数据层 + 分析引擎 + 风格档案，供各功能插件通过 geo.kernel 服务消费。
// 不注册业务路由（只提供 /geo/health 健康检查）。
// 数据路径来自插件 config（knowledgeBasePath / questionBankPath / outputPath），未配置时回退默认。

// ========== YAML taxonomy 解析 ==========
function parseTaxonomyNodes(text) {
  const nodes = [];
  let current = null;
  const lines = text.split('\n');
  for (const line of lines) {
    const m = line.match(/^  - id:\s*(\S+)\s*$/);
    if (m) {
      if (current) nodes.push(current);
      current = { id: m[1] };
      continue;
    }
    if (!current) continue;
    const f = line.match(/^    (level|name|parent_id|definition|status|confidence|needs_review):\s*(.*)$/);
    if (f) {
      let value = f[2].trim();
      if (value === 'null') value = null;
      else if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      current[f[1]] = value;
    }
  }
  if (current) nodes.push(current);
  return nodes;
}

// ========== 文件遍历 ==========
// mtime 归一化为毫秒数（Date/字符串/数字兼容；取不到返回 null，不抛错）
function normalizeMtimeMs(info) {
  if (!info) return null;
  let m = info.mtimeMs ?? info.mtime ?? null;
  if (m == null) return null;
  if (m instanceof Date) return m.getTime();
  if (typeof m === 'string') { const p = Date.parse(m); return isNaN(p) ? null : p; }
  if (typeof m === 'number') return m;
  return null;
}

async function collectMdFiles(fsService, dirTarget, out) {
  let entries;
  try {
    entries = await fsService.listDir(dirTarget);
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (!name) continue;
    const childTarget = entry.target || entry;
    let isDir = false;
    const kind = entry.kind || entry.type;
    if (kind === 'directory' || kind === 'dir') {
      isDir = true;
    } else if (kind === 'file') {
      isDir = false;
    } else {
      try {
        const info = await fsService.stat(childTarget);
        isDir = !!(info && (typeof info.isDirectory === 'function' ? info.isDirectory() : (info.kind === 'directory' || info.type === 'directory')));
      } catch (e2) {
        isDir = false;
      }
    }
    if (isDir) {
      await collectMdFiles(fsService, childTarget, out);
    } else if (name.endsWith('.md')) {
      // 收集 mtime 供 loadBank 新鲜度检查（stat 不可用时置 null）
      let mtime = null;
      try {
        const info = await fsService.stat(childTarget);
        mtime = normalizeMtimeMs(info);
      } catch (e3) { mtime = null; }
      out.push({ name, target: childTarget, mtime });
    }
  }
}

// ========== 图片相对路径解析（imageRefs 用，纯字符串，不依赖 path 模块） ==========
// 把 md 里的相对图片路径 ![c](rel) 基于 md 所在磁盘目录解析为绝对磁盘路径。
function normalizeSlashes(p) {
  return String(p).replace(/\\/g, '/');
}
function toBackslashes(p) {
  return String(p).replace(/\//g, '\\');
}
function resolveImagePath(baseDir, rel) {
  // 统一成 / 段，用栈解析 ./ .. 和普通段
  const base = normalizeSlashes(baseDir).split('/');
  const segs = normalizeSlashes(rel).split('/');
  const stack = [];
  for (const s of base) { if (s) stack.push(s); } // 保留盘符如 "E:" 与各目录段
  // 去掉 base 末尾的目录名项会丢失；这里 base 是 md 目录完整路径，直接作为初始栈
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (stack.length > 1) stack.pop(); continue; }
    stack.push(seg);
  }
  // 处理盘符场景：形如 ["E:", "知识图谱", ...] → "E:/知识图谱/..."
  const joined = stack.join('/');
  // 若首段是 "E:" 之类盘符，补成 "E:/..."
  const abs = /^[A-Za-z]:/.test(stack[0] || '') ? joined : ('/' + joined);
  return toBackslashes(abs);
}
// 提取 md 文本中的图片引用数组
function extractImageRefs(text, mdDiskPath) {
  const out = [];
  const mdDir = String(mdDiskPath).replace(/\\/g, '/');
  const slashIdx = mdDir.lastIndexOf('/');
  const baseDir = slashIdx > 0 ? mdDir.slice(0, slashIdx) : mdDir;
  const re = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m = null; let idx = 0;
  while ((m = re.exec(text)) !== null) {
    idx++;
    const rel = m[2];
    const ext = rel.split('.').pop().toLowerCase();
    out.push({
      imageId: 'fig_' + idx,
      caption: (m[1] || '').trim(),
      sourcePath: resolveImagePath(baseDir, rel),
      rel,
      // 只接受真正的栅格图片扩展
      image: /png|jpe?g|webp|gif/.test(ext)
    });
  }
  return out;
}

// ========== frontmatter 解析 ==========
function parseFrontmatter(text) {
  const meta = {};
  text = text.replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return meta;
  for (const line of m[1].split('\n')) {
    const fm = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (fm) {
      let value = fm[2].trim();
      if (value.startsWith('[') || value.startsWith('{')) continue;
      if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }
      meta[fm[1]] = value;
    }
  }
  return meta;
}

// ========== 题目文件解析 ==========
function extractMaterial(lines) {
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    // 保留图注文字（图片路径丢弃，caption 有用信息保留）
    const imgMatch = t.match(/^!\[([^\]]*)\]\([^)]*\)\s*$/);
    if (imgMatch) {
      const caption = (imgMatch[1] || '').trim();
      if (caption) out.push('[图] ' + caption);
      continue;
    }
    if (t === '') continue;
    out.push(t);
  }
  return out.join('\n');
}

function pickValue(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return null;
  let value = line.slice(idx + 1).trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
  }
  return value;
}

function parseKmBlock(block) {
  const knowledgePoints = [];
  let current = null;
  let inKp = false;
  let inTags = false;
  const extraTags = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (/^knowledge_points:/.test(t)) { inKp = true; inTags = false; continue; }
    if (/^extra_tags:/.test(t)) { inKp = false; inTags = true; continue; }
    if (/^question_id:|^question_number:|^sub_question:|^taxonomy_version:|^confidence:|^label_status:|^needs_review:|^taxonomy_review:|^note:|^review_note:|^issue_type:/.test(t)) continue;
    if (inTags) {
      const m = t.match(/^- (.+)$/);
      if (m) extraTags.push(pickValue('- ' + m[1]) || m[1]);
      continue;
    }
    if (!inKp) continue;
    const rm = t.match(/^- role:\s*(.+)$/);
    if (rm) {
      if (current) knowledgePoints.push(current);
      current = { role: rm[1].trim() };
      continue;
    }
    if (!current) continue;
    const f = t.match(/^(weight|domain|theme|knowledge_unit_id|knowledge_unit|evidence):\s*(.*)$/);
    if (f) {
      current[f[1]] = pickValue(t) || f[2].trim();
    }
  }
  if (current) knowledgePoints.push(current);
  return { knowledgePoints, extraTags };
}

function parseQuestionFileFull(text) {
  const sections = [];
  let current = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = line.match(/^#{2,3} (.+)$/);
    if (m) {
      current = { title: m[1], lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  let material = '';
  const questions = [];
  for (const sec of sections) {
    const body = sec.lines.join('\n');
    if (/^题组材料/.test(sec.title)) {
      material = extractMaterial(sec.lines);
    } else if (/^第\d+题/.test(sec.title)) {
      const q = parseOneQuestion(sec.title, body);
      if (q) questions.push(q);
    }
  }
  return { material, questions };
}

function parseOneQuestion(title, body) {
  let questionId = '';
  let stem = '';
  const options = [];
  let answer = '';
  let analysis = '';
  let phase = 'idle';
  const lines = body.split('\n');

  const kmStart = body.indexOf('<!-- MANAGED-KM-START');
  let km = { knowledgePoints: [], extraTags: [] };
  if (kmStart >= 0) {
    const kmEnd = body.indexOf('-->', kmStart);
    if (kmEnd > kmStart) {
      km = parseKmBlock(body.slice(kmStart, kmEnd));
    }
  }

  let inKm = false; // MANAGED-KM 块状态机：KM 内 YAML 行不按正文处理（修复 question_id 双引号污染）
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;

    // KM 块行跳过：start 行开状态，首个 --> 行闭（与 kmStart/kmEnd 边界一致，含同行闭合）
    if (/^<!-- MANAGED-KM-START/.test(t)) { inKm = true; continue; }
    if (inKm) {
      if (/-->/.test(t)) inKm = false;
      continue;
    }

    // 单正则兼容反引号/双引号/裸 id；KM 行已被跳过，此兼容为纵深防御
    const qid = t.match(/^question_id:\s*["`]?([^"`]+)["`]?\s*$/);
    if (qid) { questionId = qid[1].trim(); continue; }

    const stemMark = t.match(/^\*\*(题干|小问)\*\*[：:]\s*(.*)$/);
    if (stemMark) {
      phase = 'stem';
      const inline = stemMark[2].trim(); // 捕获组 2 = 真实题干内容（组 1 是「题干/小问」marker）
      if (inline) stem = inline;
      continue;
    }
    const optMark = t.match(/^\*\*选项\*\*[：:]\s*(.*)$/);
    if (optMark) {
      phase = 'options';
      const inline = optMark[1].trim();
      if (inline) {
        const m = inline.match(/^-?\s*([A-D])[.、．)]\s*(.+)$/);
        if (m) options.push(m[1] + '. ' + m[2]);
      }
      continue;
    }
    const ansMark = t.match(/^\*\*答案\*\*[：:]\s*(.*)$/);
    if (ansMark) {
      phase = 'answer';
      const inline = ansMark[1].trim();
      if (inline) answer = inline;
      continue;
    }
    const anaMark = t.match(/^\*\*解析\*\*[：:]\s*(.*)$/);
    if (anaMark) {
      phase = 'analysis';
      const inline = anaMark[1].trim();
      if (inline) analysis = inline;
      continue;
    }
    if (/^\*\*知识点归属\*\*/.test(t) || /^\*\*整体置信度\*\*/.test(t)) { phase = 'idle'; continue; }
    if (/^<!--/.test(t)) { phase = 'idle'; continue; }
    if (/^#{1,3} /.test(t)) { phase = 'idle'; continue; }

    if (phase === 'stem') {
      const m = t.match(/^-?\s*([A-D])[.、．)]\s*(.+)$/);
      if (m) {
        phase = 'options';
        options.push(m[1] + '. ' + m[2]);
      } else {
        stem += (stem ? '\n' : '') + t;
      }
      continue;
    }
    if (phase === 'options') {
      const m = t.match(/^-?\s*([A-D])[.、．)]\s*(.+)$/);
      if (m) options.push(m[1] + '. ' + m[2]);
      continue;
    }
    if (phase === 'answer') {
      const am = t.match(/^【答案】?\s*\d*[.、．)]\s*([A-D])(?:\s*(.*))?$/);
      if (am) answer = am[1] + (am[2] ? ' ' + am[2] : '');
      else answer += (answer ? '\n' : '') + t;
      continue;
    }
    if (phase === 'analysis') {
      analysis += (analysis ? '\n' : '') + t;
      continue;
    }
  }

  stem = stem.replace(/\\\./g, '.');
  if (!questionId || (!stem && options.length === 0)) return null;
  return { questionId, stem, options, answer, analysis, knowledgePoints: km.knowledgePoints, extraTags: km.extraTags };
}

// ========== 分析引擎 ==========
function detectStemMode(stem, isChoice) {
  if (/①|②|③|④/.test(stem) && /[（(]\s*[)）]/.test(stem)) return '组合判断（①②③④选组）';
  if (/原因是|为什么/.test(stem)) return '原因分析';
  if (/影响|作用|意义/.test(stem)) return '影响/意义评价';
  if (/措施|对策|建议|治理|方式|途径/.test(stem)) return '措施对策类';
  if (/比较|差异|对比/.test(stem)) return '比较分析';
  if (!isChoice) return '综合问答题（分析/说明类）';
  if (/[（(]\s*[)）]/.test(stem)) return '单项判断选择';
  return '选择判断';
}

function detectContextType(material) {
  const types = [];
  if (/图|示意|统计|表格|坐标|曲线/.test(material)) types.push('图表/示意图');
  if (/(省|市|地区|口岸|山脉|河流|盆地|高原|平原|城市|县|岛|湾)/.test(material)) types.push('区域案例');
  if (/近年来|20\d{2}年|目前|近期|现在/.test(material)) types.push('时事/动态');
  if (/材料一|材料二|材料三/.test(material)) types.push('多材料组合');
  if (types.length === 0) types.push('文字材料');
  return types;
}

function detectLiteracy(stem, material) {
  const text = stem + material;
  const literacy = [];
  if (/(生态|环境|资源|可持续|人地|治理|协调|低碳|绿色)/.test(text)) literacy.push('人地协调观');
  if (/(要素|关联|影响|作用|机制|综合|产业|结构)/.test(text)) literacy.push('综合思维');
  if (/(区域|区位|地方|分布|城市|港口|腹地|城市群)/.test(text)) literacy.push('区域认知');
  if (/(措施|建议|方案|实践|调查|规划|示范|应用)/.test(text)) literacy.push('地理实践力');
  if (literacy.length === 0) literacy.push('综合思维');
  return literacy;
}

function detectAbility(stem, isChoice) {
  if (/评价|是否合理|利弊/.test(stem)) return '评价';
  if (/分析|说明|指出|归纳|概括/.test(stem)) return '分析';
  if (!isChoice) return '分析';
  if (/简述|描述|列举|识别/.test(stem)) return '应用';
  return '理解';
}

function detectDifficulty(q) {
  let score = 0;
  if (q.options && q.options.length >= 4) score += 1;
  if (/①|②|③|④/.test(q.stem)) score += 1;
  if (q.knowledgePoints.length >= 3) score += 1;
  if (!q.options || q.options.length === 0) score += 1;
  if (score >= 3) return '偏难';
  if (score === 2) return '中等';
  return '基础';
}

// ========== 讲题 Solver 骨架引擎（P1，geo_solve 支撑） ==========
// 设问类型化分类（去机械化：不套"自然原因+人文原因"式模板，按材料实际支撑组织）
const QUESTION_TYPES = {
  cause: { name: '原因分析', hint: '按因果层次组织：直接原因→根本条件→触发因素→加剧因素；材料没提的层次不硬凑', verbs: ['原因', '成因', '为什么', '源于', '由于', '取决于'] },
  effect: { name: '影响/意义评价', hint: '分主体（对自然/对人文，受益/受损）+ 分层次（直接—间接、短期—长期）+ 经济/社会/生态维度，按材料支持组织', verbs: ['影响', '意义', '作用'] },
  process: { name: '形成过程/演变', hint: '按阶段与时间顺序组织：环节链（环节→驱动因素→动态变化），不是静态罗列', verbs: ['过程', '演变', '形成', '发育', '演化'] },
  compare: { name: '比较分析', hint: '可比指标 + 同口径 + 区域限定；只比较材料与知识支持的方面', verbs: ['比较', '差异', '对比', '区别'] },
  evaluate: { name: '评价/利弊', hint: '分主体利弊 + 代价与可行性 + 适用条件；结论有前提', verbs: ['评价', '是否合理', '利弊', '可行性'] },
  measure: { name: '措施/对策', hint: '针对性（对应原因/问题）+ 分主体（政府/企业/个人）+ 可行性；措施为什么能解决这个问题', verbs: ['措施', '对策', '建议', '治理', '途径', '方式'] },
  describe: { name: '分布/特征描述', hint: '空间方位/范围/形状/集中或分散 + 随….变化 + 数据支撑；有位置/方向/数值依据，不是形容词堆砌', verbs: ['分布', '特征', '描述', '简述', '指出', '标识'] },
  trend: { name: '变化/趋势', hint: '时间尺度的动态表述（方向+幅度+速率），区分现状/过程/预测', verbs: ['趋势', '变化趋势', '增速', '变化特点'] }
};

function classifyQuestion(stem) {
  for (const key of Object.keys(QUESTION_TYPES)) {
    if (QUESTION_TYPES[key].verbs.some(v => stem.includes(v))) {
      return { key, name: QUESTION_TYPES[key].name, hint: QUESTION_TYPES[key].hint };
    }
  }
  return { key: 'other', name: '综合/开放', hint: '按材料实际支撑组织：先明确对象与行为动词，再找要素证据，避免机械套模板' };
}

// 要素维度排查词表（自然 + 人文清单，供 dimensionScan 使用）
const ELEMENT_DIMENSIONS = {
  position: { name: '位置', keywords: ['纬度', '经度', '位于', '方位', '海陆', '东部', '西部', '南部', '北部', '临海', '内陆'] },
  terrain: { name: '地形', keywords: ['地形', '地貌', '山地', '平原', '高原', '盆地', '丘陵', '坡度', '海拔', '谷地'] },
  climate: { name: '气候', keywords: ['气候', '气温', '降水', '季风', '温度', '雨量', '干湿', '盛行风', '光照'] },
  water: { name: '水源', keywords: ['水源', '河流', '湖泊', '径流', '水文', '地下水', '水系', '流域', '湿地'] },
  soil: { name: '土壤', keywords: ['土壤', '土层', '腐殖', '肥力', '冻土'] },
  biology: { name: '生物/植被', keywords: ['植被', '生物', '森林', '草原', '作物', '物种', '栖息', '自然带'] },
  population: { name: '人口/聚落', keywords: ['人口', '聚落', '城市', '村庄', '城镇', '人口密度', '居住'] },
  agriculture: { name: '农业', keywords: ['农业', '种植', '养殖', '农作物', '耕地', '粮食', '农作'] },
  industry: { name: '工业', keywords: ['工业', '产业', '工厂', '制造', '加工', '钢铁', '机械', '能源', '电力', '经济'] },
  services: { name: '服务业', keywords: ['服务业', '旅游', '商业', '金融', '物流', '第三产业'] },
  transport: { name: '交通', keywords: ['交通', '铁路', '公路', '港口', '航线', '运输', '枢纽', '腹地'] },
  market: { name: '市场', keywords: ['市场', '需求', '消费', '客源', '销售', '出口', '内销'] },
  policy: { name: '政策', keywords: ['政策', '政府', '补贴', '规划', '法规', '扶持', '制度'] },
  technology: { name: '技术', keywords: ['技术', '科技', '研发', '自动化', '智能化', '工艺'] }
};

function dimensionScan(material) {
  const hits = {};
  for (const key of Object.keys(ELEMENT_DIMENSIONS)) {
    const dim = ELEMENT_DIMENSIONS[key];
    const evidence = dim.keywords.filter(kw => material.includes(kw));
    if (evidence.length) hits[key] = { name: dim.name, evidence };
  }
  return hits;
}

function detectDistractors(analysisText) {
  const result = [];
  if (!analysisText) return result;
  const sentences = analysisText.split(/[。；]/);
  for (let i = 0; i < sentences.length; i++) {
    const m = sentences[i].match(/([A-D①②③④])\s*(?:错误|不正确)/);
    if (m) {
      const prev = (sentences[i - 1] || '').trim();
      const reason = (prev ? prev + '。' : '') + sentences[i].trim();
      result.push({ option: m[1], reason: reason.slice(0, 60) });
    }
  }
  return result;
}

// ========== 蓝图引擎 ==========
function collectSamePointContexts(all, currentQ, coreKp) {
  const kuId = coreKp.knowledge_unit_id || coreKp.knowledgeUnitId;
  const out = [];
  for (const item of all) {
    if (item.questionId === currentQ.questionId) continue;
    const hit = (item.knowledgePoints || []).some(kp =>
      (kp.knowledge_unit_id === kuId || kp.knowledgeUnitId === kuId));
    if (hit) {
      out.push({ file: item.file, material: (item.material || '').slice(0, 80), stem: item.stem.slice(0, 40) });
    }
  }
  return out;
}

function buildBlueprint(analysis, all, q) {
  const coreKp = analysis.examPoints[0] || {};
  const alternatives = collectSamePointContexts(all, q, coreKp);
  const suggested = alternatives.length > 0
    ? `换用同考点其他情境（如「${alternatives[0].material.replace(/[，。].*$/, '')}」）或结合时事素材`
    : '结合时事热点或教材案例设计全新情境（当前题库该考点情境较少）';
  const isChoice = q.options && q.options.length > 0;
  return {
    corePoint: {
      domain: coreKp.domain || '',
      theme: coreKp.theme || '',
      knowledgeUnit: coreKp.knowledge_unit || coreKp.knowledgeUnit || '',
      weight: coreKp.weight || '1.0'
    },
    contextSuggestion: suggested,
    alternativeContexts: alternatives,
    stemTemplate: `仿写：保持「${analysis.stemMode}」的考查角度，将情境替换为「${suggested.split('「')[1] ? suggested.split('「')[1].replace(/」.*$/, '') : '新情境'}」，设问对象换为新情境中的同类主体`,
    alternativeAngle: isChoice
      ? '换角度：从"判断现象"转为"分析成因/影响"，或将单项选择改为组合判断（①②③④）'
      : '换角度：从"分析/说明"改为"评价/比较"，或增设小问要求"提出措施并说明依据"',
    optionDesign: isChoice
      ? {
          correct: `正确项设计：依据「${coreKp.knowledge_unit || '核心考点'}」的核心机制，保证与材料信息直接对应`,
          distractors: analysis.distractors.length > 0
            ? analysis.distractors.map(d => `迁移原题干扰逻辑（${d.option}：${d.reason}），换情境后重写干扰项，保持"绝对化/片面化/因果倒置"等设错方式`)
            : ['设置与材料信息相悖的绝对化表述', '设置片面因果（只对一半）', '设置程度夸大项']
        }
      : null,
    literacy: analysis.literacy,
    difficulty: analysis.difficulty
  };
}

function buildAnalysis(q, material, file) {
  const isChoice = q.options && q.options.length > 0;
  const examPoints = (q.knowledgePoints || []).map(kp => ({
    role: kp.role === 'core_exam_point' ? '核心考点'
         : kp.role === 'supporting_knowledge' ? '支撑知识'
         : kp.role === 'material_clue' ? '材料线索'
         : kp.role === 'background_knowledge' ? '背景知识' : (kp.role || ''),
    weight: kp.weight,
    domain: kp.domain || '',
    theme: kp.theme || '',
    knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || '',
    evidence: kp.evidence || ''
  }));
  return {
    questionId: q.questionId,
    file,
    questionType: isChoice ? '选择题' : '综合题',
    stemMode: detectStemMode(q.stem, isChoice),
    contextTypes: detectContextType(material),
    literacy: detectLiteracy(q.stem, material),
    abilityLevel: detectAbility(q.stem, isChoice),
    difficulty: detectDifficulty(q),
    examPoints,
    distractors: isChoice ? detectDistractors(q.analysis) : [],
    material,
    stem: q.stem,
    options: q.options,
    extraTags: q.extraTags || []
  };
}

// ========== Markdown 导出 ==========
function renderAnalysisMarkdown(result) {
  const { analysis, blueprint } = result;
  let md = '';
  md += `# 真题分析报告\n\n`;
  md += `- 题目 ID：${analysis.questionId}\n`;
  md += `- 来源：${analysis.file}\n\n`;
  md += `## 一、真题分析（为什么这样考）\n\n`;
  md += `### 考什么\n`;
  for (const kp of analysis.examPoints) {
    md += `- **[${kp.role}] 权重 ${kp.weight}**：${kp.domain} → ${kp.theme} → ${kp.knowledgeUnit}\n`;
    if (kp.evidence) md += `  - 映射证据：${kp.evidence}\n`;
  }
  md += `\n### 怎么考\n`;
  md += `- 题型：${analysis.questionType}\n`;
  md += `- 设问模式：${analysis.stemMode}\n`;
  md += `- 情境类型：${analysis.contextTypes.join('、')}\n`;
  md += `- 材料：${(analysis.material || '').slice(0, 120)}${(analysis.material || '').length > 120 ? '…' : ''}\n`;
  md += `- 题干：${analysis.stem}\n`;
  if (analysis.options.length > 0) md += `- 选项：${analysis.options.join('；')}\n`;
  md += `\n### 为什么这样考\n`;
  md += `- 素养立意：${analysis.literacy.join('、')}\n`;
  md += `- 能力层次：${analysis.abilityLevel}\n`;
  md += `- 难度定位：${analysis.difficulty}\n`;
  if (analysis.distractors.length > 0) {
    md += `- 干扰项设计逻辑（规则提取）：\n`;
    for (const d of analysis.distractors) md += `  - ${d.option}：${d.reason}\n`;
  }
  if (analysis.extraTags.length > 0) md += `- 情境标签：${analysis.extraTags.join('、')}\n`;
  md += `\n## 二、命题蓝图（下一道题怎么设计）\n\n`;
  md += `### 考点锁定\n`;
  md += `- 核心考点：${blueprint.corePoint.domain} → ${blueprint.corePoint.theme} → ${blueprint.corePoint.knowledgeUnit}（权重 ${blueprint.corePoint.weight}）\n`;
  md += `\n### 情境换新\n`;
  md += `- 建议：${blueprint.contextSuggestion}\n`;
  if (blueprint.alternativeContexts.length > 0) {
    md += `- 同考点可参考情境：\n`;
    for (const alt of blueprint.alternativeContexts.slice(0, 5)) {
      md += `  - ${alt.file}：材料「${alt.material}」；设问「${alt.stem}」\n`;
    }
  }
  md += `\n### 设问设计\n`;
  md += `- 保留角度（仿写）：${blueprint.stemTemplate}\n`;
  md += `- 换角度（迁移）：${blueprint.alternativeAngle}\n`;
  if (blueprint.optionDesign) {
    md += `\n### 选项设计（选择题）\n`;
    md += `- 正确项：${blueprint.optionDesign.correct}\n`;
    md += `- 干扰项：\n`;
    for (const d of blueprint.optionDesign.distractors) md += `  - ${d}\n`;
  }
  md += `\n### 素养与难度目标\n`;
  md += `- 素养：${blueprint.literacy.join('、')}\n`;
  md += `- 难度：${blueprint.difficulty}\n`;
  return md;
}

// ========== 讲题 Judge 骨架（P2） ==========
// 倒推采分点 scorePoints：从答案/解析+知识点映射提取"该题要采的几个要点"，
// 供 geo_judge 在开放答案后做得分点覆盖核验。综合题按要点/维度拆分；选择题给整题采分点。
function buildScorePoints(q, isChoice) {
  const points = [];
  if (isChoice) {
    const ansExpr = (q.answer || '').trim();
    const correctOption = /^([A-D])/.exec(ansExpr);
    // 采分点 = 正确选项 + 其对应知识单元（从 KM 映射取核心考点）
    const coreKp = (q.knowledgePoints || []).find(kp => kp.role === 'core_exam_point');
    points.push({
      type: 'choice',
      option: correctOption ? correctOption[1] : '',
      answer: ansExpr,
      knowledgeUnit: (coreKp && (coreKp.knowledge_unit || coreKp.knowledgeUnit)) || '',
      evidence: (coreKp && coreKp.evidence) || '',
      weight: (coreKp && coreKp.weight) || '1.0'
    });
    return points;
  }
  // 综合题：按答案的要点拆分（分号/换行/序号），每点补要素维度与知识点
  const clu = ELEMENT_DIMENSIONS;
  const fragment = (q.answer || '').split(/[；;]\s*|\n+/).map(s => s.trim()).filter(Boolean);
  const body = fragment.length > 1 ? fragment : ((q.answer || '' + q.analysis) || '').split(/[；;]\s*|\n+/).map(s => s.trim()).filter(Boolean);
  const source = body.length > 0 ? body : [(q.answer || '').trim() || '（解析待补）'];
  for (const seg of source) {
    const dims = Object.keys(clu).filter(k => clu[k].keywords.some(kw => seg.includes(kw)));
    points.push({ type: 'comprehensive', point: seg, dimension: dims.map(k => clu[k].name), applied: '' });
  }
  return points;
}

// judge 核验骨架：给模型开放的答案/解析/采分点 + 待填的命中/遗漏/干扰项分栏
function buildJudgeScaffold(q, isChoice) {
  const scorePoints = buildScorePoints(q, isChoice);
  const distractors = isChoice ? detectDistractors(q.analysis) : [];
  return {
    isChoice,
    standardAnswer: q.answer || '',
    analysis: q.analysis || '',
    scorePoints,
    coverageGrid: scorePoints.map(p => ({
      match: p.option ? ('正确项=' + p.option) : '',
      hit: '',            // 待模型填：完全命中 / 部分 / 遗漏
      note: ''            // 待模型填：独立答案与该点的关系
    })),
    distractorTargets: distractors.map(d => ({ option: d.option, reason: d.reason, independentJudged: '' }))
  };
}

// ========== 讲题 Explainer 骨架（P3） ==========
// 将已验证解题过程重组为「题目定位—审题—破题—反思迁移」四段式讲题稿（教学化重组，不照抄解析）。
// 输入：题目 + solver 已生成的题干/选项 + judge 核验结果 + 同考点变式。
function buildExplainerReport(q, isChoice, judge, variants) {
  const coreKp = (q.knowledgePoints || []).find(kp => kp.role === 'core_exam_point');
  const framework = classifyQuestion(q.stem);
  const scans = dimensionScan(q.material || '');
  const literacy = detectLiteracy(q.stem, q.material || '');
  const difficulty = detectDifficulty(q);
  const focusElements = Object.keys(scans).map(k => scans[k].name);
  return {
    questionId: q.questionId,
    basic: {
      type: isChoice ? '选择题' : '综合题',
      difficulty,
      literacy: literacy.join('、'),
      questionType: framework.name,
      focusElements,
      materialLength: q.material ? q.material.length : 0,
      hasImage: /图|示意|坐标|曲线|统计|表格/.test(q.material || '')
    },
    // 四段式讲题稿的结构骨架，正文由模型在 explainer 技能中填充
    structure: {
      locate: { title: '题目定位', fields: bestowBasicLabels(q, isChoice, difficulty, framework) },
      examine: { title: '审题', hint: framework.hint },
      solve: {
        title: '破题',
        choiceNote: isChoice ? '选择题：读图→定向读材料→逐项排除链（材料证据×知识×设问），每个干扰项讲清错因' : '综合题：读图→定向读材料→要素维度排查→采分点组织（要素+证据+结论）→术语规范',
        dimensionScan: scans
      },
      reflect: { title: '反思与迁移', alternatives: variants, coreKnowledgeUnit: (coreKp && (coreKp.knowledge_unit || coreKp.knowledgeUnit)) || '' }
    },
    judgeSummary: judge ? { scorePoints: judge.scorePoints, coverageGrid: judge.coverageGrid } : null
  };
}

function bestowBasicLabels(q, isChoice, difficulty, framework) {
  const meta = q.meta || {};
  return {
    type: isChoice ? '选择题' : '综合题',
    difficulty,
    yearProvince: `${meta.year || ''}${meta.region || ''}卷`,
    numbers: meta.question_numbers || '',
    literacy: detectLiteracy(q.stem, q.material || '').join('、'),
    frameworkName: framework.name
  };
}

// ========== 风格档案聚合（七维度） ==========
function buildStyleProfile(pickedGroups, analyses) {
  const groupSizes = pickedGroups.map(g => g.items.length);
  const materials = pickedGroups.map(g => g.items[0] ? (g.items[0].material || '') : '');
  const chartKinds = new Set();
  for (const m of materials) {
    if (/柱状|折线|曲线/.test(m)) chartKinds.add('折线/柱状图');
    if (/表格|统计表/.test(m)) chartKinds.add('统计表');
    if (/区域图|地形图|分布图|地图/.test(m)) chartKinds.add('区域/分布图');
    if (/剖面图|示意图/.test(m)) chartKinds.add('示意图');
  }
  const groupStructure = {
    groupCount: pickedGroups.length,
    questionsPerGroup: groupSizes.length ? `${Math.min(...groupSizes)}-${Math.max(...groupSizes)}` : '-',
    sharedMaterialForms: [...new Set(materials.map(m =>
      /材料一|材料二/.test(m) ? '多材料组合' : /图|表/.test(m) ? '图/表+情境' : '情境段'))]
  };
  const ctxUnion = new Set();
  let sentenceCount = 0;
  let dataDense = 0;
  for (const m of materials) {
    for (const t of detectContextType(m)) ctxUnion.add(t);
    sentenceCount += (m.match(/[。！？]/g) || []).length;
    if (/\d/.test(m)) dataDense += 1;
  }
  const materialFeatures = {
    avgSentences: materials.length ? (sentenceCount / materials.length).toFixed(1) : '-',
    contextTypes: [...ctxUnion],
    dataDensity: materials.length ? `${Math.round(dataDense / materials.length * 100)}%含数据` : '-'
  };
  const chartFeatures = { chartTypes: chartKinds.size ? [...chartKinds] : ['无图/纯文字'] };
  const verbs = new Map();
  const modes = new Set();
  for (const a of analyses) {
    modes.add(a.stemMode);
    const verbHit = (a.stem || '').match(/^(请)?(简述|说明|分析|指出|推测|评价|比较|描述|解释|判断|提出|列举|归纳|概括)/);
    if (verbHit) verbs.set(verbHit[2], (verbs.get(verbHit[2]) || 0) + 1);
  }
  const questionFeatures = {
    stemModes: [...modes],
    verbFrequency: [...verbs.entries()].sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`)
  };
  let combo = 0, choiceTotal = 0;
  const distractorNotes = new Set();
  for (const a of analyses) {
    if (a.options && a.options.length) {
      choiceTotal += 1;
      if (/①|②|③|④/.test(a.stem)) combo += 1;
    }
    for (const d of a.distractors) {
      if (/绝对|一定|都|只/.test(d.reason)) distractorNotes.add('绝对化');
      if (/因果|倒置/.test(d.reason)) distractorNotes.add('因果倒置');
      if (/片面|只对一半/.test(d.reason)) distractorNotes.add('片面化');
      if (/无中生有|材料未提/.test(d.reason)) distractorNotes.add('无中生有');
    }
  }
  const optionFeatures = {
    comboRatio: choiceTotal ? `${Math.round(combo / choiceTotal * 100)}%组合式` : '-',
    distractorTactics: distractorNotes.size ? [...distractorNotes] : ['（未从解析中归纳）']
  };
  const compItems = [];
  for (const a of analyses) {
    if (a.questionType === '综合题') compItems.push(a);
  }
  const compSizes = compItems.map(a => (a.stem.match(/（\d）/g) || []).length);
  const comprehensiveFeatures = {
    itemCount: compItems.length,
    subQuestionRange: compSizes.length ? `${Math.min(...compSizes)}-${Math.max(...compSizes)}小问` : '-'
  };
  const analysisFeatures = {
    hasInsightExtension: /点睛/.test(materials.join('')) ? '部分含【点睛】知识拓展' : '未见【点睛】扩展',
    citationStyle: '解析引用材料信息（规则推断）'
  };
  return {
    groupStructure,
    materialFeatures,
    chartFeatures,
    questionFeatures,
    optionFeatures,
    analysisFeatures,
    comprehensiveFeatures
  };
}

export default {
  name: 'geo-core',
  inject: ['fs', 'webServer'],
  apply(ctx, config) {
    const fsService = ctx.fs;
    const webServer = ctx.webServer;
    const cfg = config || {};
    const KNOWLEDGE_BASE_PATH = cfg.knowledgeBasePath || 'E:/知识图谱/config';
    const QUESTION_BANK_PATH = cfg.questionBankPath || 'E:/知识图谱/obsidian_vault/04_题目';
    const OUTPUT_PATH = cfg.outputPath || 'E:/geo_edu_agent/outputs';
    // 导出写盘用的沙箱策略：standing mount 无会话上下文，fs 服务会用默认 workspaceRoot
    // （部署的 E:\DeepSeek\Harness），写项目内 outputs 会被拒；这里显式传入项目 workspace。
    const WRITE_POLICY = { mode: 'workspace-write', workspaceRoot: cfg.workspaceRoot || 'E:/geo_edu_agent' };

    // ========== 题库索引（预构建 + 磁盘持久化 + 内存缓存） ==========
    let _bankCache = null; // 内存缓存：{ byId: Map, all: [], filesCount, builtAt }
    const INDEX_PATH = OUTPUT_PATH + '/question-index.json';
    // 索引格式版本：items 结构/字段变化时必须递增；scripts/geo-verify.mjs 的 index-data 断言按此版本校验
    const INDEX_VERSION = 3;

    async function loadBank() {
      // 1. 内存缓存命中 → 直接返回
      if (_bankCache) return _bankCache;

      // 2. 尝试从磁盘读索引
      const bankDir = await fsService.resolve(QUESTION_BANK_PATH);
      const files = [];
      await collectMdFiles(fsService, bankDir, files);
      const currentFileCount = files.length;

      try {
        const idxTarget = await fsService.resolve(INDEX_PATH);
        const raw = await fsService.readText(idxTarget);
        const idx = JSON.parse(raw);
        // 新鲜度检查：version 代际（须与 INDEX_VERSION 一致）+ 文件数 + mtime（任一文件晚于 builtAt 即重建）
        const builtAt = Date.parse(idx && idx.builtAt) || 0;
        let fresh = !!(idx && idx.version === INDEX_VERSION && idx.fileCount === currentFileCount && Array.isArray(idx.items));
        if (fresh) {
          const maxMtime = files.reduce((mx, f) => (f.mtime && f.mtime > mx ? f.mtime : mx), 0);
          if (maxMtime > 0 && maxMtime > builtAt) fresh = false; // stat 不可用时 maxMtime=0 → 跳过 mtime 判断
        }
        if (fresh) {
          const byId = new Map();
          const all = [];
          for (const item of idx.items) {
            // 确保 knowledgePoints 是数组
            if (!Array.isArray(item.knowledgePoints)) item.knowledgePoints = [];
            byId.set(item.questionId, item);
            all.push(item);
          }
          _bankCache = { byId, all, filesCount: currentFileCount, builtAt: idx.builtAt, fromIndex: true };
          console.log(`geo-core: 题库索引从磁盘加载 (${all.length} 小问, ${currentFileCount} 文件)`);
          return _bankCache;
        }
      } catch (e) {
        // 索引不存在/损坏/版本不符/文件更新 → 重建
      }

      // 3. 全量扫描 + 构建索引
      const byId = new Map();
      const all = [];
      for (const f of files) {
        const content = await fsService.readText(f.target);
        const meta = parseFrontmatter(content);
        const parsed = parseQuestionFileFull(content);
        // 获取文件磁盘绝对路径（供 imageRefs 直接读文件，不重新遍历）
        let filePath = '';
        try { filePath = fsService.processPath(f.target); } catch (e) { filePath = f.name; }
        for (const q of parsed.questions) {
          const item = { ...q, file: f.name, filePath, material: parsed.material, meta, knowledgePoints: q.knowledgePoints || [] };
          byId.set(q.questionId, item);
          all.push(item);
        }
      }
      _bankCache = { byId, all, filesCount: currentFileCount, builtAt: new Date().toISOString(), fromIndex: false };
      console.log(`geo-core: 题库全量扫描完成 (${all.length} 小问, ${currentFileCount} 文件), 正在写索引...`);

      // 4. 写磁盘索引
      try {
        const indexData = {
          version: INDEX_VERSION, // v3：索引持久化完整题目信息（answer/analysis），修复磁盘加载后 judge 标准答案丢失（方案 A）
          builtAt: _bankCache.builtAt,
          fileCount: currentFileCount,
          questionCount: all.length,
          items: all.map(item => ({
            questionId: item.questionId,
            file: item.file,
            filePath: item.filePath || '',
            stem: item.stem,
            options: item.options || [],
            material: item.material,
            answer: item.answer || '',
            analysis: item.analysis || '',
            meta: item.meta || {},
            knowledgePoints: (item.knowledgePoints || []).map(kp => ({
              role: kp.role,
              domain: kp.domain || '',
              theme: kp.theme || '',
              knowledge_unit: kp.knowledge_unit || kp.knowledgeUnit || '',
              knowledge_unit_id: kp.knowledge_unit_id || kp.knowledgeUnitId || '',
              theme_id: kp.theme_id || '',
              weight: kp.weight || '',
              evidence: kp.evidence || ''
            })),
            extraTags: item.extraTags || []
          }))
        };
        await fsService.writeText(
          await fsService.resolve(INDEX_PATH),
          JSON.stringify(indexData, null, 2),
          undefined, undefined, WRITE_POLICY
        );
        console.log('geo-core: 题库索引已写入 ' + INDEX_PATH);
      } catch (e) {
        console.error('geo-core: 索引写盘失败（不影响运行）:', e.message);
      }

      return _bankCache;
    }

    // 手动重建索引（供未来调用：题库更新后清除缓存）
    function invalidateBankCache() {
      _bankCache = null;
    }

    function groupInfo(item) {
      const meta = item.meta || {};
      const isChoice = item.options && item.options.length > 0;
      const typeLabel = isChoice ? '选择题' : '综合题';
      const nums = String(meta.question_numbers || '').replace(/,/g, '-');
      const label = `${meta.year || ''}${meta.region || ''}卷 ${typeLabel} · 第${nums}题`;
      return { year: meta.year || '', region: meta.region || '', questionNumbers: nums, typeLabel, label };
    }

    const api = {
      // 重建题库索引（题库更新后调用，清除内存缓存 + 磁盘索引）
      invalidateBankCache,

      async getTaxonomyTree() {
        try {
          const configDir = await fsService.resolve(KNOWLEDGE_BASE_PATH);
          const entries = await fsService.listDir(configDir);
          let allNodes = [];
          for (const entry of entries) {
            if (entry.name && entry.name.endsWith('.yaml')) {
              const target = entry.target || entry;
              const text = await fsService.readText(target);
              allNodes = allNodes.concat(parseTaxonomyNodes(text));
            }
          }
          const nodeMap = new Map();
          allNodes.forEach(n => nodeMap.set(n.id, { ...n, children: [] }));
          const roots = [];
          allNodes.forEach(n => {
            if (n.parent_id && nodeMap.has(n.parent_id)) {
              nodeMap.get(n.parent_id).children.push(nodeMap.get(n.id));
            } else if (!n.parent_id) {
              roots.push(nodeMap.get(n.id));
            }
          });
          return roots;
        } catch (e) {
          console.error('geo-core: taxonomy failed', e);
          return [];
        }
      },

      // 重构：searchQuestions 支持结构化查询，统一 score 累加，按小问拆分返回。
      // 兼容旧接口：searchQuestions(knowledgeId, keyword) 仍可用。
      async searchQuestions(queryOrKnowledgeId, maybeKeyword) {
        try {
          // 参数归一化：兼容旧的两个字符串参数
          let region, year, questionNumber, questionType, keyword, knowledgeId;
          if (typeof queryOrKnowledgeId === 'object' && queryOrKnowledgeId !== null) {
            region = queryOrKnowledgeId.region || '';
            year = queryOrKnowledgeId.year ? String(queryOrKnowledgeId.year) : '';
            questionNumber = queryOrKnowledgeId.questionNumber ? String(queryOrKnowledgeId.questionNumber) : '';
            questionType = queryOrKnowledgeId.questionType || '';
            keyword = queryOrKnowledgeId.keyword || '';
            knowledgeId = queryOrKnowledgeId.knowledgeId || '';
          } else {
            knowledgeId = queryOrKnowledgeId || '';
            keyword = maybeKeyword || '';
          }

          const bank = await loadBank();
          const candidates = [];

          for (const item of bank.all) {
            const meta = item.meta || {};
            const kpList = item.knowledgePoints || [];
            let score = 0;

            // 结构化字段：精确匹配，高分
            if (region && (meta.region || '') === region) score += 10;
            if (year && String(meta.year || '') === year) score += 10;
            if (questionNumber && String(meta.question_numbers || '').includes(questionNumber)) score += 10;
            if (questionType && String(meta.question_type || '').includes(questionType)) score += 5;

            // 知识点：匹配 id + 名称 + 领域
            if (knowledgeId) {
              const kMatch = kpList.some(kp =>
                kp.knowledge_unit_id === knowledgeId ||
                kp.knowledgeUnitId === knowledgeId ||
                kp.theme_id === knowledgeId ||
                (kp.knowledge_unit || '').includes(knowledgeId) ||
                (kp.knowledgeUnit || '').includes(knowledgeId) ||
                (kp.domain || '').includes(knowledgeId) ||
                (kp.theme || '').includes(knowledgeId)
              );
              if (kMatch) score += 8;
              // 也搜材料/题干里的文字
              if (item.material.includes(knowledgeId)) score += 3;
              if (item.stem.includes(knowledgeId)) score += 3;
            }

            // 全文关键词：覆盖 material/stem/options/knowledgeUnit/meta
            if (keyword) {
              const kw = keyword;
              if (item.material.includes(kw)) score += 3;
              if (item.stem.includes(kw)) score += 3;
              if ((item.options || []).some(o => o.includes(kw))) score += 2;
              if (kpList.some(kp =>
                (kp.knowledge_unit || '').includes(kw) ||
                (kp.knowledgeUnit || '').includes(kw) ||
                (kp.domain || '').includes(kw) ||
                (kp.theme || '').includes(kw)
              )) score += 3;
              if ((meta.region || '').includes(kw)) score += 5;
              if (String(meta.year || '').includes(kw)) score += 5;
              if (String(meta.question_numbers || '').includes(kw)) score += 5;
              if ((meta.subject || '').includes(kw)) score += 2;
              if ((meta.source_document || '').includes(kw)) score += 2;
            }

            if (score > 0) candidates.push({ item, score });
          }

          // 按 score 降序，去重（同一文件内多题保留最高分的那道代表）
          candidates.sort((a, b) => b.score - a.score);

          // 按小问拆分返回：每道小问独立一条结果
          const seen = new Set();
          const results = [];
          for (const { item, score } of candidates) {
            if (results.length >= 30) break; // 上限
            if (seen.has(item.questionId)) continue;
            seen.add(item.questionId);
            results.push({
              questionId: item.questionId,
              file: item.file,
              group: groupInfo(item),
              stem: item.stem.slice(0, 100),
              knowledgePoints: (item.knowledgePoints || []).map(kp => ({
                role: kp.role,
                knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || ''
              })),
              score
            });
          }
          return results;
        } catch (e) {
          console.error('geo-core: searchQuestions failed', e);
          return [];
        }
      },

      async getQuestionDetail(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const siblings = bank.all.filter(i => i.file === q.file);
          return {
            status: 'success',
            file: q.file,
            group: groupInfo(q),
            material: q.material,
            questions: siblings.map(i => ({
              stem: i.stem,
              options: i.options,
              questionId: i.questionId,
              // 检索详情与 solve 口径一致：不暴露 role/evidence（避免"哪个是核心考点"等解析派生信息）；role 仅在真题分析（geo_analyze）的 examPoints 中返回
              knowledgePoints: (i.knowledgePoints || []).map(kp => ({
                knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || ''
              }))
            }))
          };
        } catch (e) {
          return { status: 'error', message: '获取详情失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 讲题 Solver（P1）：只给题面，绝不含答案/解析 —— 供模型独立解题。
      async questionData(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const siblings = bank.all.filter(i => i.file === q.file);
          return {
            status: 'success',
            questionId: q.questionId,
            file: q.file,
            group: groupInfo(q),
            material: q.material,
            questions: siblings.map(i => ({
              questionId: i.questionId,
              stem: i.stem,
              options: i.options,
              // solve 阶段不给角色/证据（避免暴露"哪个是核心考点"）；完整信息由 judge(answerData) 阶段开放
              knowledgePoints: (i.knowledgePoints || []).map(kp => ({
                knowledgeUnit: kp.knowledge_unit || kp.knowledgeUnit || ''
              }))
            }))
          };
        } catch (e) {
          return { status: 'error', message: '获取题目失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 视觉预处理（V1）：imageRefs(qid) —— 解析该题 md 中所有图片引用为磁盘绝对路径。
      // 返回 [{imageId, caption, sourcePath, rel}]；只含真正的栅格图片（png/jpg/webp/gif）。
      async imageRefs(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };

          // 优先用索引里存的 filePath（不再重新遍历全部文件）
          let mdDiskPath = q.filePath || '';
          let mdText = '';

          if (mdDiskPath) {
            // 从索引的 filePath 直接读文件
            try {
              const target = await fsService.resolve(mdDiskPath);
              mdText = await fsService.readText(target);
            } catch (e) {
              mdDiskPath = ''; // 读失败，降级到遍历
            }
          }

          // 降级：遍历题库找文件（兼容无 filePath 的旧索引）
          if (!mdDiskPath) {
            const bankDir = await fsService.resolve(QUESTION_BANK_PATH);
            const files = [];
            await collectMdFiles(fsService, bankDir, files);
            for (const f of files) {
              try {
                const text = await fsService.readText(f.target);
                if (text && text.indexOf(questionId) >= 0) {
                  mdDiskPath = fsService.processPath(f.target);
                  mdText = text;
                  break;
                }
              } catch (e) { /* skip */ }
            }
          }

          if (!mdDiskPath || !mdText) {
            return { status: 'success', questionId, hasImages: false, images: [], message: '未找到该题所在文件' };
          }
          const refs = extractImageRefs(mdText, mdDiskPath).filter(r => r.image);
          return { status: 'success', questionId, file: (mdDiskPath.split('\\').pop() || ''), hasImages: refs.length > 0, images: refs };
        } catch (e) {
          return { status: 'error', message: '图片引用解析失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 讲题 Solver（P1）：审题骨架——设问类型框架 / 思维模式 / 焦点要素 / 维度扫描。
      // 只提供"怎么想"的骨架；绝不包含从官方解析派生的干扰项错因（那等于泄露答案），
      // 干扰项排除论证由模型独立完成，judge(answerData) 阶段才开放解析对照。
      async solutionScaffold(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const framework = classifyQuestion(q.stem);
          const scans = dimensionScan(q.material || '');
          return {
            status: 'success',
            questionId,
            isChoice: q.options && q.options.length > 0,
            questionFramework: { key: framework.key, name: framework.name, hint: framework.hint },
            thinkingModes: detectLiteracy(q.stem, q.material || ''),
            focusElements: Object.keys(scans).map(k => scans[k].name),
            dimensionScan: scans
          };
        } catch (e) {
          return { status: 'error', message: '骨架生成失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 讲题 Judge（P2）：开放标准答案/解析 + 倒推采分点 + 核验骨架。
      // 仅 judge 阶段使用（需显式授权）；返回内容含答案/解析，不得在 solve 阶段调用。
      async answerData(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const isChoice = q.options && q.options.length > 0;
          return {
            status: 'success',
            questionId,
            isChoice,
            scaffold: buildJudgeScaffold(q, isChoice)
          };
        } catch (e) {
          return { status: 'error', message: '答案/核验骨架获取失败：' + (e && e.message ? e.message : e) };
        }
      },

      // 讲题 Explainer（P3）：同考点变式候选 + 讲题稿重组骨架。
      // 只消费已验证解题过程与同考点情境，不重新解题、不直接拿解析推导讲法。
      async explainerData(questionId, independentAnswer, judge) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const isChoice = q.options && q.options.length > 0;
          const coreKp = (q.knowledgePoints || []).find(kp => kp.role === 'core_exam_point') || (q.knowledgePoints || [])[0] || {};
          const variants = collectSamePointContexts(bank.all, q, coreKp);
          const judgeSummary = judge && judge.scaffold ? judge.scaffold : null;
          const report = buildExplainerReport(q, isChoice, judgeSummary, variants);
          return { status: 'success', questionId, report, variants };
        } catch (e) {
          return { status: 'error', message: '讲题重组失败：' + (e && e.message ? e.message : e) };
        }
      },

      async analyzeQuestion(questionId) {
        try {
          const bank = await loadBank();
          const q = bank.byId.get(questionId);
          if (!q) return { status: 'error', message: `未找到题目：${questionId}` };
          const analysis = buildAnalysis(q, q.material, q.file);
          const blueprint = buildBlueprint(analysis, bank.all, q);
          return { status: 'success', analysis, blueprint };
        } catch (e) {
          return { status: 'error', message: '分析失败：' + (e && e.message ? e.message : e) };
        }
      },

      async exportAnalysis(questionId) {
        try {
          const result = await this.analyzeQuestion(questionId);
          if (result.status !== 'success') return result;
          const md = renderAnalysisMarkdown(result);
          const base = (result.analysis.examPoints[0] && result.analysis.examPoints[0].knowledgeUnit) || questionId;
          const safe = String(base).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
          const fileName = `${safe}__${questionId.replace(/[\\/:*?"<>|]/g, '_')}.md`;
          const target = await fsService.resolve(OUTPUT_PATH + '\\' + fileName);
          await fsService.writeText(target, md, undefined, undefined, WRITE_POLICY);
          return { status: 'success', path: OUTPUT_PATH + '\\' + fileName };
        } catch (e) {
          return { status: 'error', message: '导出失败：' + (e && e.message ? e.message : e) };
        }
      },

      async styleProfile(region, years) {
        try {
          const bank = await loadBank();
          const yearSet = years && years.length ? new Set(years.map(String)) : null;
          const fileGroups = new Map();
          for (const item of bank.all) {
            if (!fileGroups.has(item.file)) {
              const meta = item.meta || {};
              fileGroups.set(item.file, { file: item.file, region: meta.region || '', year: String(meta.year || ''), items: [] });
            }
            fileGroups.get(item.file).items.push(item);
          }
          let candidates = [...fileGroups.values()];
          if (region && region !== 'all' && region !== '') candidates = candidates.filter(g => g.region === region);
          if (yearSet) candidates = candidates.filter(g => yearSet.has(g.year));
          const picked = [];
          const seenRegion = new Set();
          for (const g of candidates) {
            if (picked.length >= 4) break;
            if ((!region || region === 'all' || region === '') && g.region) {
              if (seenRegion.has(g.region)) continue;
              seenRegion.add(g.region);
            }
            picked.push(g);
          }
          if (picked.length === 0 && candidates.length) picked.push(candidates[0]);
          const analyses = [];
          for (const g of picked) {
            for (const item of g.items) {
              analyses.push(buildAnalysis(item, item.material, item.file));
            }
          }
          const dimensions = buildStyleProfile(picked, analyses);
          return {
            status: 'success',
            mode: region && region !== 'all' ? region + '卷独立' : '各省融合',
            source: picked.map(g => ({ region: g.region, year: g.year, file: g.file })),
            dimensions
          };
        } catch (e) {
          return { status: 'error', message: '风格档案生成失败：' + (e && e.message ? e.message : e) };
        }
      },

      async health() {
        try {
          const bank = await loadBank();
          let taxonomyNodes = 0;
          let taxonomyFiles = 0;
          try {
            const configDir = await fsService.resolve(KNOWLEDGE_BASE_PATH);
            const entries = await fsService.listDir(configDir);
            for (const entry of entries) {
              if (entry.name && entry.name.endsWith('.yaml')) {
                const target = entry.target || entry;
                const text = await fsService.readText(target);
                taxonomyNodes += parseTaxonomyNodes(text).length;
                taxonomyFiles += 1;
              }
            }
          } catch (e) {
            console.error('geo-core: health taxonomy scan failed', e);
            taxonomyNodes = -1;
          }
          return {
            status: 'success',
            taxonomyFiles,
            taxonomyNodes,
            bankFiles: bank.filesCount,
            bankQuestions: bank.all.length,
            indexBuiltAt: bank.builtAt || null,
            indexFromDisk: !!bank.fromIndex
          };
        } catch (e) {
          return { status: 'error', message: '健康检查失败：' + (e && e.message ? e.message : e) };
        }
      }
    };

    webServer.register({
      kind: 'exact',
      path: '/geo/core/health',
      handler: async (req, res) => {
        try {
          const data = await api.health();
          const body = JSON.stringify(data);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          res.end(body);
        } catch (e) {
          const body = JSON.stringify({ status: 'error', message: String((e && e.message) || e) });
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
          res.end(body);
        }
      }
    });

    ctx.provide('geoKernel', api);
    console.log('geo-core: geo.kernel 服务已注册');
  }
};
