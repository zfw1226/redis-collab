/**
 * Redis-Collab 公共工具函数 (ESM)
 */

// URL 检测 - Agent Reach 支持的平台
export function checkUrlAgentReachSupport(url) {
  const lowerUrl = url.toLowerCase();
  
  if (/xiaohongshu\.com|xhs\.link|xhs\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'xiaohongshu', command: 'search-xhs' };
  }
  if (/twitter\.com|x\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'twitter', command: 'search-twitter' };
  }
  if (/instagram\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'instagram', command: 'search-instagram' };
  }
  if (/youtube\.com|youtu\.be/i.test(lowerUrl)) {
    return { supported: true, platform: 'youtube', command: 'search-youtube' };
  }
  if (/bilibili\.com|b23\.tv/i.test(lowerUrl)) {
    return { supported: true, platform: 'bilibili', command: 'search-bilibili' };
  }
  if (/github\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'github', command: 'search-github' };
  }
  if (/zhipin\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'boss', command: 'search-boss' };
  }
  if (/linkedin\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'linkedin', command: 'search-linkedin' };
  }
  return { supported: false, platform: 'unknown', command: null };
}

export function detectTaskType(task) {
  const t = task.toLowerCase();
  if (t.includes('搜索') || t.includes('search')) return 'search';
  if (t.includes('读取') || t.includes('read')) return 'read';
  if (t.includes('总结') || t.includes('summarize')) return 'summarize';
  if (t.includes('获取') || t.includes('fetch')) return 'fetch';
  if (t.includes('查询') || t.includes('query')) return 'query';
  return 'unknown';
}
