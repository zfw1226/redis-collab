// openclaw-feishu-agent.js - OpenClaw 飞书代理
// 由 Main Agent 运行，轮询 Redis 队列并发送飞书消息
// 同时接收飞书回复并写入 Redis

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || '43.131.241.215',
  port: process.env.REDIS_PORT || '6379',
  password: process.env.REDIS_PASSWORD
};

// 队列名称
const SEND_QUEUE = 'feishu:send:queue';      // Skill → OpenClaw
const REPLY_QUEUE = 'feishu:reply:queue';    // OpenClaw → Skill

/**
 * 从 Redis 获取待发送消息
 * 使用 BRPOP 阻塞等待，有消息时立即返回
 */
async function getPendingMessage(timeout = 5) {
  const { spawn } = await import('child_process');
  
  return new Promise((resolve) => {
    // BRPOP 阻塞等待消息
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} BRPOP ${SEND_QUEUE} ${timeout}`;
    
    const child = spawn('sh', ['-c', cmd]);
    let stdout = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.on('close', () => {
      const lines = stdout.trim().split('\n');
      if (lines.length >= 2) {
        try {
          const message = JSON.parse(lines[1]);
          resolve(message);
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
 * 发送飞书消息（调用 OpenClaw message 工具）
 * @param {Object} message - 消息对象
 */
async function sendToFeishu(message) {
  console.log(`[Feishu Agent] Sending message: ${message.id}`);
  console.log(`[Feishu Agent] Content preview:\n${message.content.substring(0, 200)}...`);
  
  // 这里实际调用 OpenClaw 的 message 工具
  // 由于在这个脚本中无法直接调用，我们输出到控制台
  // Main Agent 可以监控输出或使用其他方式
  
  // 方案：写入文件触发外部发送
  const fs = await import('fs');
  const triggerFile = `/tmp/feishu-send-${message.id}.json`;
  fs.writeFileSync(triggerFile, JSON.stringify(message, null, 2));
  
  console.log(`[Feishu Agent] Trigger file created: ${triggerFile}`);
  console.log(`[Feishu Agent] ⚠️  需要 OpenClaw Main Agent 使用 message 工具实际发送`);
  
  return { success: true, triggerFile };
}

/**
 * 处理用户回复（从外部接收）
 * @param {string} taskId - 任务 ID
 * @param {string} response - 用户回复（1, 2, 3）
 */
async function handleUserResponse(taskId, response) {
  const { spawn } = await import('child_process');
  
  const replyData = {
    type: 'user_reply',
    taskId,
    response,
    timestamp: Date.now()
  };
  
  return new Promise((resolve) => {
    const cmd = `redis-cli -h ${REDIS_CONFIG.host} -p ${REDIS_CONFIG.port} -a ${REDIS_CONFIG.password} LPUSH ${REPLY_QUEUE} '${JSON.stringify(replyData).replace(/'/g, "'\\''")}'`;
    
    const child = spawn('sh', ['-c', cmd]);
    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[Feishu Agent] User response recorded: ${taskId} = ${response}`);
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}

/**
 * 主循环：处理消息发送
 */
async function mainLoop() {
  console.log('[Feishu Agent] Starting OpenClaw Feishu Bridge Agent...');
  console.log(`[Feishu Agent] Redis: ${REDIS_CONFIG.host}:${REDIS_CONFIG.port}`);
  console.log(`[Feishu Agent] Monitoring queue: ${SEND_QUEUE}`);
  
  while (true) {
    try {
      // 阻塞等待消息（5秒超时）
      const message = await getPendingMessage(5);
      
      if (message) {
        console.log(`\n[Feishu Agent] New message received: ${message.type}`);
        await sendToFeishu(message);
      }
      
      // 短暂休眠避免CPU占用过高
      await new Promise(r => setTimeout(r, 100));
      
    } catch (e) {
      console.error('[Feishu Agent] Error:', e.message);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

/**
 * 模拟用户回复（测试用）
 */
async function simulateUserReply(taskId, response) {
  console.log(`[Feishu Agent] Simulating user reply: ${taskId} -> ${response}`);
  await handleUserResponse(taskId, response);
}

// 导出供外部使用
export { getPendingMessage, sendToFeishu, handleUserResponse, simulateUserReply };

// 如果直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === '--simulate' && process.argv[3] && process.argv[4]) {
    // 模拟用户回复: node openclaw-feishu-agent.js --simulate taskId response
    simulateUserReply(process.argv[3], process.argv[4]).then(() => process.exit(0));
  } else {
    // 正常运行
    mainLoop();
  }
}
