// GeoTeacher Agent — 持久化标准 Cordis 插件（Host 侧）
// 提供：/geo-teacher 面板页面 + /geo-teacher/api/* JSON 接口
// 数据：考点库（config/*.yaml）、真题库（obsidian_vault/04_题目，动态增长）
// 出题 skill 由 preset 的 skills/ 目录经 skill-filesystem 自动发现，无需本插件注册。

const KNOWLEDGE_BASE_PATH = 'E:/知识图谱/config';
const QUESTION_BANK_PATH = 'E:/知识图谱/obsidian_vault/04_题目';
const OUTPUT_PATH = 'E:/geo_edu_agent/outputs';

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
      out.push({ name, target: childTarget });
    }
  }
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
    if (/^!\[/.test(t)) continue;
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

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;

    const qid = t.match(/^question_id:\s*`?([^`]+)`?\s*$/);
    if (qid) { questionId = qid[1].trim(); continue; }
    const qid2 = t.match(/^question_id:\s*"([^"]+)"\s*$/);
    if (qid2) { questionId = qid2[1].trim(); continue; }

    const stemMark = t.match(/^\*\*(题干|小问)\*\*[：:]\s*(.*)$/);
    if (stemMark) {
      phase = 'stem';
      const inline = stemMark[1].trim();
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

// ========== 页面路径（相对本模块） ==========
const PAGE_PATH = decodeURIComponent(new URL('./page.html', import.meta.url).pathname).replace(/^\/+/, '');

// ========== HTTP 辅助 ==========
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function parseQuery(url) {
  const q = url.indexOf('?');
  const out = {};
  if (q >= 0) {
    for (const pair of url.slice(q + 1).split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq < 0) out[decodeURIComponent(pair)] = '';
      else out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

export default {
  name: 'geo-teacher-agent',
  inject: ['fs', 'webServer'],
  apply(ctx) {
    const fsService = ctx.fs;
    const webServer = ctx.webServer;

    async function loadBank() {
      const bankDir = await fsService.resolve(QUESTION_BANK_PATH);
      const files = [];
      await collectMdFiles(fsService, bankDir, files);
      const byId = new Map();
      const all = [];
      for (const f of files) {
        const content = await fsService.readText(f.target);
        const meta = parseFrontmatter(content);
        const parsed = parseQuestionFileFull(content);
        for (const q of parsed.questions) {
          const item = { ...q, file: f.name, material: parsed.material, meta };
          byId.set(q.questionId, item);
          all.push(item);
        }
      }
      return { byId, all };
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
      async taxonomy() {
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
          console.error('geo-teacher: taxonomy failed', e);
          return [];
        }
      },

      async questions(kp, keyword) {
        try {
          const bank = await loadBank();
          const results = [];
          const seen = new Set();
          for (const item of bank.all) {
            const matched = kp
              ? item.material.includes(kp) || item.stem.includes(kp) ||
                (item.knowledgePoints || []).some(kp2 => (kp2.knowledge_unit_id === kp || kp2.knowledgeUnitId === kp || kp2.theme_id === kp))
              : (keyword && (item.material.includes(keyword) || item.stem.includes(keyword)));
            if (matched && !seen.has(item.file)) {
              seen.add(item.file);
              results.push({
                file: item.file,
                group: groupInfo(item),
                questionIds: bank.all.filter(i => i.file === item.file).map(i => i.questionId)
              });
            }
          }
          return results;
        } catch (e) {
          console.error('geo-teacher: questions failed', e);
          return [];
        }
      },

      async detail(questionId) {
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
            questions: siblings.map(i => ({ stem: i.stem, options: i.options, questionId: i.questionId }))
          };
        } catch (e) {
          return { status: 'error', message: '获取详情失败：' + (e && e.message ? e.message : e) };
        }
      },

      async analyze(questionId) {
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
          const result = await this.analyze(questionId);
          if (result.status !== 'success') return result;
          const md = renderAnalysisMarkdown(result);
          const base = (result.analysis.examPoints[0] && result.analysis.examPoints[0].knowledgeUnit) || questionId;
          const safe = String(base).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
          const fileName = `${safe}__${questionId.replace(/[\\/:*?"<>|]/g, '_')}.md`;
          const target = await fsService.resolve(OUTPUT_PATH + '\\' + fileName);
          await fsService.writeText(target, md);
          return { status: 'success', path: OUTPUT_PATH + '\\' + fileName };
        } catch (e) {
          return { status: 'error', message: '导出失败：' + (e && e.message ? e.message : e) };
        }
      }
    };

    // 面板页面
    webServer.register({
      kind: 'exact',
      path: '/geo-teacher',
      handler: (req, res) => {
        fsService.resolve(PAGE_PATH)
          .then(target => fsService.readText(target))
          .then(html => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html || '<h1>geo-teacher: page not found</h1>');
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('geo-teacher: failed to load page');
          });
      }
    });

    // JSON API
    webServer.register({
      kind: 'prefix',
      path: '/geo-teacher/api',
      handler: async (req, res) => {
        try {
          const pathname = (req.url || '/').split('?')[0];
          const query = parseQuery(req.url || '/');
          const action = pathname.replace(/^\/geo-teacher\/api\/?/, '') || 'index';
          switch (action) {
            case 'taxonomy': return sendJson(res, 200, await api.taxonomy());
            case 'questions': return sendJson(res, 200, await api.questions(query.kp || '', query.keyword || ''));
            case 'detail': return sendJson(res, 200, await api.detail(query.qid || ''));
            case 'analyze': return sendJson(res, 200, await api.analyze(query.qid || ''));
            case 'export': return sendJson(res, 200, await api.exportAnalysis(query.qid || ''));
            default: return sendJson(res, 404, { status: 'error', message: 'unknown action: ' + action });
          }
        } catch (e) {
          sendJson(res, 500, { status: 'error', message: String((e && e.message) || e) });
        }
      }
    });

    console.log('geo-teacher-agent: /geo-teacher 面板已注册');
  }
};
