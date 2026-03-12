// openclaw-bridge.js - Redis 桥接 OpenClaw Feishu 通道
// 不直接发送飞书消息，而是通过 Redis 队列与 OpenClaw 通信

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || '43.131.241.215',
  port: process.env.REDIS_PORT || '6379',
  password: process.env.REDIS_PASSWORD || 'OpenClaw2026!'
};

const AGENT_NAME = process.env.AGENT_NAME || 'MacStudio-本地';

// Redis key 定义
const KEYS = {
  SEND_QUEUE: 'feishu:send:queue',        // Skill → OpenClaw
  REPLY_QUEUE: 'feishu:reply:queue',      // OpenClaw → Skill
  CONFIRM_PREFIX: 'confirm:'              // 确认记录
};

/**
 * 发送飞书消息（通过 Redis 桥接）
 * 不直接调用飞书 API，而是把消息放入队列等待 OpenClaw 处理
 * @param {Object} message - 消息对象
 * @param {string} message.type - 消息类型: task_confirm, task_complete, task_fail
 * @param {string} message.content - 消息内容
 * @param {Object} message.taskData - 任务数据
 * @returns {Promise<string>} - 消息 ID
 */
export async function queueFeishuMessage(message) {
  const { spawn } = await import('child_process');
  
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  const payload = {
    id: messageId,
    agent: AGENT_NAME,
    type: message.type,
    content: message.content,
    taskId: message.taskData?.id,
    timestamp: Date.now(),
    target: 'feishu',  // 目标通道
    priority: message.priority || 'normal'
  };
  
  return new Promise((resolve, reject) => {
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} LPUSH ${KEYS.SEND_QUEUE} '${JSON.stringify(payload).replace(/'/g, "'\\''")}'`;
    
    const child = spawn('sh', ['-c', cmd]);
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[Bridge] Message queued: ${messageId}`);
        resolve(messageId);
      } else {
        reject(new Error(`Failed to queue message: ${code}`));
      }
    });
  });
}

/**
 * 发送任务确认请求
 * @param {Object} taskData - 任务数据
 * @returns {Promise<string>} - 确认 ID
 */
export async function sendTaskConfirmation(taskData) {
  const confirmId = `confirm:${taskData.id}`;
  
  const message = {
    type: 'task_confirm',
    priority: 'high',
    taskData,
    content: buildConfirmationMessage(taskData)
  };
  
  // 1. 把消息放入发送队列
  await queueFeishuMessage(message);
  
  // 2. 在 Redis 创建确认记录
  await saveConfirmRecord(confirmId, {
    taskId: taskData.id,
    task: taskData.task,
    from: taskData.from,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000, // 5分钟过期
    response: null
  });
  
  console.log(`[Bridge] Confirmation queued: ${confirmId}`);
  return confirmId;
}

/**
 * 构建确认消息文本
 */
function buildConfirmationMessage(taskData) {
  return `🔔 新任务待确认

📋 任务信息：
• 来自：${taskData.from}
• 任务：${taskData.task.substring(0, 100)}${taskData.task.length > 100 ? '...' : ''}
• 类型：${taskData.taskType || 'unknown'}
• 优先级：${taskData.priority || 'normal'}
• 时间：${new Date().toLocaleString('zh-CN')}

⚠️ 此任务不在自动执行白名单中

请选择操作：
1️⃣ 执行一次（回复：1）
2️⃣ 执行并加入白名单（回复：2）
3️⃣ 拒绝执行（回复：3）

⏰ 5分钟内有效
💡 可直接回复数字`;
}

/**
 * 发送任务完成通知
 * @param {Object} taskData - 任务数据
 * @param {Object} result - 执行结果
 */
export async function sendTaskCompleteNotification(taskData, result) {
  const content = result.success 
    ? `✅ 任务执行完成

📋 ${taskData.task.substring(0, 80)}
📊 结果：${result.result?.substring(0, 200) || '成功'}
⏰ ${new Date().toLocaleString('zh-CN')}`
    : `❌ 任务执行失败

📋 ${taskData.task.substring(0, 80)}
⚠️ 错误：${result.error}
⏰ ${new Date().toLocaleString('zh-CN')}`;

  await queueFeishuMessage({
    type: result.success ? 'task_complete' : 'task_fail',
    priority: 'normal',
    taskData,
    content
  });
}

/**
 * 等待用户确认（轮询 Redis）
 * @param {string} confirmId - 确认 ID
 * @param {number} timeoutMs - 超时时间
 * @returns {Promise<Object>}
 */
export async function waitForConfirmation(confirmId, timeoutMs = 300000) {
  const startTime = Date.now();
  const pollInterval = 3000; // 每3秒检查一次
  
  console.log(`[Bridge] Waiting for confirmation: ${confirmId}`);
  
  return new Promise((resolve) => {
    const check = async () => {
      const elapsed = Date.now() - startTime;
      
      // 检查是否超时
      if (elapsed >= timeoutMs) {
        await deleteConfirmRecord(confirmId);
        resolve({ confirmed: false, reason: 'timeout' });
        return;
      }
      
      // 检查确认记录
      const record = await getConfirmRecord(confirmId);
      if (!record) {
        resolve({ confirmed: false, reason: 'not_found' });
        return;
      }
      
      if (record.status === 'confirmed') {
        resolve({
          confirmed: true,
          addToWhitelist: record.addToWhitelist,
          response: record.response
        });
        return;
      }
      
      if (record.status === 'rejected') {
        resolve({ confirmed: false, reason: 'rejected' });
        return;
      }
      
      // 继续等待
      setTimeout(check, pollInterval);
    };
    
    check();
  });
}

/**
 * 处理用户回复（由 OpenClaw 调用）
 * @param {string} taskId - 任务 ID
 * @param {string} response - 用户响应（1, 2, 3）
 */
export async function handleUserReply(taskId, response) {
  const confirmId = `confirm:${taskId}`;
  const record = await getConfirmRecord(confirmId);
  
  if (!record || record.status !== 'pending') {
    return { success: false, error: 'Confirmation not found or expired' };
  }
  
  let status = 'rejected';
  let addToWhitelist = false;
  
  switch (response.trim()) {
    case '1':
      status = 'confirmed';
      addToWhitelist = false;
      break;
    case '2':
      status = 'confirmed';
      addToWhitelist = true;
      break;
    case '3':
      status = 'rejected';
      break;
    default:
      return { success: false, error: 'Invalid response. Use 1, 2, or 3' };
  }
  
  record.status = status;
  record.addToWhitelist = addToWhitelist;
  record.response = response;
  record.respondedAt = Date.now();
  
  await saveConfirmRecord(confirmId, record);
  
  return {
    success: true,
    status,
    addToWhitelist,
    taskId
  };
}

// Redis 操作辅助函数
async function saveConfirmRecord(key, data) {
  const { spawn } = await import('child_process');
  const ttl = 300; // 5分钟
  const value = JSON.stringify(data).replace(/'/g, "'\\''");
  
  return new Promise((resolve, reject) => {
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} SETEX ${key} ${ttl} '${value}'`;
    const child = spawn('sh', ['-c', cmd]);
    child.on('close', (code) => resolve(code === 0));
  });
}

async function getConfirmRecord(key) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} GET ${key}`;
    const child = spawn('sh', ['-c', cmd]);
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', () => {
      try {
        resolve(stdout.trim() ? JSON.parse(stdout.trim()) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function deleteConfirmRecord(key) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} DEL ${key}`;
    const child = spawn('sh', ['-c', cmd]);
    child.on('close', () => resolve(true));
  });
}

// 导出供外部使用
export { KEYS };
