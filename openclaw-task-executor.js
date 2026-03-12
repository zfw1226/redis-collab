#!/usr/bin/env node
/**
 * OpenClaw Task Executor - 简单执行器
 * 
 * 查询当前待处理的任务列表，输出为JSON格式供主智能体处理
 * 使用方式: node openclaw-task-executor.js
 */

import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_HOST = process.env.REDIS_HOST || '43.131.241.215';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  maxRetriesPerRequest: 3
});

async function main() {
  const command = process.argv[2];
  
  if (command === 'list') {
    // List pending executions
    const keys = await redis.keys('execution:*');
    console.log('Pending executions:');
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) {
        const task = JSON.parse(data);
        console.log(`- ${task.id}: ${task.task?.substring(0, 50)}... [${task.status}]`);
      }
    }
  } 
  else if (command === 'get') {
    // Get specific execution
    const taskId = process.argv[3];
    const key = `execution:${taskId}`;
    const data = await redis.get(key);
    if (data) {
      const task = JSON.parse(data);
      console.log(JSON.stringify(task, null, 2));
    } else {
      console.log('Task not found');
    }
  }
  else if (command === 'complete') {
    // Complete an execution with result
    const taskId = process.argv[3];
    const resultFile = process.argv[4];
    
    const key = `execution:${taskId}`;
    const data = await redis.get(key);
    
    if (data) {
      const task = JSON.parse(data);
      task.status = 'completed';
      task.result = fs.readFileSync(resultFile, 'utf8');
      task.completedAt = new Date().toISOString();
      task.tools_used = ['web_search', 'browser'];
      
      await redis.setex(key, 3600, JSON.stringify(task));
      console.log(`✅ Task ${taskId} completed`);
    } else {
      console.log('Task not found');
    }
  }
  else if (command === 'fail') {
    // Mark execution as failed
    const taskId = process.argv[3];
    const error = process.argv[4] || 'Unknown error';
    
    const key = `execution:${taskId}`;
    const data = await redis.get(key);
    
    if (data) {
      const task = JSON.parse(data);
      task.status = 'failed';
      task.error = error;
      task.failedAt = new Date().toISOString();
      
      await redis.setex(key, 3600, JSON.stringify(task));
      console.log(`❌ Task ${taskId} marked as failed`);
    } else {
      console.log('Task not found');
    }
  }
  else {
    console.log(`
OpenClaw Task Executor

Usage:
  node openclaw-task-executor.js list
    - List all pending executions

  node openclaw-task-executor.js get <task-id>
    - Get specific execution details

  node openclaw-task-executor.js complete <task-id> <result-file>
    - Complete an execution with result from file

  node openclaw-task-executor.js fail <task-id> [error-message]
    - Mark execution as failed
    `);
  }
  
  redis.disconnect();
}

main().catch(console.error);
