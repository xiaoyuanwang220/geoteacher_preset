// GeoTeacher Agent — Client 端
// 侧边栏入口按钮（sidebar.footer.action）+ 浮层考点树面板（shell.overlay）
// 三级视图：考点树 → 题目索引列表（题型+卷别题号）→ 单题组详情 → 真题分析/命题蓝图

const { useState, useEffect } = React;

// ===== 共享面板状态（apply 闭包内创建）=====
function createPanelState() {
  const state = { open: false };
  const listeners = new Set();
  return {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    toggle() { state.open = !state.open; listeners.forEach(fn => fn()); },
    close() { state.open = false; listeners.forEach(fn => fn()); }
  };
}

// ===== 设置 → 插件 区的插件卡片 =====
function GeoTeacherPluginCard() {
  return React.createElement('div', { className: 'geo-plugin-card' },
    React.createElement('div', { className: 'geo-plugin-card-head' },
      React.createElement('div', null,
        React.createElement('div', { className: 'geo-plugin-card-name' }, '\uD83D\uDDFA\uFE0F 地理教师辅助 Agent'),
        React.createElement('div', { className: 'geo-plugin-card-id' }, 'geotea-2 · geo-teacher-agent')
      ),
      React.createElement('span', { className: 'geo-plugin-badge' }, '\u25CF 运行中')
    ),
    React.createElement('div', { className: 'geo-plugin-card-desc' },
      '高中地理教师辅助工具：三级考点树浏览、真题索引与题组详情、真题分析（为什么这样考）、命题蓝图（下一道题怎么设计）、真题风格出题（五段式）。数据源：本地真题库 obsidian_vault/04_题目（动态增长）+ taxonomy 考点库。'
    ),
    React.createElement('div', { className: 'geo-plugin-card-foot' },
      '面板入口：左侧边栏底部 \uD83D\uDDFA\uFE0F 地理考点 ｜ 出题：对话中直接说“出几道题”'
    )
  );
}

// ===== 侧边栏底部入口按钮 =====
function GeoTeacherEntry(props) {
  const [open, setOpen] = useState(props.state.open);
  useEffect(() => props.subscribe(() => setOpen(props.state.open)), []);
  return React.createElement('button', {
    onClick: props.toggle,
    title: '地理考点库',
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      gap: '6px', width: '100%',
      padding: props.wide ? '8px 12px' : '8px 0',
      background: open ? 'var(--dsw-alias-brand-primary)' : 'transparent',
      color: open ? '#ffffff' : 'var(--dsw-alias-label-secondary)',
      border: 'none', borderRadius: '6px', cursor: 'pointer',
      fontSize: '13px', whiteSpace: 'nowrap', boxSizing: 'border-box'
    }
  },
    React.createElement('span', { style: { fontSize: '15px' } }, '\uD83D\uDDFA\uFE0F'),
    props.wide ? React.createElement('span', null, '地理考点') : null
  );
}

