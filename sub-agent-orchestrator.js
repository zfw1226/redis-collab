// OpenClaw Agent Bridge - Sub-Agent Task Orchestration
// 主Agent作为Orchestrator，派发Sub-Agent执行任务

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 调用 Sub-Agent 执行任务（通过 sessions_spawn）
 * @param {string} task - 任务描述
 * @param {object} taskData - 任务元数据
 * @param {Redis} redis - Redis 实例
 * @returns {Promise<{success: boolean, result: string, sessionKey: string}>}
 */
export async function spawnSubAgent(task, taskData, redis) {
  console.log(`[Sub-Agent Spawner] Spawning agent for task: ${taskData.id}`);
  console.log(`[Sub-Agent Spawner] Task: ${task.substring(0, 100)}...`);
  
  try {
    // 创建任务执行目录
    const taskDir = path.join(__dirname, 'task-executions', taskData.id);
    if (!fs.existsSync(taskDir)) {
      fs.mkdirSync(taskDir, { recursive: true });
    }
    
    // 写入任务描述文件
    const taskFile = path.join(taskDir, 'task.txt');
    fs.writeFileSync(taskFile, task, 'utf8');
    
    // 写入任务元数据
    const metaFile = path.join(taskDir, 'meta.json');
    fs.writeFileSync(metaFile, JSON.stringify(taskData, null, 2), 'utf8');
    
    // 写入系统提示词
    const promptFile = path.join(taskDir, 'prompt.txt');
    const systemPrompt = buildSubAgentPrompt(task, taskData);
    fs.writeFileSync(promptFile, systemPrompt, 'utf8');
    
    // 更新 Redis 状态为 processing
    const executionKey = `execution:${taskData.id}`;
    await redis.setex(executionKey, 3600, JSON.stringify({
      id: taskData.id,
      task: taskData.task,
      from: taskData.from,
      status: 'processing',
      processingBy: 'sub-agent',
      taskDir: taskDir,
      spawnedAt: new Date().toISOString()
    }));
    
    console.log(`[Sub-Agent Spawner] Task files created in: ${taskDir}`);
    console.log(`[Sub-Agent Spawner] Sub-agent should now be spawned by main agent`);
    
    // 返回任务目录，等待主 Agent 派生 sub-agent
    return {
      success: true,
      taskDir: taskDir,
      taskFile: taskFile,
      promptFile: promptFile,
      metaFile: metaFile,
      executionKey: executionKey,
      message: 'Sub-agent spawn request created. Main agent should spawn the sub-agent now.'
    };
    
  } catch (error) {
    console.error('[Sub-Agent Spawner] Error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 构建给 Sub-Agent 的系统提示词
 * 根据任务类型和工具优先级策略生成
 */
function buildSubAgentPrompt(task, taskData) {
  // 检测任务类型
  const taskTypeInfo = detectTaskTypeForPrompt(task);
  
  let toolPriorityInstructions = '';
  
  // 🔴 根据优先级生成工具选择指南
  if (taskTypeInfo.priority === 1) {
    // Agent Reach 优先
    if (taskTypeInfo.toolCommand === 'read') {
      // Agent Reach read command for URLs
      toolPriorityInstructions = `
🔴 TOOL PRIORITY: Agent Reach - Read (Priority 1)
本任务需要读取网页内容，优先使用 Agent Reach 'read' 命令：

【首选工具】Agent Reach - Read
命令格式: source ~/.openclaw/workspace/skills/agent-reach/bin/ara-env && agent-reach read "URL"
示例: source ~/.openclaw/workspace/skills/agent-reach/bin/ara-env && agent-reach read "${taskTypeInfo.url || 'https://example.com'}"

⚠️ 重要: 必须先激活环境再执行命令！

优势:
- 专门优化用于网页内容提取
- 可处理多种网站格式
- 自动提取主要内容，过滤广告

如果 Agent Reach read 失败，再考虑:
- 【备选1】Browser 直接访问网页
- 【备选2】MCP Search 获取相关信息`;
    } else if (taskTypeInfo.toolCommand === 'search') {
      // Agent Reach generic search
      toolPriorityInstructions = `
🔴 TOOL PRIORITY: Agent Reach - Search (Priority 1)
本任务适合使用 Agent Reach 通用搜索：

【首选工具】Agent Reach - Search
命令格式: source ~/.openclaw/workspace/skills/agent-reach/bin/ara-env && agent-reach search "关键词"
示例: source ~/.openclaw/workspace/skills/agent-reach/bin/ara-env && agent-reach search "${extractKeywords(task)}"

⚠️ 重要: 必须先激活环境再执行命令！

优势:
- 综合多个平台搜索结果
- 快速获取全网信息
- 无需指定具体平台

如果 Agent Reach search 结果不足，再考虑:
- 【备选1】MCP Search (tavily/minimax) 获取更详细结果
- 【备选2】指定具体平台搜索 (如 search-xhs, search-twitter 等)
- 【备选3】Browser 访问具体网站`;
    } else {
      // Agent Reach platform-specific search
      toolPriorityInstructions = `
🔴 TOOL PRIORITY: Agent Reach (Priority 1)
本任务涉及 ${taskTypeInfo.platform} 平台，请优先使用 Agent Reach 技能：

【首选工具】Agent Reach
命令格式: source ~/.openclaw/workspace/skills/agent-reach/bin/ara-env && agent-reach ${taskTypeInfo.toolCommand} "搜索关键词"
示例: source ~/.openclaw/workspace/skills/agent-reach/bin/ara-env && agent-reach ${taskTypeInfo.toolCommand} "${extractKeywords(task)}"

⚠️ 重要: 必须先激活环境再执行命令！

优势:
- 专门为 ${taskTypeInfo.platform} 优化
- 可绕过登录限制
- 更适合社交媒体内容抓取

如果 Agent Reach 失败，再考虑:
- 【备选1】MCP Search (tavily/minimax)
- 【备选2】Browser 直接访问`;
    }
  } else if (taskTypeInfo.priority === 2) {
    // MCP Search 优先
    toolPriorityInstructions = `
🔴 TOOL PRIORITY: MCP Search (Priority 2)
本任务适合使用 MCP Search 工具：

【首选工具】MCP Search
- Tavily MCP: mcporter call tavily.tavily_search query="关键词"
- MiniMax MCP: mcporter call minimax-coding.web_search query="关键词"

优势:
- 快速获取全网信息
- 结构化搜索结果
- 支持多种搜索参数

如果 MCP Search 结果不足，再考虑:
- 【备选1】Browser 访问具体网站
- 【备选2】Agent Reach (如果涉及社交平台)`;
  } else {
    // Browser 优先
    toolPriorityInstructions = `
🔴 TOOL PRIORITY: Browser (Priority 3)
本任务需要使用 Browser 工具：

【首选工具】Browser
- 访问具体网页
- 点击、填写表单
- 提取页面内容

如果 Browser 遇到限制（如需要登录），再考虑:
- 【备选1】MCP Search 获取相关信息
- 【备选2】Agent Reach (如果涉及社交平台)`;
  }
  
  return `你是一个任务执行智能体，专门负责完成具体的执行工作。

【任务信息】
- 任务ID: ${taskData.id}
- 来源: ${taskData.from}
- 优先级: ${taskData.priority || 'normal'}
- 任务类型: ${taskTypeInfo.type}
- 推荐平台: ${taskTypeInfo.platform || 'general'}
- 任务内容: ${task}

【工具选择优先级指南】${toolPriorityInstructions}

【通用执行要求】
1. 仔细分析任务需求
2. 按照上述优先级选择合适的工具
3. 如果首选工具失败，按顺序尝试备选工具
4. 记录实际使用的工具
5. 保存执行结果到 task.txt.result 文件
6. 完成后退出

【输出要求】
- 执行结果保存到: task.txt.result
- 使用JSON格式记录使用的工具: tools.json (格式: {"tools": ["tool1"], "priority": 1})
- 简要执行日志: execution.log

请立即开始执行任务，优先使用推荐的工具！`;
}

/**
 * 为提示词检测任务类型
 */
function detectTaskTypeForPrompt(task) {
  const lowerTask = task.toLowerCase();
  
  // 🔴 Check if task contains a URL
  const urlMatch = task.match(/(https?:\/\/[^\s]+)/);
  if (urlMatch) {
    const url = urlMatch[1];
    const agentReachSupport = checkUrlAgentReachSupport(url);
    if (agentReachSupport.supported) {
      return { 
        type: 'fetch',
        platform: agentReachSupport.platform,
        priority: 1,
        tool: 'agent-reach',
        toolCommand: agentReachSupport.command,
        url: url
      };
    } else {
      // Generic URL - use Agent Reach 'read' command
      return {
        type: 'read',
        platform: 'web',
        priority: 1,
        tool: 'agent-reach',
        toolCommand: 'read',
        url: url
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
      toolCommand: 'read'
    };
  }
  
  // 🔴 Check for generic search tasks
  if (/查一下|搜索一下|看看|找一下|通用搜索|search/i.test(task)) {
    return {
      type: 'search',
      platform: 'web',
      priority: 1,
      tool: 'agent-reach',
      toolCommand: 'search'
    };
  }
  
  // Priority 1: Agent Reach platforms
  if (/小红书|xiaohongshu|xhs/i.test(task)) {
    return { type: 'search', platform: 'xiaohongshu', priority: 1, tool: 'agent-reach', toolCommand: 'search-xhs' };
  }
  if (/twitter|x.*平台|推特/i.test(task)) {
    return { type: 'search', platform: 'twitter', priority: 1, tool: 'agent-reach', toolCommand: 'search-twitter' };
  }
  if (/instagram|ins|ig/i.test(task)) {
    return { type: 'search', platform: 'instagram', priority: 1, tool: 'agent-reach', toolCommand: 'search-instagram' };
  }
  if (/youtube|油管/i.test(task)) {
    return { type: 'search', platform: 'youtube', priority: 1, tool: 'agent-reach', toolCommand: 'search-youtube' };
  }
  if (/bilibili|b站|哔哩哔哩/i.test(task)) {
    return { type: 'search', platform: 'bilibili', priority: 1, tool: 'agent-reach', toolCommand: 'search-bilibili' };
  }
  if (/github|git.*hub/i.test(task)) {
    return { type: 'search', platform: 'github', priority: 1, tool: 'agent-reach', toolCommand: 'search-github' };
  }
  
  // Priority 2: MCP Search
  if (/搜索|查找|search|find|query|查.*信息/i.test(lowerTask)) {
    return { type: 'search', platform: 'web', priority: 2, tool: 'mcp-search' };
  }
  
  // Priority 3: Browser
  return { type: 'unknown', platform: 'web', priority: 3, tool: 'browser' };
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

/**
 * 提取搜索关键词
 */
function extractKeywords(task) {
  // 简单提取：去除常见动词和平台名，保留核心名词
  return task
    .replace(/搜索|查找|关于|的|信息|内容/g, '')
    .replace(/小红书|twitter|instagram|youtube|bilibili|github/gi, '')
    .trim() || '相关';
}

/**
 * 检查 Sub-Agent 执行结果
 */
export async function checkSubAgentResult(taskData, redis) {
  const taskDir = path.join(__dirname, 'task-executions', taskData.id);
  const resultFile = path.join(taskDir, 'task.txt.result');
  const toolsFile = path.join(taskDir, 'tools.json');
  const logFile = path.join(taskDir, 'execution.log');
  
  // 检查结果文件是否存在
  if (fs.existsSync(resultFile)) {
    const result = fs.readFileSync(resultFile, 'utf8');
    let tools = [];
    
    if (fs.existsSync(toolsFile)) {
      try {
        tools = JSON.parse(fs.readFileSync(toolsFile, 'utf8')).tools || [];
      } catch (e) {}
    }
    
    // 更新 Redis 状态为 completed
    const executionKey = `execution:${taskData.id}`;
    await redis.setex(executionKey, 3600, JSON.stringify({
      id: taskData.id,
      task: taskData.task,
      from: taskData.from,
      status: 'completed',
      result: result,
      tools_used: tools,
      completedAt: new Date().toISOString()
    }));
    
    return {
      success: true,
      result: result,
      tools: tools
    };
  }
  
  // 检查是否超时或失败
  const executionKey = `execution:${taskData.id}`;
  const data = await redis.get(executionKey);
  if (data) {
    const execData = JSON.parse(data);
    if (execData.status === 'failed') {
      return {
        success: false,
        error: execData.error || 'Sub-agent execution failed'
      };
    }
    
    // 检查是否超时（30分钟）
    if (execData.spawnedAt) {
      const spawnedTime = new Date(execData.spawnedAt).getTime();
      const now = Date.now();
      if (now - spawnedTime > 30 * 60 * 1000) {
        await redis.setex(executionKey, 3600, JSON.stringify({
          ...execData,
          status: 'failed',
          error: 'Sub-agent execution timeout (30 min)'
        }));
        return {
          success: false,
          error: 'Sub-agent execution timeout'
        };
      }
    }
  }
  
  return {
    success: false,
    status: 'pending',
    message: 'Sub-agent still processing'
  };
}

/**
 * 获取所有待派发的任务
 */
export async function getPendingSpawnRequests(redis) {
  const keys = await redis.keys('execution:*');
  const pending = [];
  
  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      const execData = JSON.parse(data);
      if (execData.status === 'processing' && execData.processingBy === 'sub-agent') {
        // 检查本地文件是否存在
        const taskDir = execData.taskDir;
        if (taskDir && fs.existsSync(taskDir)) {
          pending.push({
            id: execData.id,
            task: execData.task,
            from: execData.from,
            taskDir: taskDir,
            spawnedAt: execData.spawnedAt,
            executionKey: key
          });
        }
      }
    }
  }
  
  return pending;
}

/**
 * 主流程：检测任务并派发 Sub-Agent
 * 这个函数会被主 Agent 调用
 */
export async function orchestrateTaskExecution(redis, options = {}) {
  console.log('[Orchestrator] Checking for pending spawn requests...');
  
  const pending = await getPendingSpawnRequests(redis);
  
  if (pending.length === 0) {
    console.log('[Orchestrator] No pending spawn requests');
    return [];
  }
  
  console.log(`[Orchestrator] Found ${pending.length} pending spawn requests`);
  
  const results = [];
  
  for (const request of pending) {
    console.log(`[Orchestrator] Task ${request.id}: ${request.task.substring(0, 50)}...`);
    
    // 检查是否已经有结果
    const checkResult = await checkSubAgentResult(
      { id: request.id, task: request.task, from: request.from },
      redis
    );
    
    if (checkResult.success || checkResult.error) {
      // 任务已完成或失败
      results.push({
        id: request.id,
        status: checkResult.success ? 'completed' : 'failed',
        result: checkResult.result || checkResult.error
      });
    } else {
      // 任务仍在处理中，需要主 Agent 派生 sub-agent
      results.push({
        id: request.id,
        status: 'needs_spawn',
        taskDir: request.taskDir,
        task: request.task,
        promptFile: path.join(request.taskDir, 'prompt.txt'),
        message: `Sub-agent needs to be spawned for task ${request.id}`
      });
    }
  }
  
  return results;
}
