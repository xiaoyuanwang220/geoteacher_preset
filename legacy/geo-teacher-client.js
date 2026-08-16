const { useState, useEffect } = React;

function GeoTeacherPanel() {
  const [taxonomy, setTaxonomy] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchResult, setSearchResult] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadTaxonomy();
  }, []);

  const loadTaxonomy = async () => {
    setLoading(true);
    const data = await ctx.call('rpc.geo.getTaxonomy');
    setTaxonomy(data || []);
    setLoading(false);
  };

  const handleSearch = async (nodeId) => {
    setLoading(true);
    setSelectedNode(nodeId);
    const data = await ctx.call('rpc.geo.searchQuestions', { knowledgeId: nodeId });
    setSearchResult(data || []);
    setLoading(false);
  };

  const renderTree = (nodes, level = 0) => {
    return React.createElement('ul', { style: { paddingLeft: level > 0 ? '15px' : '0' } }, 
      nodes.map(node => 
        React.createElement('li', { key: node.id, style: { margin: '4px 0' } },
          React.createElement('div', { 
            style: { cursor: 'pointer', color: selectedNode === node.id ? '#1890ff' : '#333', fontWeight: selectedNode === node.id ? 'bold' : 'normal' },
            onClick: () => handleSearch(node.id)
          }, node.name),
          node.children && node.children.length > 0 ? renderTree(node.children, level + 1) : null
        )
      )
    );
  };

  return React.createElement('div', { style: { padding: '10px', height: '100%', overflowY: 'auto' } },
    React.createElement('h3', null, '地理考点库'),
    loading ? React.createElement('div', null, '加载中...') : null,
    React.createElement('div', { style: { marginBottom: '20px' } },
      taxonomy.length > 0 ? renderTree(taxonomy) : React.createElement('div', null, '暂无考点数据')
    ),
    selectedNode ? React.createElement('div', null,
      React.createElement('h4', null, `关联真题 (共${searchResult.length}道)`),
      searchResult.map((q, idx) => 
        React.createElement('div', { key: idx, style: { background: '#f5f5f5', padding: '8px', marginBottom: '8px', borderRadius: '4px' } },
          React.createElement('div', { style: { fontWeight: 'bold' } }, q.file),
          React.createElement('div', { style: { fontSize: '12px', color: '#666' } }, q.content)
        )
      )
    ) : null
  );
}

return {
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    
    // 注册侧边栏 UI
    slots.inject('sidebar', () => {
      slots.register({ name: 'sidebar', key: 'geo-teacher-panel' }, () => {
        return React.createElement(GeoTeacherPanel);
      });
    });
  }
};
