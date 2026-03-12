#!/usr/bin/env node
/**
 * OpenClaw Execution Listener
 * 
 * 监听 Redis 中的执行任务，调用 OpenClaw 智能体完成
 * 运行方式: node openclaw-execution-listener.js
 */

import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_HOST = process.env.REDIS_HOST || '43.131.241.215';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'OpenClaw2026!';

console.log('🔔 OpenClaw Execution Listener Starting...');
console.log(`Redis: ${REDIS_HOST}:${REDIS_PORT}`);

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  maxRetriesPerRequest: 3
});

const subscriber = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD
});

// Subscribe to execution channel
subscriber.subscribe('openclaw:execution', (err) => {
  if (err) {
    console.error('❌ Failed to subscribe:', err.message);
    process.exit(1);
  }
  console.log('✅ Subscribed to openclaw:execution channel');
});

// Handle incoming execution requests
subscriber.on('message', async (channel, message) => {
  console.log(`\n📨 Received message on ${channel}`);
  
  try {
    const data = JSON.parse(message);
    const { id, executionKey } = data;
    
    console.log(`📝 Processing task: ${id}`);
    
    // Get task details from Redis
    const taskData = await redis.get(executionKey);
    if (!taskData) {
      console.error(`❌ Task ${id} not found in Redis`);
      return;
    }
    
    const task = JSON.parse(taskData);
    console.log(`🎯 Task content: ${task.task.substring(0, 100)}...`);
    
    // Update status to processing
    task.status = 'processing';
    await redis.setex(executionKey, 3600, JSON.stringify(task));
    
    // Write task to a file that OpenClaw can detect
    // This is a simple way to communicate with the main OpenClaw instance
    const taskFile = path.join(__dirname, 'pending-tasks', `${id}.json`);
    
    // Ensure directory exists
    const pendingDir = path.join(__dirname, 'pending-tasks');
    if (!fs.existsSync(pendingDir)) {
      fs.mkdirSync(pendingDir, { recursive: true });
    }
    
    // Write task file
    fs.writeFileSync(taskFile, JSON.stringify({
      id: id,
      task: task.task,
      from: task.from,
      prompt: task.prompt,
      executionKey: executionKey,
      receivedAt: new Date().toISOString()
    }, null, 2));
    
    console.log(`💾 Task saved to: ${taskFile}`);
    console.log(`⏳ Waiting for OpenClaw to process...`);
    
    // The actual execution will be done by the main OpenClaw instance
    // which monitors this file or is triggered by other means
    
  } catch (error) {
    console.error('❌ Error processing message:', error.message);
  }
});

// Also poll for pending executions (in case we missed the pub/sub)
async function pollPendingExecutions() {
  try {
    const keys = await redis.keys('execution:*');
    
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const task = JSON.parse(data);
        if (task.status === 'pending') {
          console.log(`\n🔍 Found pending task in poll: ${task.id}`);
          
          // Trigger the same processing
          const taskFile = path.join(__dirname, 'pending-tasks', `${task.id}.json`);
          const pendingDir = path.join(__dirname, 'pending-tasks');
          
          if (!fs.existsSync(pendingDir)) {
            fs.mkdirSync(pendingDir, { recursive: true });
          }
          
          if (!fs.existsSync(taskFile)) {
            fs.writeFileSync(taskFile, JSON.stringify({
              id: task.id,
              task: task.task,
              from: task.from,
              prompt: task.prompt,
              executionKey: key,
              receivedAt: new Date().toISOString()
            }, null, 2));
            
            console.log(`💾 Task saved to: ${taskFile}`);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Poll error:', error.message);
  }
}

// Poll every 30 seconds
setInterval(pollPendingExecutions, 30000);
console.log('🔄 Polling for pending tasks every 30s');

// Initial poll
pollPendingExecutions();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  redis.disconnect();
  subscriber.disconnect();
  process.exit(0);
});

console.log('\n✅ OpenClaw Execution Listener is running');
console.log('Press Ctrl+C to stop\n');
