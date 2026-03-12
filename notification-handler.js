// notification-handler.js - Main Agent 轮询处理 Redis 通知
// 由 Main Agent (OpenClaw) 调用，处理飞书消息发送

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Redis 配置
const REDIS_HOST = process.env.REDIS_HOST || '43.131.241.215';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'OpenClaw2026!';
const AGENT_NAME = process.env.AGENT_NAME || 'MacStudio-本地';

// 通知队列 key
const NOTIFICATION_KEY = `notifications:${AGENT_NAME}`;

// 使用 redis-cli 获取通知
async function getNotifications() {
  try {
    const { stdout } = await execAsync(
      `redis-cli -h ${REDIS_HOST} -p ${REDIS_PORT} -a ${REDIS_PASSWORD} LRANGE ${NOTIFICATION_KEY} 0 -1`,
      { timeout: 5000 }
    );
    
    if (!stdout || stdout.trim() === '') return [];
    
    return stdout.trim().split('\n').filter(x => x).map(str => {
      try {
        return JSON.parse(str);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.error('[Notification] Failed to get notifications:', e.message);
    return [];
  }
}

// 清空通知队列
async function clearNotifications() {
  try {
    await execAsync(
      `redis-cli -h ${REDIS_HOST} -p ${REDIS_PORT} -a ${REDIS_PASSWORD} DEL ${NOTIFICATION_KEY}`,
      { timeout: 5000 }
    );
  } catch (e) {
    console.error('[Notification] Failed to clear notifications:', e.message);
  }
}

// 格式化飞书消息
function formatFeishuMessage(notification) {
  const { type, task, result, error, to, timestamp } = notification;
  
  switch (type) {
    case 'task_completed':
      return `✅ 任务执行完成\n\n` +
             `📋 任务: ${task}\n` +
             `👤 发送给: ${to}\n` +
             `📊 结果: ${result?.substring(0, 200) || '无'}${result?.length > 200 ? '...' : ''}\n` +
             `⏰ 时间: ${new Date(timestamp).toLocaleString('zh-CN')}`;
    
    case 'task_failed':
      return `❌ 任务执行失败\n\n` +
             `📋 任务: ${task}\n` +
             `👤 发送给: ${to}\n` +
             `⚠️ 错误: ${error}\n` +
             `⏰ 时间: ${new Date(timestamp).toLocaleString('zh-CN')}`;
    
    case 'new_task_confirm':
      return `🔔 新任务待确认\n\n` +
             `📋 任务: ${task}\n` +
             `👤 来自: ${to}\n` +
             `⚠️ 此任务不在白名单中，请确认是否执行\n` +
             `⏰ 时间: ${new Date(timestamp).toLocaleString('zh-CN')}`;
    
    default:
      return `📢 通知: ${JSON.stringify(notification)}`;
  }
}

// 处理通知（此函数会被 Main Agent 定期调用）
export async function processPendingNotifications() {
  const notifications = await getNotifications();
  
  if (notifications.length === 0) {
    return { count: 0, messages: [] };
  }
  
  console.log(`[Notification] Processing ${notifications.length} notifications`);
  
  const messages = [];
  for (const notif of notifications) {
    const message = formatFeishuMessage(notif);
    messages.push(message);
    console.log('[Notification] Formatted message:', message.substring(0, 100) + '...');
  }
  
  // 清空已处理的通知
  await clearNotifications();
  
  return { count: notifications.length, messages };
}

// 如果直接运行此脚本，执行一次处理
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await processPendingNotifications();
  console.log('Processed notifications:', result.count);
  if (result.messages.length > 0) {
    console.log('Messages to send:');
    result.messages.forEach((msg, i) => {
      console.log(`\n--- Message ${i + 1} ---`);
      console.log(msg);
    });
  }
}
