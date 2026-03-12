import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configuration
let config = null;
function loadConfig() {
  if (config) return config;
  try {
    const configPath = path.join(__dirname, 'task-config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    config = yaml.load(content);
    return config;
  } catch (e) {
    console.error('Failed to load config:', e.message);
    return getDefaultConfig();
  }
}

function getDefaultConfig() {
  return {
    WHITELIST: ['search*', 'fetch*', 'read*'],
    BLACKLIST: ['delete*', 'rm *', 'exec*'],
    FEISHU: { enabled: true },
    CONFIRM_TIMEOUT: 300,
    RETRY: { max_attempts: 3, delay_seconds: 10 }
  };
}

// Task type detection with Tool Priority Strategy
// PRIORITY ORDER:
// 1. Agent Reach (社交平台 + 网页读取 + 通用搜索)
// 2. MCP Search (Tavily/MiniMax for specific search needs)
// 3. Browser (复杂交互、特定网站)
function detectTaskType(task) {
  const lowerTask = task.toLowerCase();
  
  // 🔴 Check if task contains a URL - determine if Agent Reach can handle it
  const urlMatch = task.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) {
    const url = urlMatch[1];
    const agentReachSupport = checkUrlAgentReachSupport(url);
    if (agentReachSupport.supported) {
      console.log(`[Task] URL detected: ${url}`);
      console.log(`[Task] Agent Reach can handle this platform: ${agentReachSupport.platform}`);
      return {
        type: 'fetch',
        platform: agentReachSupport.platform,
        priority: 1,
        tool: 'agent-reach',
        toolCommand: agentReachSupport.command,
        url: url,
        reason: 'URL platform supported by Agent Reach'
      };
    } else {
      // 🔴 URL not directly supported by Agent Reach platforms, but can use 'ara read'
      console.log(`[Task] URL detected: ${url}`);
      console.log(`[Task] Using Agent Reach 'read' for generic URL content extraction`);
      return {
        type: 'read',
        platform: 'web',
        priority: 1,
        tool: 'agent-reach',
        toolCommand: 'read',
        url: url,
        reason: 'Generic URL - use Agent Reach read command'
      };
    }
  }
  
  // 🔴 Check for generic "read this link/webpage" tasks
  if (/读取链接|读取网页|这个链接|这个网页|read.*link|read.*url/i.test(task)) {
    return {
      type: 'read',
      platform: 'web',
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'read',
      reason: 'Explicit webpage reading task'
    };
  }
  
  // 🔴 Check for generic search tasks - Agent Reach search is often better than MCP
  if (/查一下|搜索一下|看看|找一下|通用搜索|search/i.test(task)) {
    return {
      type: 'search',
      platform: 'web',
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search',
      reason: 'Generic search - Agent Reach preferred'
    };
  }
  
  // 🔴 PRIORITY 1: Agent Reach platforms (social media + professional)
  // 小红书/Xiaohongshu
  if (/小红书|xiaohongshu|xhs/i.test(task)) {
    return { 
      type: 'search', 
      platform: 'xiaohongshu', 
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search-xhs'
    };
  }
  
  // Twitter/X
  if (/twitter|x.*平台|推特/i.test(task)) {
    return { 
      type: 'search', 
      platform: 'twitter', 
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search-twitter'
    };
  }
  
  // Instagram
  if (/instagram|ins|ig/i.test(task)) {
    return { 
      type: 'search', 
      platform: 'instagram', 
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search-instagram'
    };
  }
  
  // YouTube
  if (/youtube|油管/i.test(task)) {
    return { 
      type: 'search', 
      platform: 'youtube', 
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search-youtube'
    };
  }
  
  // Bilibili/B站
  if (/bilibili|b站|哔哩哔哩/i.test(task)) {
    return { 
      type: 'search', 
      platform: 'bilibili', 
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search-bilibili'
    };
  }
  
  // GitHub
  if (/github|git.*hub/i.test(task)) {
    return { 
      type: 'search', 
      platform: 'github', 
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search-github'
    };
  }
  
  // 🔴 PRIORITY 2: MCP Search (general web search)
  // 一般搜索任务使用 Tavily/MiniMax MCP
  if (/搜索|查找|search|find|query|查.*信息/i.test(lowerTask)) {
    return { 
      type: 'search', 
      platform: 'web',
      priority: 2,
      tool: 'mcp-search',
      toolCommand: 'tavily/minimax'
    };
  }
  
  // 🔴 PRIORITY 3: Browser (specific websites or fallback)
  if (/获取|fetch|get|download/i.test(lowerTask)) {
    return { 
      type: 'fetch', 
      priority: 3,
      tool: 'browser'
    };
  }
  
  if (/读取|read|open/i.test(lowerTask)) {
    return { 
      type: 'read', 
      priority: 3,
      tool: 'browser'
    };
  }
  
  if (/总结|summarize|归纳|summary/i.test(lowerTask)) {
    return { 
      type: 'summarize', 
      priority: 3,
      tool: 'browser'
    };
  }
  
  if (/分析|analyze|analysis/i.test(lowerTask)) {
    return { 
      type: 'analyze', 
      priority: 3,
      tool: 'browser'
    };
  }
  
  if (/生成|create|生成|write/i.test(lowerTask)) {
    return { 
      type: 'create', 
      priority: 3,
      tool: 'browser'
    };
  }
  
  if (/删除|delete|remove|rm /i.test(lowerTask)) {
    return { 
      type: 'delete', 
      priority: 3,
      tool: 'browser'
    };
  }
  
  if (/执行|exec|run|command/i.test(lowerTask)) {
    return { 
      type: 'exec', 
      priority: 3,
      tool: 'browser'
    };
  }
  
  return { 
    type: 'unknown', 
    priority: 3,
    tool: 'browser'
  };
}

