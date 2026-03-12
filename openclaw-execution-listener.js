#!/usr/bin/env node
/**
 * OpenClaw Execution Listener
 * 
 * 监听 Redis 中的执行任务，调用 OpenClaw agent 执行任务
 * 运行方式: node openclaw-execution-listener.js
 */

import Redis from 'ioredis';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

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

// Function to execute task via openclaw agent
function executeTaskViaAgent(taskData) {
  return new Promise((resolve, reject) => {
    const taskId = taskData.id;
    const taskContent = taskData.task;
    const from = taskData.from;
    
    console.log(`🚀 Executing task via OpenClaw agent: ${taskId}`);
    console.log(`📝 Task: ${taskContent.substring(0, 50)}...`);
    
    // Build the prompt
    const prompt = taskContent;
    
    // Use openclaw agent with --agent main to use the main agent
    const args = [
      'agent',
      '--agent', 'main',
      '--message', prompt,
      '--json',
      '--timeout', '300'
    ];
    
    console.log(`📞 Running: openclaw ${args.join(' ')}`);
    
    const child = spawn('openclaw', args, {
      cwd: process.env.HOME || '/root',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      console.log(`📬 Agent finished with code: ${code}`);
      
      if (stdout) {
        console.log(`📄 Output: ${stdout.substring(0, 200)}...`);
      }
      
      if (code === 0) {
        // Try to parse JSON response
        try {
          const result = JSON.parse(stdout);
          resolve({ 
            success: true, 
            result: result.message || result.content || stdout.substring(0, 1000),
            raw: result
          });
        } catch (e) {
          resolve({ 
            success: true, 
            result: stdout.substring(0, 1000) 
          });
        }
      } else {
        console.error(`❌ Error: ${stderr}`);
        resolve({ 
          success: false, 
          error: stderr || 'Unknown error',
          code 
        });
      }
    });
    
    child.on('error', (err) => {
      console.error(`❌ Failed to spawn: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
  });
}

// Handle incoming execution requests
subscriber.on('message', async (channel, message) => {
  console.log(`\n📨 Received message on ${channel}`);
  
  try {
    const data = JSON.parse(message);
    const { id, executionKey } = data;
    
    if (!executionKey) {
      console.log('⚠️ No executionKey, skipping');
      return;
    }
    
    console.log(`📝 Processing task: ${id}`);
    
    // Get task details from Redis
    const taskDataStr = await redis.get(executionKey);
    if (!taskDataStr) {
      console.error(`❌ Task ${id} not found in Redis`);
      return;
    }
    
    const taskData = JSON.parse(taskDataStr);
    console.log(`🎯 Task content: ${taskData.task?.substring(0, 50) || 'unknown'}...`);
    
    // Update status to processing
    taskData.status = 'processing';
    await redis.setex(executionKey, 3600, JSON.stringify(taskData));
    
    // Execute via OpenClaw agent
    const result = await executeTaskViaAgent(taskData);
    
    // Update result
    taskData.status = result.success ? 'completed' : 'failed';
    taskData.result = result.result || result.error;
    taskData.completedAt = new Date().toISOString();
    
    await redis.setex(executionKey, 3600, JSON.stringify(taskData));
    
    if (result.success) {
      console.log(`✅ Task ${id} completed successfully`);
    } else {
      console.error(`❌ Task ${id} failed: ${result.error}`);
    }
    
  } catch (error) {
    console.error('❌ Error processing message:', error.message);
  }
});

console.log('\n✅ OpenClaw Execution Listener is running');

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  redis.disconnect();
  subscriber.disconnect();
  process.exit(0);
});
