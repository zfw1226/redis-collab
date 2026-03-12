#!/usr/bin/env node
// test-feishu-confirm.js - 测试飞书确认流程

import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function test() {
  console.log('=== Testing Feishu Confirmation Flow ===\n');
  
  // 1. 测试发送确认请求
  console.log('1. Sending confirmation request...');
  const { sendTaskConfirmation } = await import('./feishu-notifier.js');
  
  const taskData = {
    id: 'test-' + Date.now(),
    from: '韩国虾',
    task: '搜索小红书关于AI工具的最新推荐',
    taskType: 'search',
    priority: 'high'
  };
  
  const confirmId = await sendTaskConfirmation(taskData);
  console.log('   Confirm ID:', confirmId);
  
  // 2. 模拟用户响应（创建响应文件）
  console.log('\n2. Simulating user response...');
  const { createMockResponse } = await import('./feishu-response-handler.js');
  
  // 等待2秒后创建响应
  setTimeout(() => {
    createMockResponse(taskData.id, '2'); // 选择"2"执行并加入白名单
    console.log('   Created mock response: taskId:2');
  }, 2000);
  
  // 3. 启动响应处理器
  console.log('\n3. Starting response handler...');
  const { startResponseHandler } = await import('./feishu-response-handler.js');
  startResponseHandler();
  
  // 4. 等待确认结果
  console.log('\n4. Waiting for confirmation...');
  const { waitForConfirmation } = await import('./feishu-notifier.js');
  
  const result = await waitForConfirmation(confirmId, 30000); // 30秒超时
  console.log('\n5. Confirmation result:', result);
  
  if (result.confirmed) {
    console.log('✅ Task confirmed!');
    if (result.addToWhitelist) {
      console.log('✅ Will be added to whitelist');
    }
  } else {
    console.log('❌ Task not confirmed:', result.reason);
  }
  
  process.exit(0);
}

test().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
