const fs = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');

const KNOWLEDGE_BASE_PATH = 'E:\\知识图谱\\config';
const QUESTION_BANK_PATH = 'E:\\知识图谱\\processed\\legacy\\2025-广东-old-mapped';

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
  
  // 调用教学模型生成 (这里模拟调用)
  async generateTeachingModel(topic) {
    // 实际应调用 geo-teaching-model skill 的逻辑或生成请求
    return { status: 'success', modelUrl: `/models/${encodeURIComponent(topic)}.html`, message: `已为“${topic}”生成教学模型设计请求。` };
  }
};

return {
  apply(ctx) {
    // 注册 Host 服务
    ctx.provide('geoTeacher', geoTeacherService);
    
    // 注册 RPC 接口供 Client 调用
    ctx.on('rpc.geo.getTaxonomy', async () => ctx.geoTeacher.getTaxonomyTree());
    ctx.on('rpc.geo.searchQuestions', async (params) => ctx.geoTeacher.searchQuestions(params.knowledgeId, params.keyword));
    ctx.on('rpc.geo.generateModel', async (params) => ctx.geoTeacher.generateTeachingModel(params.topic));
  }
};
