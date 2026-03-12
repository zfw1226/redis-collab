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
  
  // Check blacklist first
  for (const pattern of blacklist) {
    const cleanPattern = pattern.replace('*', '');
    if (taskType.startsWith(cleanPattern) || pattern === '*') {
      return { allowed: false, reason: '黑名单任务类型', pattern };
    }
  }
  
  // Check whitelist
  for (const pattern of whitelist) {
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
  
  // Use OpenClaw message tool
  try {
    // This will be called from the main module
    return message;
  } catch (e) {
    console.error('Failed to send Feishu notification:', e);
    return null;
  }
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
async function waitForConfirmation(taskId, timeoutSeconds) {
  const startTime = Date.now();
  const timeout = timeoutSeconds * 1000;
  const confirmKey = `confirm:${taskId}`;
  
  // Create confirmation request
  // In real implementation, this would be checked via Redis or file
  console.log(`[Task ${taskId}] Waiting for confirmation (${timeoutSeconds}s)...`);
  
  // Poll for response
  while (Date.now() - startTime < timeout) {
    // Check for response (simplified - in real impl, check Redis or file)
    await sleep(1000);
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
async function processTask(task, taskData) {
  const config = loadConfig();
  const taskType = detectTaskType(task);
  const permission = checkTaskPermission(taskType, config);
  
  console.log(`[Task] Type detected: ${taskType}, Allowed: ${permission.allowed}`);
  
  // Import OpenClaw bridge (Redis-based, not direct Feishu)
  const { sendTaskConfirmation, waitForConfirmation, sendTaskCompleteNotification } = 
    await import('./openclaw-bridge.js');
  
  // If not allowed and requires confirmation
  if (!permission.allowed && permission.requiresConfirm) {
    // Send confirmation via Redis bridge (OpenClaw will send to Feishu)
    const confirmId = await sendTaskConfirmation({
      ...taskData,
      taskType
    });
    
    // Wait for user confirmation via Redis
    const confirmResult = await waitForConfirmation(confirmId, (config.CONFIRM_TIMEOUT || 5) * 60 * 1000);
    
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
    
    if (!confirmResult.confirmed) {
      return { 
        success: false, 
        reason: 'not_confirmed',
        message: `Task not confirmed within ${config.CONFIRM_TIMEOUT}s` 
      };
    }
    
    // If user chose to add to whitelist
    if (confirmResult.addToWhitelist) {
      addToWhitelist(taskType, `${taskType}类任务`);
      if (sendNotificationFn) {
        await sendNotificationFn(
          await sendFeishuNotification('added_to_whitelist', { task_type: taskType })
        );
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
  
// Execute task via subagent (executor.js)
  const executeFn = async (t) => {
    return new Promise((resolve, reject) => {
      const executorPath = path.join(__dirname, 'executor.js');
      const env = {
        ...process.env,
        TASK_DATA: JSON.stringify(taskData),
        REDIS_HOST,
        REDIS_PORT,
        REDIS_PASSWORD,
        AGENT_NAME
      };
      
      console.log(`[Task] Spawning subagent for task ${taskData.id}`);
      
      const child = spawn('node', [executorPath], {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', (data) => {
        stdout += data.toString();
        console.log(`[Subagent ${taskData.id}]`, data.toString().trim());
      });
      
      child.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error(`[Subagent ${taskData.id} Error]`, data.toString().trim());
      });
      
      child.on('close', (code) => {
        if (code === 0) {
          resolve({
            result: `Task executed by subagent. See Redis for details.`,
            stdout: stdout.substring(0, 500)
          });
        } else {
          reject(new Error(`Subagent exited with code ${code}: ${stderr}`));
        }
      });
      
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn subagent: ${err.message}`));
      });
      
      setTimeout(() => {
        resolve({
          result: `Task ${taskData.id} started in subagent. Monitoring via Redis...`,
          subagentPid: child.pid
        });
      }, 1000);
    });
  };
  
  const result = await executeTaskWithRetry(task, config, executeFn);
  
  // Send completion/failure notification via OpenClaw bridge
  await sendTaskCompleteNotification(taskData, result);
  
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
