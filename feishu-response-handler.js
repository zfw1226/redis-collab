#!/usr/bin/env node
// feishu-response-handler.js - 处理飞书用户响应
// 由 Main Agent 定期调用或作为独立服务运行

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || '43.131.241.215',
  port: process.env.REDIS_PORT || '6379',
  password: process.env.REDIS_PASSWORD || 'OpenClaw2026!'
};

const RESPONSE_DIR = '/tmp/feishu-responses';

// 确保响应目录存在
if (!fs.existsSync(RESPONSE_DIR)) {
  fs.mkdirSync(RESPONSE_DIR, { recursive: true });
}

/**
 * 解析用户响应
 * 格式: taskId:response (例如: abc123:1)
 * @param {string} text - 用户输入文本
 * @returns {Object|null} - 解析结果
 */
function parseUserResponse(text) {
  // 支持多种格式：
  // 1. 纯数字: "1", "2", "3"
  // 2. taskId:数字: "abc123:1"
  // 3. 数字+空格: "1 执行一次"
  
  const trimmed = text.trim();
  
  // 检查是否是纯数字
  if (/^[123]$/.test(trimmed)) {
    return { taskId: null, response: trimmed };
  }
  
  // 检查 taskId:数字 格式
  const match = trimmed.match(/^([a-zA-Z0-9_-]+):([123])$/);
  if (match) {
    return { taskId: match[1], response: match[2] };
  }
  
  // 检查 数字+其他内容 格式
  const numMatch = trimmed.match(/^([123])\s/);
  if (numMatch) {
    return { taskId: null, response: numMatch[1] };
  }
  
  return null;
}

/**
 * 查找待确认的task
 * @param {string} taskId - 可选，指定taskId
 * @returns {Promise<Array>} - 待确认列表
 */
async function findPendingConfirmations(taskId = null) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve, reject) => {
    const pattern = taskId ? `confirm:${taskId}` : 'confirm:*';
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} KEYS ${pattern}`;
    
    const child = spawn('sh', ['-c', cmd]);
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', (code) => {
      if (code === 0) {
        const keys = stdout.trim().split('\n').filter(k => k);
        resolve(keys);
      } else {
        resolve([]);
      }
    });
  });
}

/**
 * 获取确认详情
 * @param {string} confirmKey - Redis key
 * @returns {Promise<Object|null>}
 */
async function getConfirmationData(confirmKey) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve, reject) => {
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} GET ${confirmKey}`;
    
    const child = spawn('sh', ['-c', cmd]);
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * 更新确认状态
 * @param {string} confirmKey - Redis key
 * @param {Object} data - 更新数据
 */
async function updateConfirmation(confirmKey, data) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve, reject) => {
    const ttl = 300; // 5分钟
    const value = JSON.stringify(data).replace(/'/g, "'\\''");
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} SETEX ${confirmKey} ${ttl} '${value}'`;
    
    const child = spawn('sh', ['-c', cmd]);
    child.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * 处理用户响应文件
 * @param {string} filePath - 响应文件路径
 */
async function processResponseFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseUserResponse(content);
    
    if (!parsed) {
      console.log('[Response] Invalid format:', content);
      fs.unlinkSync(filePath);
      return;
    }
    
    console.log('[Response] Parsed:', parsed);
    
    // 查找待确认的任务
    let confirmKeys;
    if (parsed.taskId) {
      confirmKeys = await findPendingConfirmations(parsed.taskId);
    } else {
      // 如果没有指定taskId，找最新的待确认任务
      confirmKeys = await findPendingConfirmations();
      if (confirmKeys.length > 1) {
        console.log('[Response] Multiple pending confirmations, need taskId');
        fs.unlinkSync(filePath);
        return;
      }
    }
    
    if (confirmKeys.length === 0) {
      console.log('[Response] No pending confirmations found');
      fs.unlinkSync(filePath);
      return;
    }
    
    // 处理每个待确认任务
    for (const confirmKey of confirmKeys) {
      const confirmData = await getConfirmationData(confirmKey);
      if (!confirmData || confirmData.status !== 'pending') continue;
      
      // 更新确认状态
      const response = parsed.response;
      let status = 'rejected';
      let addToWhitelist = false;
      
      switch (response) {
        case '1':
          status = 'confirmed';
          addToWhitelist = false;
          console.log(`[Response] Task ${confirmData.taskId} confirmed (once)`);
          break;
        case '2':
          status = 'confirmed';
          addToWhitelist = true;
          console.log(`[Response] Task ${confirmData.taskId} confirmed (add to whitelist)`);
          break;
        case '3':
          status = 'rejected';
          console.log(`[Response] Task ${confirmData.taskId} rejected`);
          break;
      }
      
      confirmData.status = status;
      confirmData.addToWhitelist = addToWhitelist;
      confirmData.response = response;
      confirmData.respondedAt = Date.now();
      
      await updateConfirmation(confirmKey, confirmData);
    }
    
    // 删除已处理的文件
    fs.unlinkSync(filePath);
    
  } catch (e) {
    console.error('[Response] Error processing file:', e.message);
  }
}

/**
 * 扫描并处理响应文件
 */
async function scanResponseFiles() {
  try {
    const files = fs.readdirSync(RESPONSE_DIR);
    const responseFiles = files.filter(f => f.startsWith('response-'));
    
    for (const file of responseFiles) {
      const filePath = path.join(RESPONSE_DIR, file);
      console.log('[Response] Processing:', file);
      await processResponseFile(filePath);
    }
  } catch (e) {
    console.error('[Response] Scan error:', e.message);
  }
}

/**
 * 创建模拟用户响应（测试用）
 * @param {string} taskId - 任务ID
 * @param {string} response - 响应（1, 2, 3）
 */
export function createMockResponse(taskId, response) {
  const filename = `response-${Date.now()}.txt`;
  const filepath = path.join(RESPONSE_DIR, filename);
  fs.writeFileSync(filepath, `${taskId}:${response}`, 'utf8');
  console.log('[Response] Mock response created:', filepath);
}

// 主循环
export async function startResponseHandler() {
  console.log('[Response] Starting handler...');
  
  // 每5秒扫描一次响应文件
  setInterval(scanResponseFiles, 5000);
  
  // 立即执行一次
  scanResponseFiles();
}

// 如果直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  startResponseHandler();
}
