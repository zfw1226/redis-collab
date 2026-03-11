// feishu-notifier.js - 飞书通知和确认处理
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Redis 配置
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || '43.131.241.215',
  port: process.env.REDIS_PORT || '6379',
  password: process.env.REDIS_PASSWORD || 'OpenClaw2026!'
};

const AGENT_NAME = process.env.AGENT_NAME || 'MacStudio-本地';

/**
 * 发送飞书消息（通过OpenClaw CLI）
 * @param {string} content - 消息内容
 * @returns {Promise<boolean>}
 */
export async function sendFeishuMessage(content) {
  return new Promise((resolve, reject) => {
    console.log('[Feishu] Sending message:', content.substring(0, 100) + '...');
    
    // 方案1: 通过写入文件触发通知
    // 方案2: 直接调用openclaw命令（如果可用）
    // 方案3: 通过Redis pub/sub通知Main Agent
    
    // 目前使用方案3: 写入Redis队列，由Main Agent轮询处理
    const fs = require('fs');
    const path = require('path');
    
    const notificationFile = path.join('/tmp', `feishu-notify-${Date.now()}.txt`);
    fs.writeFileSync(notificationFile, content, 'utf8');
    
    console.log('[Feishu] Notification queued:', notificationFile);
    resolve(true);
  });
}

/**
 * 发送任务确认请求
 * @param {Object} taskData - 任务数据
 * @returns {Promise<string>} - 确认ID
 */
export async function sendTaskConfirmation(taskData) {
  const confirmId = `confirm:${taskData.id}`;
  const timestamp = Date.now();
  
  // 构建确认消息
  const message = `🔔 新任务待确认

📋 任务信息：
- 来自：${taskData.from}
- 任务：${taskData.task}
- 类型：${taskData.taskType || 'unknown'}
- 优先级：${taskData.priority || 'normal'}
- 时间：${new Date().toLocaleString('zh-CN')}

⚠️ 此任务不在自动执行白名单中

请选择操作（回复数字）：
1️⃣ 执行一次
2️⃣ 执行并加入白名单  
3️⃣ 拒绝执行

⏰ 确认超时：5分钟
💡 回复格式：${taskData.id}:1 或 ${taskData.id}:2 或 ${taskData.id}:3`;

  // 发送消息
  await sendFeishuMessage(message);
  
  // 在Redis中创建确认记录
  await redisSet(confirmId, JSON.stringify({
    taskId: taskData.id,
    task: taskData.task,
    from: taskData.from,
    status: 'pending', // pending, confirmed, rejected, timeout
    createdAt: timestamp,
    expiresAt: timestamp + 5 * 60 * 1000, // 5分钟过期
    response: null
  }), 300); // 5分钟TTL
  
  console.log(`[Confirm] Created confirmation: ${confirmId}`);
  return confirmId;
}

/**
 * 检查用户确认响应
 * @param {string} confirmId - 确认ID
 * @returns {Promise<Object|null>} - 确认结果
 */
export async function checkConfirmation(confirmId) {
  const data = await redisGet(confirmId);
  if (!data) return null;
  
  return JSON.parse(data);
}

/**
 * 等待用户确认（带超时）
 * @param {string} confirmId - 确认ID  
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @returns {Promise<Object>} - 确认结果
 */
export async function waitForConfirmation(confirmId, timeoutMs = 300000) {
  const startTime = Date.now();
  const pollInterval = 5000; // 每5秒检查一次
  
  console.log(`[Confirm] Waiting for response: ${confirmId} (${timeoutMs}ms timeout)`);
  
  return new Promise((resolve) => {
    const check = async () => {
      const elapsed = Date.now() - startTime;
      
      if (elapsed >= timeoutMs) {
        console.log(`[Confirm] Timeout: ${confirmId}`);
        await redisDel(confirmId);
        resolve({ confirmed: false, reason: 'timeout' });
        return;
      }
      
      const response = await checkConfirmation(confirmId);
      if (!response) {
        resolve({ confirmed: false, reason: 'not_found' });
        return;
      }
      
      if (response.status === 'confirmed') {
        console.log(`[Confirm] Confirmed: ${confirmId}`);
        resolve({ 
          confirmed: true, 
          addToWhitelist: response.addToWhitelist,
          response: response.response 
        });
        return;
      }
      
      if (response.status === 'rejected') {
        console.log(`[Confirm] Rejected: ${confirmId}`);
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
 * 处理用户确认响应（由外部调用）
 * @param {string} confirmId - 确认ID
 * @param {string} response - 响应内容（1, 2, 3）
 */
export async function handleUserResponse(confirmId, response) {
  const data = await checkConfirmation(confirmId);
  if (!data) {
    return { success: false, error: 'Confirmation not found or expired' };
  }
  
  if (data.status !== 'pending') {
    return { success: false, error: 'Already responded' };
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
      return { success: false, error: 'Invalid response' };
  }
  
  // 更新确认记录
  data.status = status;
  data.addToWhitelist = addToWhitelist;
  data.response = response;
  data.respondedAt = Date.now();
  
  await redisSet(confirmId, JSON.stringify(data), 300);
  
  return { 
    success: true, 
    status,
    addToWhitelist,
    taskId: data.taskId 
  };
}

// Redis 操作封装
async function redisSet(key, value, ttlSeconds) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} SETEX ${key} ${ttlSeconds} '${value.replace(/'/g, "'\\''")}'`;
    
    const child = spawn('sh', ['-c', cmd]);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`Redis SETEX failed: ${code}`));
    });
  });
}

async function redisGet(key) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} GET ${key}`;
    
    const child = spawn('sh', ['-c', cmd]);
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim() || null);
      else reject(new Error(`Redis GET failed: ${code}`));
    });
  });
}

async function redisDel(key) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} DEL ${key}`;
    
    const child = spawn('sh', ['-c', cmd]);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`Redis DEL failed: ${code}`));
    });
  });
}

// 测试代码
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Testing Feishu notifier...');
  
  // 测试发送确认
  sendTaskConfirmation({
    id: 'test123',
    from: '韩国虾',
    task: '测试任务',
    taskType: 'test',
    priority: 'high'
  }).then(confirmId => {
    console.log('Confirm ID:', confirmId);
  });
}
