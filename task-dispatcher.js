#!/usr/bin/env node
/**
 * Redis Collab Task Dispatcher
 * 
 * 主Agent使用此脚本检查待派发的任务，并派生sub-agent执行
 * 
 * 使用方式:
 *   node task-dispatcher.js list       # 列出待派发的任务
 *   node task-dispatcher.js dispatch   # 返回需要派生sub-agent的任务详情
 *   node task-dispatcher.js status     # 查看所有任务状态
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

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
  maxRetriesPerRequest: 3
});

async function listPendingTasks() {
  console.log('🔍 Checking for tasks that need sub-agent dispatch...\n');
  
  const keys = await redis.keys('execution:*');
  const pendingDispatches = [];
  const processing = [];
  const completed = [];
  
  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      const exec = JSON.parse(data);
      
      if (exec.status === 'processing' && exec.processingBy === 'sub-agent') {
        // Check if local files exist
        if (exec.taskDir && fs.existsSync(exec.taskDir)) {
          const resultFile = path.join(exec.taskDir, 'task.txt.result');
          if (fs.existsSync(resultFile)) {
            // Sub-agent completed
            completed.push({
              id: exec.id,
              task: exec.task?.substring(0, 60),
              from: exec.from,
              completedAt: exec.completedAt || 'unknown'
            });
          } else {
            // Waiting for sub-agent
            pendingDispatches.push({
              id: exec.id,
              task: exec.task?.substring(0, 60),
              from: exec.from,
              taskDir: exec.taskDir,
              spawnedAt: exec.spawnedAt
            });
          }
        }
      } else if (exec.status === 'completed') {
        completed.push({
          id: exec.id,
          task: exec.task?.substring(0, 60),
          from: exec.from
        });
      } else if (exec.status === 'processing') {
        processing.push({
          id: exec.id,
          status: exec.status
        });
      }
    }
  }
  
  console.log(`📊 Summary:`);
  console.log(`   Pending dispatch: ${pendingDispatches.length}`);
  console.log(`   Processing: ${processing.length}`);
  console.log(`   Completed: ${completed.length}\n`);
  
  if (pendingDispatches.length > 0) {
    console.log(`📋 Tasks waiting for sub-agent dispatch:`);
    pendingDispatches.forEach((t, i) => {
      console.log(`\n${i + 1}. Task ID: ${t.id}`);
      console.log(`   From: ${t.from}`);
      console.log(`   Task: ${t.task}...`);
      console.log(`   Directory: ${t.taskDir}`);
    });
  }
  
  return pendingDispatches;
}

async function dispatchTasks() {
  const pending = await listPendingTasks();
  
  if (pending.length === 0) {
    console.log('\n✅ No tasks need dispatch');
    return { action: 'none' };
  }
  
  // Return first task for dispatch
  const task = pending[0];
  const promptFile = path.join(task.taskDir, 'prompt.txt');
  const taskFile = path.join(task.taskDir, 'task.txt');
  const metaFile = path.join(task.taskDir, 'meta.json');
  
  let prompt = '';
  let taskContent = '';
  let meta = {};
  
  if (fs.existsSync(promptFile)) {
    prompt = fs.readFileSync(promptFile, 'utf8');
  }
  if (fs.existsSync(taskFile)) {
    taskContent = fs.readFileSync(taskFile, 'utf8');
  }
  if (fs.existsSync(metaFile)) {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  }
  
  const dispatchInfo = {
    action: 'spawn_subagent',
    task: {
      id: task.id,
      content: taskContent,
      from: task.from,
      priority: meta.priority || 'normal'
    },
    files: {
      prompt: promptFile,
      task: taskFile,
      meta: metaFile,
      output: path.join(task.taskDir, 'task.txt.result'),
      tools: path.join(task.taskDir, 'tools.json')
    },
    instructions: `
请使用 sessions_spawn 派生一个 sub-agent 执行此任务。

任务文件位置: ${task.taskDir}
- task.txt: 任务描述
- prompt.txt: 系统提示词
- meta.json: 任务元数据

Sub-agent 执行要求:
1. 读取 task.txt 了解任务内容
2. 根据任务自动选择工具 (browser/web_search/feishu_doc等)
3. 完成任务后，将结果写入 ${path.join(task.taskDir, 'task.txt.result')}
4. 记录使用的工具到 ${path.join(task.taskDir, 'tools.json')} (JSON格式: {"tools": ["tool1", "tool2"]}}
5. 完成后退出

主 Agent 会在 sub-agent 完成后检测到结果并返回给 Redis。
    `
  };
  
  console.log('\n' + '='.repeat(60));
  console.log('DISPATCH INFO (for main agent):');
  console.log('='.repeat(60));
  console.log(JSON.stringify(dispatchInfo, null, 2));
  
  return dispatchInfo;
}

async function showStatus() {
  const keys = await redis.keys('execution:*');
  
  console.log('📊 All Execution Status:\n');
  
  for (const key of keys) {
    const data = await redis.get(key);
    if (data) {
      const exec = JSON.parse(data);
      console.log(`Task: ${exec.id}`);
      console.log(`  Status: ${exec.status}`);
      console.log(`  From: ${exec.from}`);
      console.log(`  Task: ${exec.task?.substring(0, 50)}...`);
      if (exec.processingBy) console.log(`  Processing By: ${exec.processingBy}`);
      if (exec.result) console.log(`  Has Result: ✓`);
      console.log();
    }
  }
}

async function main() {
  const command = process.argv[2];
  
  try {
    switch (command) {
      case 'list':
        await listPendingTasks();
        break;
      case 'dispatch':
        await dispatchTasks();
        break;
      case 'status':
        await showStatus();
        break;
      default:
        console.log(`
Redis Collab Task Dispatcher

Usage:
  node task-dispatcher.js list     # List tasks waiting for dispatch
  node task-dispatcher.js dispatch # Get dispatch info for main agent
  node task-dispatcher.js status   # Show all execution status
        `);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    redis.disconnect();
  }
}

main();