// Check if task matches whitelist/blacklist
// 简化逻辑：所有任务都直接执行，跳过白名单确认
function checkTaskPermission(taskTypeInfo, config) {
  const taskType = typeof taskTypeInfo === 'object' ? taskTypeInfo.type : taskTypeInfo;
  
  // 所有任务都允许执行
  return { allowed: true, pattern: '*', taskTypeInfo };
}

// Send Feishu notification via OpenClaw
async function sendFeishuNotification(type, data) {
  const config = loadConfig();
  if (!config.FEISHU || !config.FEISHU.enabled) return;
  
  const templates = config.NOTIFICATION_TEMPLATES || {};
  let message = '';
  
  switch (type) {
    case 'new_task':
      message = (templates.new_task || `🔔 新任务待确认\n\n来自: {from}\n任务: {task}\n类型: {task_type}\n优先级: {priority}\n\n⚠️ 此任务不在白名单中\n\n请回复:\n1 - 执行一次\n2 - 执行并加入白名单\n3 - 拒绝`).replace(/{(\w+)}/g, (m, k) => data[k] || m);
      break;
    case 'task_failed':
      message = (templates.task_failed || `❌ 任务失败\n\n任务: {task}\n来自: {from}\n失败: {attempts}/{max_attempts}\n错误: {error}`).replace(/{(\w+)}/g, (m, k) => data[k] || m);
      break;
    case 'task_completed':
      message = `✅ 任务完成\n\n任务: ${data.task}\n结果: ${(typeof data.result === 'string' ? data.result.substring(0, 100) : JSON.stringify(data.result).substring(0, 100))}${data.result.length > 100 ? '...' : ''}`;
      break;
    case 'added_to_whitelist':
      message = `✅ 已加入白名单\n\n任务类型: ${data.task_type}\n描述: ${data.description}`;
      break;
  }
  
  return message;
}

// Add task type to whitelist
function addToWhitelist(taskType, description) {
  const configPath = path.join(__dirname, 'task-config.yaml');
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = yaml.load(content);
    
    // Check if already exists
    const exists = config.WHITELIST.some(item => {
      if (typeof item === 'string') return item === `${taskType}*`;
      return Object.keys(item)[0] === `${taskType}*`;
    });
    
    if (exists) return false;
    
    // Add to whitelist
    const newEntry = {};
    newEntry[`${taskType}*`] = description || `${taskType}类任务`;
    config.WHITELIST.push(newEntry);
    
    // Save back
    fs.writeFileSync(configPath, yaml.dump(config), 'utf8');
    return true;
  } catch (e) {
    console.error('Failed to add to whitelist:', e);
    return false;
  }
}