// ===== 浮层考点树面板 =====
function GeoTeacherPanel(props) {
  const [open, setOpen] = useState(props.state.open);
  useEffect(() => props.subscribe(() => setOpen(props.state.open)), []);

  const [taxonomy, setTaxonomy] = useState([]);
  const [view, setView] = useState('tree');           // 'tree' | 'list' | 'detail'
  const [selectedName, setSelectedName] = useState('');
  const [indexList, setIndexList] = useState([]);      // 题目索引列表
  const [detail, setDetail] = useState(null);          // 单题组详情
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 分析 / 蓝图状态
  const [analyzeResult, setAnalyzeResult] = useState(null);
  const [analyzingId, setAnalyzingId] = useState(null);
  const [analyzedId, setAnalyzedId] = useState(null);
  const [tab, setTab] = useState('analysis');
  const [exportInfo, setExportInfo] = useState(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open && !loaded) {
      loadTaxonomy();
      setLoaded(true);
    }
  }, [open]);

  const loadTaxonomy = async () => {
    setLoading(true);
    try {
      const data = await host.call('geo.getTaxonomy');
      setTaxonomy(data || []);
    } catch (e) {
      console.error('loadTaxonomy failed:', e);
    }
    setLoading(false);
  };

  // 点击考点节点 → 显示题目索引列表
  const handleSelectNode = async (nodeId, nodeName) => {
    setSelectedName(nodeName);
    setDetail(null);
    setAnalyzeResult(null);
    setAnalyzedId(null);
    setExportInfo(null);
    setView('list');
    setLoading(true);
    try {
      const data = await host.call('geo.searchQuestions', { knowledgeId: nodeId });
      setIndexList(data || []);
    } catch (e) {
      console.error('searchQuestions failed:', e);
    }
    setLoading(false);
  };

  // 点击索引条目 → 加载该题组详情
  const handleOpenDetail = async (questionId) => {
    setDetail(null);
    setAnalyzeResult(null);
    setAnalyzedId(null);
    setExportInfo(null);
    setView('detail');
    setLoading(true);
    try {
      const data = await host.call('geo.getQuestionDetail', { questionId });
      setDetail(data);
    } catch (e) {
      console.error('getQuestionDetail failed:', e);
    }
    setLoading(false);
  };

  // 真题分析 + 命题蓝图
  const handleAnalyze = async (questionId) => {
    setAnalyzingId(questionId);
    setAnalyzeResult(null);
    setExportInfo(null);
    setTab('analysis');
    try {
      const data = await host.call('geo.analyzeQuestion', { questionId });
      setAnalyzeResult(data);
      setAnalyzedId(questionId);
    } catch (e) {
      console.error('analyzeQuestion failed:', e);
    }
    setAnalyzingId(null);
  };

  // 导出 Markdown
  const handleExport = async () => {
    if (!analyzedId) return;
    setExporting(true);
    setExportInfo(null);
    try {
      const data = await host.call('geo.exportAnalysis', { questionId: analyzedId });
      setExportInfo(data);
    } catch (e) {
      console.error('exportAnalysis failed:', e);
    }
    setExporting(false);
  };

  const renderTree = (nodes, level = 0) => {
    return React.createElement('ul', { className: 'geo-tree' },
      nodes.map(node =>
        React.createElement('li', { key: node.id },
          React.createElement('div', {
            className: 'geo-node',
            style: { paddingLeft: 6 + level * 14 },
            onClick: () => handleSelectNode(node.id, node.name)
          },
            `${node.level === 'domain' ? '▣' : node.level === 'theme' ? '▤' : '▪'} ${node.name}`
          ),
          node.children && node.children.length > 0 ? renderTree(node.children, level + 1) : null
        )
      )
    );
  };

  // 题目索引列表视图（只显示 题型 + 卷别题号）
  const renderIndexList = () => {
    return React.createElement('div', null,
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
        React.createElement('button', { className: 'geo-back', onClick: () => setView('tree') }, '\u2190 返回考点'),
        React.createElement('span', { style: { fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, selectedName)
      ),
      React.createElement('div', { className: 'geo-hint', style: { marginBottom: '8px' } }, `共 ${indexList.length} 个题组，点击查看题目`),
      indexList.length === 0 && !loading
        ? React.createElement('div', { className: 'geo-hint' }, '未找到关联真题')
        : indexList.map((item, idx) =>
            React.createElement('div', {
              key: idx,
              className: 'geo-index',
              onClick: () => handleOpenDetail(item.questionIds[0])
            },
              React.createElement('span', {
                className: item.group.typeLabel === '选择题' ? 'geo-badge choice' : 'geo-badge comp'
              }, item.group.typeLabel),
              React.createElement('span', { className: 'geo-index-label' }, item.group.label),
              React.createElement('span', { className: 'geo-index-arrow' }, '\u203A')
            )
          )
    );
  };

  // 单题组详情视图
  const renderQuestionItem = (question, qi) => {
    return React.createElement('div', { key: qi, className: 'geo-qitem' },
      React.createElement('div', { className: 'geo-stem' }, question.stem),
      (question.options || []).map((opt, oi) =>
        React.createElement('div', { key: oi, className: 'geo-option' }, opt)
      ),
      React.createElement('div', { className: 'geo-qactions' },
        React.createElement('button', {
          className: 'geo-mini',
          disabled: analyzingId === question.questionId,
          onClick: () => handleAnalyze(question.questionId)
        }, analyzingId === question.questionId ? '分析中...' : '\uD83D\uDD0D 为什么这样考 · 命题蓝图')
      )
    );
  };

  const renderDetailView = () => {
    if (loading && !detail) return React.createElement('div', { className: 'geo-hint' }, '加载中...');
    if (!detail || detail.status !== 'success') {
      return React.createElement('div', null,
        React.createElement('button', { className: 'geo-back', onClick: () => setView('list') }, '\u2190 返回列表'),
        React.createElement('div', { className: 'geo-hint', style: { marginTop: '8px' } }, (detail && detail.message) || '加载失败')
      );
    }
    return React.createElement('div', null,
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
        React.createElement('button', { className: 'geo-back', onClick: () => setView('list') }, '\u2190 返回'),
        React.createElement('span', { style: { fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail.group.label)
      ),
      React.createElement('div', { className: 'geo-file' }, detail.file),
      detail.material
        ? React.createElement('div', { className: 'geo-material' }, detail.material)
        : null,
      (detail.questions || []).map((question, qi) => renderQuestionItem(question, qi)),
      renderAnalyzeResult()
    );
  };

  // 分析卡（为什么这样考）
  const renderAnalysis = (a) => {
    return React.createElement('div', null,
      React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '\u2460 考什么'),
      (a.examPoints || []).map((kp, i) =>
        React.createElement('div', { key: i, className: 'geo-kp' },
          React.createElement('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-brand-primary)' } }, `[${kp.role}] 权重 ${kp.weight}`),
          React.createElement('div', null, `${kp.domain} → ${kp.theme} → ${kp.knowledgeUnit}`),
          kp.evidence ? React.createElement('div', { className: 'geo-hint' }, `证据：${kp.evidence}`) : null
        )
      ),
      React.createElement('div', { style: { fontWeight: 600, margin: '10px 0 6px' } }, '\u2461 怎么考'),
      React.createElement('div', { className: 'geo-fact' }, `题型：${a.questionType}　|　设问：${a.stemMode}`),
      React.createElement('div', { className: 'geo-fact' }, `情境类型：${(a.contextTypes || []).join('、')}`),
      React.createElement('div', { style: { fontWeight: 600, margin: '10px 0 6px' } }, '\u2462 为什么这样考'),
      React.createElement('div', { className: 'geo-fact' }, `素养立意：${(a.literacy || []).join('、')}`),
      React.createElement('div', { className: 'geo-fact' }, `能力层次：${a.abilityLevel}　|　难度定位：${a.difficulty}`),
      (a.distractors || []).length > 0
        ? React.createElement('div', null,
            React.createElement('div', { className: 'geo-hint', style: { margin: '6px 0 2px' } }, '干扰项设计逻辑（规则提取）：'),
            a.distractors.map((d, i) =>
              React.createElement('div', { key: i, className: 'geo-hint' }, `· ${d.option}：${d.reason}`)
            )
          )
        : null,
      (a.extraTags || []).length > 0
        ? React.createElement('div', { className: 'geo-hint', style: { marginTop: '6px' } }, `情境标签：${a.extraTags.join('、')}`)
        : null
    );
  };

  // 蓝图卡（下一道题怎么设计）
  const renderBlueprint = (b) => {
    return React.createElement('div', null,
      React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '\u2460 考点锁定'),
      React.createElement('div', { className: 'geo-fact' }, `${b.corePoint.domain} → ${b.corePoint.theme} → ${b.corePoint.knowledgeUnit}（权重 ${b.corePoint.weight}）`),
      React.createElement('div', { style: { fontWeight: 600, margin: '10px 0 6px' } }, '\u2461 情境换新'),
      React.createElement('div', { className: 'geo-fact' }, b.contextSuggestion),
      (b.alternativeContexts || []).length > 0
        ? React.createElement('div', null,
            React.createElement('div', { className: 'geo-hint', style: { margin: '6px 0 2px' } }, '同考点可参考情境：'),
            b.alternativeContexts.slice(0, 5).map((alt, i) =>
              React.createElement('div', { key: i, className: 'geo-hint' }, `· ${alt.file}：材料「${alt.material}」设问「${alt.stem}」`)
            )
          )
        : null,
      React.createElement('div', { style: { fontWeight: 600, margin: '10px 0 6px' } }, '\u2462 设问设计'),
      React.createElement('div', { className: 'geo-fact' }, `保留角度（仿写）：${b.stemTemplate}`),
      React.createElement('div', { className: 'geo-fact' }, `换角度（迁移）：${b.alternativeAngle}`),
      b.optionDesign
        ? React.createElement('div', null,
            React.createElement('div', { style: { fontWeight: 600, margin: '10px 0 6px' } }, '\u2463 选项设计（选择题）'),
            React.createElement('div', { className: 'geo-fact' }, `正确项：${b.optionDesign.correct}`),
            React.createElement('div', { className: 'geo-hint', style: { margin: '4px 0 2px' } }, '干扰项：'),
            b.optionDesign.distractors.map((d, i) =>
              React.createElement('div', { key: i, className: 'geo-hint' }, `· ${d}`)
            )
          )
        : null,
      React.createElement('div', { style: { fontWeight: 600, margin: '10px 0 6px' } }, '\u2464 素养与难度目标'),
      React.createElement('div', { className: 'geo-fact' }, `素养：${(b.literacy || []).join('、')}　|　难度：${b.difficulty}`)
    );
  };

  // 分析结果区（双 tab + 导出）
  const renderAnalyzeResult = () => {
    if (!analyzeResult) return null;
    if (analyzeResult.status !== 'success') {
      return React.createElement('div', { className: 'geo-design' },
        React.createElement('div', { className: 'geo-hint' }, analyzeResult.message || '分析失败')
      );
    }
    const { analysis, blueprint } = analyzeResult;
    return React.createElement('div', { className: 'geo-design' },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' } },
        React.createElement('button', {
          className: tab === 'analysis' ? 'geo-tab active' : 'geo-tab',
          onClick: () => setTab('analysis')
        }, '真题分析'),
        React.createElement('button', {
          className: tab === 'blueprint' ? 'geo-tab active' : 'geo-tab',
          onClick: () => setTab('blueprint')
        }, '命题蓝图'),
        React.createElement('button', {
          className: 'geo-mini',
          style: { marginLeft: 'auto' },
          disabled: exporting,
          onClick: handleExport
        }, exporting ? '导出中...' : '\u2B07 导出 Markdown')
      ),
      tab === 'analysis' ? renderAnalysis(analysis) : renderBlueprint(blueprint),
      exportInfo
        ? React.createElement('div', { className: 'geo-hint', style: { marginTop: '8px', wordBreak: 'break-all' } },
            exportInfo.status === 'success' ? `已导出：${exportInfo.path}` : exportInfo.message)
        : null
    );
  };

  if (!open) return null;

  return React.createElement('div', { className: 'geo-panel' },
    React.createElement('div', { className: 'geo-panel-header' },
      React.createElement('span', { className: 'geo-panel-title' }, '地理考点库'),
      React.createElement('button', { className: 'geo-panel-close', onClick: props.close, title: '关闭' }, '\u2715')
    ),
    React.createElement('div', { className: 'geo-panel-body' },
      view === 'tree'
        ? React.createElement('div', null,
            React.createElement('p', { className: 'geo-hint' }, '点击考点节点查看关联真题'),
            taxonomy.length > 0
              ? renderTree(taxonomy)
              : React.createElement('div', { className: 'geo-hint' }, '暂无考点数据')
          )
        : view === 'list'
          ? renderIndexList()
          : renderDetailView()
    )
  );
}

