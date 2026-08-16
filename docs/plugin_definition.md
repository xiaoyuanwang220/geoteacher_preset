# GeoTeacher Agent Plugin Definition

## Plugin ID
geotea

## Purpose
构建高中地理教师辅助 Agent，集成考点管理、智能出题和教学设计功能。

## Host Code
```javascript
const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

const KNOWLEDGE_BASE_PATH = 'E:\\知识图谱\\config';
const QUESTION_BANK_PATH = 'E:\\知识图谱\\obsidian_vault\\04_题目';

// 定义 Host 服务方法
const geoTeacherService = {
  // 获取考点树
  async getTaxonomyTree() {
    try {
      const files = await fs.readdir(KNOWLEDGE_BASE_PATH);
      const yamlFiles = files.filter(f => f.endsWith('.yaml'));
      let allNodes = [];
      
      for (const file of yamlFiles) {
        const content = await fs.readFile(path.join(KNOWLEDGE_BASE_PATH, file), 'utf8');
        const data = yaml.load(content);
        if (data && data.nodes) {
          allNodes = allNodes.concat(data.nodes);
        }
      }
      
      // 构建树结构
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
      console.error('Failed to load taxonomy:', e);
      return [];
    }
  },
  
  // 搜索题目
  async searchQuestions(knowledgeId, keyword) {
    try {
      const files = await fs.readdir(QUESTION_BANK_PATH);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      const results = [];
      
      for (const file of mdFiles) {
        const content = await fs.readFile(path.join(QUESTION_BANK_PATH, file), 'utf8');
        // 简单匹配知识点 ID 或关键词
        if (knowledgeId && content.includes(knowledgeId)) {
          results.push({ file, content: content.substring(0, 500) + '...' });
        } else if (keyword && content.includes(keyword)) {
          results.push({ file, content: content.substring(0, 500) + '...' });
        }
      }
      return results;
    } catch (e) {
      console.error('Failed to search questions:', e);
      return [];
    }
  },
  
  // 生成教学设计 (基于考点和题目)
  async generateTeachingDesign(knowledgeId, topic) {
    try {
      // 获取相关考点信息
      const taxonomy = await this.getTaxonomyTree();
      let targetNode = null;
      
      const findNode = (nodes, id) => {
        for (const node of nodes) {
          if (node.id === id) return node;
          if (node.children) {
            const found = findNode(node.children, id);
            if (found) return found;
          }
        }
        return null;
      };
      
      targetNode = findNode(taxonomy, knowledgeId);
      
      // 获取相关题目
      const questions = await this.searchQuestions(knowledgeId, topic);
      
      return {
        status: 'success',
        design: {
          topic: topic || (targetNode ? targetNode.name : '未知主题'),
          knowledgePoint: targetNode,
          relatedQuestions: questions.slice(0, 5), // 最多5道相关题
          teachingSuggestions: [
            '建议结合实际案例讲解',
            '可通过图表辅助说明',
            '注意学生易错点分析'
          ]
        }
      };
    } catch (e) {
      console.error('Failed to generate teaching design:', e);
      return { status: 'error', message: '生成教学设计失败' };
    }
  }
};

return {
  apply(ctx) {
    // 注册 Host 服务
    ctx.provide('geoTeacher', geoTeacherService);
    
    // 注册 RPC 接口供 Client 调用
    ctx.on('rpc.geo.getTaxonomy', async () => ctx.geoTeacher.getTaxonomyTree());
    ctx.on('rpc.geo.searchQuestions', async (params) => ctx.geoTeacher.searchQuestions(params.knowledgeId, params.keyword));
    ctx.on('rpc.geo.generateDesign', async (params) => ctx.geoTeacher.generateTeachingDesign(params.knowledgeId, params.topic));
  }
};
```

## Client Code
```javascript
const { useState, useEffect } = React;

function GeoTeacherPanel() {
  const [taxonomy, setTaxonomy] = useState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchResult, setSearchResult] = useState([]);
  const [loading, setLoading] = useState(false);
  const [teachingDesign, setTeachingDesign] = useState(null);

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

  const handleGenerateDesign = async () => {
    if (!selectedNode) return;
    setLoading(true);
    const data = await ctx.call('rpc.geo.generateDesign', { 
      knowledgeId: selectedNode, 
      topic: selectedNode 
    });
    setTeachingDesign(data);
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
      ),
      React.createElement('button', { 
        onClick: handleGenerateDesign,
        style: { marginTop: '10px', padding: '8px 16px', backgroundColor: '#52c41a', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }
      }, '生成教学设计')
    ) : null,
    teachingDesign ? React.createElement('div', { style: { marginTop: '20px', padding: '10px', background: '#e6f7ff', borderRadius: '4px' } },
      React.createElement('h4', null, '教学设计建议'),
      React.createElement('p', null, `主题: ${teachingDesign.design?.topic || '未知'}`),
      React.createElement('ul', null, 
        teachingDesign.design?.teachingSuggestions?.map((suggestion, idx) => 
          React.createElement('li', { key: idx }, suggestion)
        )
      )
    ) : null
  );
}

return {
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) return;
    
    // 注册设置页面 UI
    slots.inject('settings.section', () => {
      slots.register({ name: 'settings.section', key: 'geo-teacher-settings' }, () => {
        return React.createElement(GeoTeacherPanel);
      });
    });
  }
};
```

## Usage
Use `cordis_define` tool with:
- plugin: {"kind": "new", "idPrefix": "geotea"}
- name: "geo-teacher-agent"
- purpose: "构建高中地理教师辅助 Agent，集成考点管理、智能出题和教学设计功能。"
- code: {"host": "(Host code above)", "client": "(Client code above)"}