// Wait for user confirmation (via Redis or file polling)
async function waitForConfirmation(taskId, timeoutMs, redis) {
  const startTime = Date.now();
  const confirmKey = `confirm:${taskId}`;
  
  console.log(`[Task ${taskId}] Waiting for confirmation (${timeoutMs}ms)...`);
  
  // Poll for response
  while (Date.now() - startTime < timeoutMs) {
    try {
      if (redis) {
        const result = await redis.get(confirmKey);
        if (result) {
          await redis.del(confirmKey);
          return JSON.parse(result);
        }
      }
    } catch (e) {
      console.error('[Confirmation] Error checking Redis:', e.message);
    }
    await sleep(2000);
  }
  
  return { confirmed: false, reason: 'timeout' };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Execute task with retry logic
async function executeTaskWithRetry(task, config, executeFn) {
  const maxAttempts = config.RETRY?.max_attempts || 3;
  const delaySeconds = config.RETRY?.delay_seconds || 10;
  
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`[Task] Attempt ${attempt}/${maxAttempts}`);
      const result = await executeFn(task);
      return { success: true, result, attempts: attempt };
    } catch (error) {
      lastError = error;
      console.error(`[Task] Attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxAttempts) {
        console.log(`[Task] Retrying in ${delaySeconds}s...`);
        await sleep(delaySeconds * 1000);
      }
    }
  }
  
  return { 
    success: false, 
    error: lastError?.message || 'Unknown error', 
    attempts: maxAttempts 
  };
}

// Main task processor
async function processTask(task, taskData, redis, sendNotificationFn) {
  const config = loadConfig();
  const taskTypeInfo = detectTaskType(task);
  const taskType = typeof taskTypeInfo === 'object' ? taskTypeInfo.type : taskTypeInfo;
  const permission = checkTaskPermission(taskTypeInfo, config);
  
  console.log(`[Task] Type detected: ${taskType}, Priority: ${taskTypeInfo.priority}, Tool: ${taskTypeInfo.tool || 'auto'}`);
  
  // 🔴 MARK: Tool Priority Strategy
  // Priority 1: Agent Reach (社交平台)
  // Priority 2: MCP Search (Tavily/MiniMax)
  // Priority 3: Browser (备选)
  if (typeof taskTypeInfo === 'object') {
    if (taskTypeInfo.priority === 1) {
      console.log(`[Task] 🔴 MARK: Priority 1 - Use Agent Reach (${taskTypeInfo.toolCommand})`);
    } else if (taskTypeInfo.priority === 2) {
      console.log(`[Task] 🔴 MARK: Priority 2 - Use MCP Search (tavily/minimax)`);
    } else {
      console.log(`[Task] 🔴 MARK: Priority 3 - Use Browser (fallback)`);
    }
  }
  
  // If not allowed and requires confirmation
  if (!permission.allowed && permission.requiresConfirm) {
    console.log(`[Task] Requires confirmation, sending notification...`);
    
    // Send notification if function provided
    if (sendNotificationFn) {
      const notification = await sendFeishuNotification('new_task', {
        from: taskData.from,
        task: task.substring(0, 100),
        task_type: taskType,
        priority: taskData.priority || 'normal'
      });
      await sendNotificationFn(notification);
    }
    
    // Wait for user confirmation
    const timeoutMs = (config.CONFIRM_TIMEOUT || 5) * 60 * 1000;
    const confirmResult = await waitForConfirmation(taskData.id, timeoutMs, redis);
    
    if (!confirmResult.confirmed) {
      return { 
        success: false, 
        reason: 'not_confirmed',
        message: `Task not confirmed: ${confirmResult.reason}` 
      };
    }
    
    // If user chose to add to whitelist
    if (confirmResult.addToWhitelist) {
      addToWhitelist(taskType, `${taskType}类任务`);
      console.log(`[Task] Added ${taskType} to whitelist`);
      if (sendNotificationFn) {
        const notification = await sendFeishuNotification('added_to_whitelist', { 
          task_type: taskType,
          description: `${taskType}类任务`
        });
        await sendNotificationFn(notification);
      }
      // Re-check permission after adding to whitelist
      permission = checkTaskPermission(taskTypeInfo, config);
    }
  }
  
  // If blacklisted
  if (!permission.allowed && !permission.requiresConfirm) {
    return { 
      success: false, 
      reason: 'blacklisted',
      message: `Task type '${taskType}' is blacklisted: ${permission.reason}` 
    };
  }
  
  // Execute task using Sub-Agent Orchestrator
  const executeFn = async (t) => {
    // Import sub-agent orchestrator
    const { spawnSubAgent, checkSubAgentResult } = await import('./sub-agent-orchestrator.js');
    
    console.log(`[Task] Spawning sub-agent for task: ${taskData.id}`);
    console.log(`[Task] Task content: ${t.substring(0, 80)}...`);
    
    // Create spawn request - this will publish to Redis and trigger the listener
    const spawnResult = await spawnSubAgent(t, taskData, redis);
    
    if (!spawnResult.success) {
      throw new Error(`Failed to create spawn request: ${spawnResult.error}`);
    }
    
    console.log(`[Task] Sub-agent spawn request created: ${spawnResult.taskDir}`);
    console.log(`[Task] Waiting for sub-agent to complete...`);
    
    // 等待 sub-agent 执行完成
    const maxWait = 30 * 60 * 1000; // 30分钟超时
    const startTime = Date.now();
    const checkInterval = 5000; // 每5秒检查一次
    
    while (Date.now() - startTime < maxWait) {
      const result = await checkSubAgentResult(taskData, redis);
      
      if (result.success) {
        console.log(`[Task] Sub-agent completed successfully`);
        return {
          result: result.result,
          status: 'completed',
          tools_used: result.tools || ['sub-agent']
        };
      }
      
      if (result.status === 'failed' || result.error) {
        throw new Error(result.error || 'Sub-agent execution failed');
      }
      
      // 继续等待
      console.log(`[Task] Still waiting...`);
      await new Promise(r => setTimeout(r, checkInterval));
    }
    
    throw new Error('Sub-agent execution timeout (30 minutes)');
  };
  
  const result = await executeTaskWithRetry(task, config, executeFn);
  
  // Send completion/failure notification
  if (sendNotificationFn) {
    if (result.success) {
      const notification = await sendFeishuNotification('task_completed', {
        task: task.substring(0, 50),
        result: result.result
      });
      await sendNotificationFn(notification);
    } else {
      const notification = await sendFeishuNotification('task_failed', {
        task: task.substring(0, 50),
        from: taskData.from,
        attempts: result.attempts,
        max_attempts: config.RETRY?.max_attempts || 3,
        error: result.error
      });
      await sendNotificationFn(notification);
    }
  }
  
  return result;
}

/**
 * 🔴 Check if a URL is supported by Agent Reach
 * @param {string} url - The URL to check
 * @returns {object} - { supported: boolean, platform: string, command: string }
 */
function checkUrlAgentReachSupport(url) {
  const lowerUrl = url.toLowerCase();
  
  // 小红书/Xiaohongshu
  if (/xiaohongshu\.com|xhs\.link/i.test(lowerUrl)) {
    return { supported: true, platform: 'xiaohongshu', command: 'search-xhs' };
  }
  
  // Twitter/X
  if (/twitter\.com|x\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'twitter', command: 'search-twitter' };
  }
  
  // Instagram
  if (/instagram\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'instagram', command: 'search-instagram' };
  }
  
  // YouTube
  if (/youtube\.com|youtu\.be/i.test(lowerUrl)) {
    return { supported: true, platform: 'youtube', command: 'search-youtube' };
  }
  
  // Bilibili
  if (/bilibili\.com|b23\.tv/i.test(lowerUrl)) {
    return { supported: true, platform: 'bilibili', command: 'search-bilibili' };
  }
  
  // GitHub
  if (/github\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'github', command: 'search-github' };
  }
  
  // Boss直聘
  if (/zhipin\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'boss', command: 'search-boss' };
  }
  
  // LinkedIn
  if (/linkedin\.com/i.test(lowerUrl)) {
    return { supported: true, platform: 'linkedin', command: 'search-linkedin' };
  }
  
  // Not supported by Agent Reach
  return { supported: false, platform: 'unknown', command: null };
}

export {
  loadConfig,
  detectTaskType,
  checkTaskPermission,
  sendFeishuNotification,
  addToWhitelist,
  waitForConfirmation,
  executeTaskWithRetry,
  processTask
};