return {
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    const panel = createPanelState();

    // 包样式（使用主题 CSS 变量，适配明暗主题）
    styles.insert(`
.geo-panel {
  position: fixed; left: 250px; top: 16px; bottom: 16px; width: 420px;
  max-width: calc(100vw - 270px);
  background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  display: flex; flex-direction: column; overflow: hidden;
  pointer-events: auto; z-index: 900; font-size: 13px;
}
.geo-panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-shrink: 0;
}
.geo-panel-title { font-weight: 600; font-size: 14px; }
.geo-panel-close {
  background: transparent; border: none; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 14px;
  padding: 2px 8px; border-radius: 4px;
}
.geo-panel-close:hover { background: var(--dsw-alias-border-l1); }
.geo-panel-body { flex: 1; overflow-y: auto; padding: 12px 14px; }
.geo-tree { list-style: none; padding-left: 0; margin: 4px 0; }
.geo-tree ul { list-style: none; padding-left: 0; margin: 0; }
.geo-node {
  cursor: pointer; padding: 3px 6px; border-radius: 4px; margin: 2px 0;
  color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.geo-node:hover { background: var(--dsw-alias-border-l1); }
.geo-index {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; margin-bottom: 6px; cursor: pointer;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
}
.geo-index:hover { border-color: var(--dsw-alias-brand-primary); }
.geo-index-label { flex: 1; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.geo-index-arrow { color: var(--dsw-alias-label-secondary); font-size: 16px; }
.geo-badge {
  flex-shrink: 0; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;
}
.geo-badge.choice { background: var(--dsw-alias-brand-primary); color: #ffffff; }
.geo-badge.comp { background: var(--dsw-alias-state-warn-primary); color: #ffffff; }
.geo-back {
  background: transparent; border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  padding: 3px 10px; border-radius: 6px; font-size: 12px; flex-shrink: 0;
}
.geo-back:hover { background: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.geo-file { font-weight: 600; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 6px; }
.geo-material { white-space: pre-wrap; line-height: 1.6; margin-bottom: 8px; color: var(--dsw-alias-label-primary); }
.geo-qitem { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1); }
.geo-stem { font-weight: 600; line-height: 1.6; margin-bottom: 4px; }
.geo-option { padding-left: 14px; line-height: 1.6; }
.geo-qactions { margin-top: 6px; }
.geo-mini {
  background: transparent; border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  padding: 4px 10px; border-radius: 6px; font-size: 12px;
}
.geo-mini:hover { background: var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.geo-mini:disabled { opacity: 0.6; cursor: default; }
.geo-kp {
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px; padding: 6px 8px; margin-bottom: 6px;
}
.geo-fact { line-height: 1.6; margin-bottom: 2px; }
.geo-tab {
  background: transparent; border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); cursor: pointer;
  padding: 4px 12px; border-radius: 6px; font-size: 12px;
}
.geo-tab.active { background: var(--dsw-alias-brand-primary); color: #ffffff; border-color: var(--dsw-alias-brand-primary); }
.geo-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.geo-design {
  margin-top: 12px; padding: 10px 12px; border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1);
}
.geo-plugin-card {
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; margin: 4px 0;
}
.geo-plugin-card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px;
}
.geo-plugin-card-name { font-weight: 700; font-size: 14px; }
.geo-plugin-card-id { font-size: 11px; color: var(--dsw-alias-label-secondary); margin-top: 2px; }
.geo-plugin-badge {
  flex-shrink: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-state-success-primary);
}
.geo-plugin-card-desc { font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-primary); }
.geo-plugin-card-foot {
  margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l1);
  font-size: 11px; color: var(--dsw-alias-label-secondary);
}
`);

    // 侧边栏底部入口按钮（additive，不替换产品 UI）
    slots.inject('sidebar.footer.action', () => {
      slots.register(
        { name: 'sidebar.footer.action', id: 'geo-teacher-entry', label: '地理考点' },
        (props) => React.createElement(GeoTeacherEntry, {
          ...props,
          state: panel.state,
          subscribe: panel.subscribe,
          toggle: panel.toggle
        })
      );
    });

    // 设置 → 插件 区的插件卡片（additive，可被搜索到）
    slots.inject('settings.plugin.item', () => {
      slots.register(
        { name: 'settings.plugin.item', id: 'geo-teacher', order: 30, label: '地理教师辅助' },
        () => React.createElement(GeoTeacherPluginCard)
      );
    });

    // 浮层考点树面板
    slots.inject('shell.overlay', () => {
      slots.register(
        { name: 'shell.overlay', id: 'geo-teacher-panel' },
        (props) => React.createElement(GeoTeacherPanel, {
          ...props,
          state: panel.state,
          subscribe: panel.subscribe,
          close: panel.close
        })
      );
    });
  }
};
