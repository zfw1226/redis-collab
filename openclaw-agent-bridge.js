// OpenClaw Agent Bridge - 智能任务执行桥接
// 调用主智能体(OpenClaw)来自动选择工具和技能完成任务

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 调用 OpenClaw 智能体执行任务
 * @param {string} task - 任务描述
 * @param {object} taskData - 任务元数据
 * @returns {Promise<{success: boolean, result: string, tools: string[]}>}
 */
export async function callOpenClawAgent(task, taskData) {
  console.log(`[OpenClaw Bridge] Calling agent for task: ${taskData.id}`);
  console.log(`[OpenClaw Bridge] Task content: ${task.substring(0, 100)}...`);
  
  try {
    // 构建提示词，包含任务上下文
    const prompt = buildAgentPrompt(task, taskData);
    
    // 调用 OpenClaw 通过 sessions_spawn 或直接在当前会话执行
    // 方案1: 写入任务到文件，触发当前 OpenClaw 检测并执行
    // 方案2: 通过 Redis 发布任务结果，让主智能体订阅处理
    
    const result = await executeViaOpenClaw(prompt, taskData);
    
    return {
      success: true,
      result: result,
      tools: result.tools || []
    };
  } catch (error) {
    console.error('[OpenClaw Bridge] Error:', error.message);
    return {
      success: false,
      error: error.message,
      result: null
    };
  }
}

/**
 * 构建给 OpenClaw 智能体的提示词
 */
function buildAgentPrompt(task, taskData) {
  return `
你收到一个来自分布式协作系统的任务，请自动选择合适的工具和技能来完成。

【任务信息】
- 任务ID: ${taskData.id}
- 来源: ${taskData.from}
- 优先级: ${taskData.priority || 'normal'}
- 任务内容: ${task}

【可用工具】
根据任务内容自动选择以下工具：
- web_search: 网页搜索 (Google/Bing)
- browser: 浏览器自动化 (访问网站、点击、提取内容)
- web_fetch: 获取网页内容
- feishu_doc: 飞书文档操作
- 其他相关工具...

【执行要求】
1. 分析任务类型，自动选择最适合的工具组合
2. 如果需要搜索，先搜索再访问相关页面
3. 如果需要数据提取，使用 browser 或 web_fetch
4. 如果需要生成文档，使用 feishu_doc
5. 返回完整的执行结果给用户

【输出格式】
请返回以下JSON格式结果：
{
  "summary": "任务执行摘要",
  "details": "详细结果",
  "tools_used": ["tool1", "tool2"],
  "success": true/false
}

请现在开始执行任务。
`;
}

/**
 * 通过 OpenClaw 执行任务的实现
 * 方案: 使用 redis 作为通信桥梁
 */
async function executeViaOpenClaw(prompt, taskData) {
  // 将任务写入 Redis，让主 OpenClaw 实例检测并执行
  const Redis = (await import('ioredis')).default;
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD
  });
  
  const executionKey = `execution:${taskData.id}`;
  
  // 1. 发布执行任务到 Redis
  await redis.setex(executionKey, 3600, JSON.stringify({
    id: taskData.id,
    prompt: prompt,
    task: taskData.task,
    from: taskData.from,
    status: 'pending',
    timestamp: Date.now()
  }));
  
  // 2. 发布到执行队列，通知主智能体
  await redis.publish('openclaw:execution', JSON.stringify({
    id: taskData.id,
    executionKey: executionKey
  }));
  
  console.log(`[OpenClaw Bridge] Published task ${taskData.id} to execution queue`);
  
  // 3. 等待执行结果 (最多等待 10 分钟)
  const maxWait = 10 * 60 * 1000;
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWait) {
    const result = await redis.get(executionKey);
    if (result) {
      const data = JSON.parse(result);
      if (data.status === 'completed') {
        await redis.del(executionKey);
        redis.disconnect();
        return {
          result: data.result,
          tools: data.tools_used || []
        };
      }
      if (data.status === 'failed') {
        await redis.del(executionKey);
        redis.disconnect();
        throw new Error(data.error || 'Task execution failed');
      }
    }
    await sleep(2000);
  }
  
  redis.disconnect();
  throw new Error('Task execution timeout');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 替代方案: 直接在当前进程调用 OpenClaw
 * 通过调用 openclaw CLI 或直接在当前 session 执行
 */
export async function executeDirectly(task, taskData) {
  console.log(`[Direct Execute] Task ${taskData.id}: ${task}`);
  
  // 这里可以实现直接调用当前 OpenClaw 实例的逻辑
  // 例如通过 socket、stdio 或其他 IPC 机制
  
  // 目前返回一个占位符，表示需要人工介入
  return {
    success: true,
    result: `[任务已转发给主智能体]\n任务: ${task}\n\n请主智能体选择合适的工具完成此任务，并将结果返回。`,
    tools: ['manual_handoff'],
    requiresManual: true
  };
}
