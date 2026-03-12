#!/usr/bin/env node
// executor.js - Subagent 执行脚本
// 由 task-processor 通过 sessions_spawn 启动

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从环境变量获取任务数据
const TASK_DATA = process.env.TASK_DATA ? JSON.parse(process.env.TASK_DATA) : null;
const REDIS_HOST = process.env.REDIS_HOST || '43.131.241.215';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const AGENT_NAME = process.env.AGENT_NAME || 'MacStudio-本地';

if (!TASK_DATA) {
  console.error('❌ No TASK_DATA provided');
  process.exit(1);
}

console.log(`[Executor] Starting task: ${TASK_DATA.id}`);
console.log(`[Executor] Task content: ${TASK_DATA.task}`);

// Redis 命令封装
function redisCmd(...args) {
  const cmd = ['redis-cli', '-h', REDIS_HOST, '-p', REDIS_PORT, '-a', REDIS_PASSWORD, ...args];
  return execSync(cmd.join(' '), { encoding: 'utf8', timeout: 10000 });
}

// 执行任务（根据类型）
async function executeTask(task) {
  const taskLower = task.toLowerCase();
  
  // 搜索类任务
  if (taskLower.includes('搜索') || taskLower.includes('小红书') || taskLower.includes('search')) {
    console.log('[Executor] Executing search task via Agent Reach...');
    
    try {
      // 提取搜索关键词
      let keyword = task.replace(/.*搜索/, '').replace(/关于/, '').trim();
      if (!keyword) keyword = task;
      
      // 调用 Agent Reach
      const result = execSync(
        `${__dirname}/../agent-reach/bin/ara search-xhs "${keyword}" 2>&1`,
        { encoding: 'utf8', timeout: 120000 }
      );
      
      return {
        success: true,
        type: 'search',
        result: result,
        summary: `搜索完成，找到相关结果`
      };
    } catch (e) {
      return {
        success: false,
        type: 'search',
        error: e.message,
        result: '搜索执行失败'
      };
    }
  }
  
  // 文件读取类任务
  if (taskLower.includes('读取') || taskLower.includes('read') || taskLower.includes('文件')) {
    console.log('[Executor] Executing file read task...');
    
    try {
      // 尝试提取文件路径
      const pathMatch = task.match(/[~.\/]?[\w\/]+\.[\w]+/);
      if (pathMatch) {
        const filePath = pathMatch[0].startsWith('~') 
          ? process.env.HOME + pathMatch[0].slice(1)
          : pathMatch[0];
        
        const content = fs.readFileSync(filePath, 'utf8').substring(0, 1000);
        return {
          success: true,
          type: 'file_read',
          result: content,
          summary: `成功读取文件: ${path.basename(filePath)}`
        };
      }
      
      return {
        success: false,
        type: 'file_read',
        error: '无法识别文件路径',
        result: '任务执行失败'
      };
    } catch (e) {
      return {
        success: false,
        type: 'file_read',
        error: e.message,
        result: '文件读取失败'
      };
    }
  }
  
  // 默认任务
  return {
    success: true,
    type: 'default',
    result: `任务已接收: ${task}`,
    summary: '任务类型未识别，默认处理完成'
  };
}

// 上报结果到 Redis
function reportResult(result) {
  const resultData = {
    taskId: TASK_DATA.id,
    from: AGENT_NAME,
    to: TASK_DATA.from,
    ...result,
    timestamp: new Date().toISOString()
  };
  
  // 1. 写入结果队列给发送方
  redisCmd('RPUSH', `results:${TASK_DATA.from}`, JSON.stringify(resultData));
  console.log(`[Executor] Result written to results:${TASK_DATA.from}`);
  
  // 2. 写入通知队列（Main Agent 会处理飞书发送）
  const notification = {
    type: result.success ? 'task_completed' : 'task_failed',
    task: TASK_DATA.task.substring(0, 100),
    result: result.result?.substring(0, 500),
    error: result.error,
    to: TASK_DATA.from,
    timestamp: new Date().toISOString()
  };
  
  redisCmd('RPUSH', `notifications:${AGENT_NAME}`, JSON.stringify(notification));
  console.log(`[Executor] Notification queued for Main Agent`);
}

// 主执行流程
async function main() {
  console.log('[Executor] Subagent started');
  
  try {
    const result = await executeTask(TASK_DATA.task);
    reportResult(result);
    
    if (result.success) {
      console.log('[Executor] ✅ Task completed successfully');
      process.exit(0);
    } else {
      console.log('[Executor] ❌ Task failed:', result.error);
      process.exit(1);
    }
  } catch (e) {
    console.error('[Executor] Fatal error:', e.message);
    reportResult({
      success: false,
      error: e.message,
      result: '执行器异常退出'
    });
    process.exit(1);
  }
}

main();
