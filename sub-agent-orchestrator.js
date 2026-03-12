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
 */
function buildSubAgentPrompt(task, taskData) {
  // 🔴 MARK: 检测是否是 小红书/Xiaohongshu 任务
  const isXiaohongshu = /小红书|xiaohongshu|xhs/i.test(task);
  
  let platformSpecificInstructions = '';
  
  if (isXiaohongshu) {
    platformSpecificInstructions = `
🔴 IMPORTANT MARK: 小红书任务执行指南
本任务涉及小红书平台，请按以下优先级选择工具：
1. 【首选】使用 Agent Reach 技能 (ara search-xhs) 搜索小红书内容
   - Agent Reach 更适合处理社交媒体内容
   - 可以绕过登录限制
   - 命令格式: ara search-xhs "关键词"
2. 【备选】使用 browser 访问小红书网页版（可能需要登录）
3. 【备选】使用 web_search 搜索小红书相关内容

执行前请先检查是否可以使用 Agent Reach 技能。`;
  }
  
  return `你是一个任务执行智能体，专门负责完成具体的执行工作。

【任务信息】
- 任务ID: ${taskData.id}
- 来源: ${taskData.from}
- 优先级: ${taskData.priority || 'normal'}
- 任务内容: ${task}
${platformSpecificInstructions}

【执行要求】
1. 仔细分析任务需求
2. 自动选择合适的工具完成任务
3. 如果需要搜索，使用 web_search
4. 如果需要访问网页，使用 browser
5. 如果需要处理文档，使用 feishu_doc 或 docx 技能
6. 保存执行结果到 task.txt.result 文件
7. 完成后退出

【输出要求】
- 执行结果保存到: task.txt.result
- 使用JSON格式记录使用的工具: tools.json
- 简要执行日志: execution.log

请立即开始执行任务。`;
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
