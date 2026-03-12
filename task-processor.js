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

// Task type detection
function detectTaskType(task) {
  const lowerTask = task.toLowerCase();
  
  // Search patterns
  if (/搜索|查找|search|find|query/i.test(lowerTask)) return 'search';
  if (/获取|fetch|get|download/i.test(lowerTask)) return 'fetch';
  if (/读取|read|open/i.test(lowerTask)) return 'read';
  if (/总结|summarize|归纳|summary/i.test(lowerTask)) return 'summarize';
  if (/分析|analyze|analysis/i.test(lowerTask)) return 'analyze';
  if (/生成|create|生成|write/i.test(lowerTask)) return 'create';
  if (/删除|delete|remove|rm /i.test(lowerTask)) return 'delete';
  if (/执行|exec|run|command/i.test(lowerTask)) return 'exec';
  
  return 'unknown';
}

// Check if task matches whitelist/blacklist
function checkTaskPermission(taskType, config) {
  const whitelist = config.WHITELIST || [];
  const blacklist = config.BLACKLIST || [];
  
  // Helper to get pattern string from various formats
  const getPattern = (item) => {
    if (typeof item === 'string') return item;
    if (typeof item === 'object' && item !== null) {
      return Object.keys(item)[0];
    }
    return String(item);
  };
  
  // Check blacklist first
  for (const item of blacklist) {
    const pattern = getPattern(item);
    const cleanPattern = pattern.replace('*', '');
    if (taskType.startsWith(cleanPattern) || pattern === '*') {
      return { allowed: false, reason: '黑名单任务类型', pattern };
    }
  }
  
  // Check whitelist
  for (const item of whitelist) {
    const pattern = getPattern(item);
    const cleanPattern = pattern.replace('*', '');
    if (taskType.startsWith(cleanPattern) || pattern === '*') {
      return { allowed: true, pattern };
    }
  }
  
  return { allowed: false, reason: '不在白名单中', requiresConfirm: true };
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
      message = `✅ 任务完成\n\n任务: ${data.task}\n结果: ${data.result.substring(0, 100)}${data.result.length > 100 ? '...' : ''}`;
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
  const taskType = detectTaskType(task);
  const permission = checkTaskPermission(taskType, config);
  
  console.log(`[Task] Type detected: ${taskType}, Allowed: ${permission.allowed}`);
  
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
    
    // Step 1: Create spawn request
    const spawnResult = await spawnSubAgent(t, taskData, redis);
    
    if (!spawnResult.success) {
      throw new Error(`Failed to create spawn request: ${spawnResult.error}`);
    }
    
    console.log(`[Task] Sub-agent spawn request created: ${spawnResult.taskDir}`);
    console.log(`[Task] Waiting for sub-agent to complete...`);
    
    // Step 2: Wait for sub-agent to complete (max 30 minutes)
    const maxWait = 30 * 60 * 1000;
    const startTime = Date.now();
    const checkInterval = 10000; // Check every 10 seconds
    
    while (Date.now() - startTime < maxWait) {
      const result = await checkSubAgentResult(taskData, redis);
      
      if (result.success) {
        console.log(`[Task] Sub-agent completed successfully`);
        return {
          result: result.result,
          tools_used: result.tools,
          executed_by: 'sub-agent',
          completed_at: new Date().toISOString()
        };
      }
      
      if (result.error) {
        throw new Error(`Sub-agent failed: ${result.error}`);
      }
      
      // Still processing, wait and check again
      await sleep(checkInterval);
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
