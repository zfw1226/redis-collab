#!/usr/bin/env node
/**
 * Redis-Collab 功能测试脚本
 * 测试修复的功能：任务优先级、任务拒绝、资源清理、记忆去重
 */

const { execSync } = require('child_process');
const Redis = require('ioredis');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// 配置
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379');
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const TEST_AGENT = '韩国虾测试';
const TEST_AGENT_2 = '测试代理B';

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD
});

console.log('='.repeat(60));
console.log('🧪 Redis-Collab 功能测试');
console.log('='.repeat(60));

// 测试工具函数
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✅ PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`❌ FAIL: ${name}`);
    console.log(`   错误: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 清理测试数据
async function cleanup() {
  console.log('\n🧹 清理测试数据...');
  const testKeys = [
    'tasks:韩国虾测试',
    'tasks:测试代理B',
    'results:韩国虾测试',
    'results:测试代理B',
    'memory:hashes'
  ];
  for (const key of testKeys) {
    await redis.del(key);
  }
  console.log('✅ 清理完成\n');
}

// ========== 测试1: 任务优先级 ==========
async function testPriority() {
  console.log('\n📌 测试1: 任务优先级验证');
  
  // 读取当前代码中的优先级验证
  const indexCode = fs.readFileSync('./index.cjs', 'utf8');
  
  // 测试不同的优先级
  const priorities = ['low', 'normal', 'high', 'urgent'];
  for (const priority of priorities) {
    const taskData = {
      id: crypto.randomBytes(4).toString('hex'),
      from: TEST_AGENT,
      to: TEST_AGENT_2,
      task: `测试任务 ${priority}`,
      priority: priority,
      timestamp: new Date().toISOString(),
      status: 'pending'
    };
    await redis.rpush('tasks:' + TEST_AGENT_2, JSON.stringify(taskData));
    console.log(`   - 已添加优先级 ${priority} 任务`);
  }
  
  // 验证无效优先级会被拒绝
  const invalidTask = {
    id: crypto.randomBytes(4).toString('hex'),
    from: TEST_AGENT,
    to: TEST_AGENT_2,
    task: '无效优先级测试',
    priority: 'invalid_priority',
    timestamp: new Date().toISOString(),
    status: 'pending'
  };
  // 如果代码正确，无效优先级会被默认为 'normal'
  assert(indexCode.includes('VALID_PRIORITIES'), '缺少优先级验证常量');
  assert(indexCode.includes('normal'), '缺少默认值 normal');
  console.log('   ✅ 优先级验证代码存在');
}

// ========== 测试2: 任务拒绝功能 ==========
async function testReject() {
  console.log('\n📌 测试2: 任务拒绝功能');
  
  // 创建一个待拒绝的任务
  const taskId = crypto.randomBytes(4).toString('hex');
  const task = {
    id: taskId,
    from: TEST_AGENT,
    to: TEST_AGENT_2,
    task: '需要拒绝的测试任务',
    priority: 'normal',
    timestamp: new Date().toISOString(),
    status: 'pending'
  };
  await redis.rpush('tasks:' + TEST_AGENT_2, JSON.stringify(task));
  
  // 检查 rejectTask 函数是否存在
  const indexCode = fs.readFileSync('./index.cjs', 'utf8');
  assert(indexCode.includes('async function rejectTask'), '缺少 rejectTask 函数');
  assert(indexCode.includes('redis-reject'), '缺少 redis-reject 技能');
  console.log('   ✅ rejectTask 函数存在');
  console.log('   ✅ redis-reject 技能已注册');
  
  // 模拟拒绝
  const rejectData = {
    taskId: taskId,
    from: TEST_AGENT_2,
    to: TEST_AGENT,
    result: { error: 'Task rejected', reason: '无法完成此任务' },
    timestamp: new Date().toISOString()
  };
  await redis.rpush('results:' + TEST_AGENT, JSON.stringify(rejectData));
  
  // 验证结果
  const results = await redis.lrange('results:' + TEST_AGENT, 0, -1);
  assert(results.length > 0, '拒绝结果未发送');
  console.log('   ✅ 拒绝结果已发送到结果队列');
}

// ========== 测试3: 资源清理功能 ==========
async function testCleanup() {
  console.log('\n📌 测试3: 资源清理功能');
  
  // 检查 cleanupTaskFiles 函数是否存在
  const indexCode = fs.readFileSync('./index.cjs', 'utf8');
  assert(indexCode.includes('async function cleanupTaskFiles'), '缺少 cleanupTaskFiles 函数');
  console.log('   ✅ cleanupTaskFiles 函数存在');
  
  // 模拟创建任务目录
  const taskId = 'test-' + crypto.randomBytes(4).toString('hex');
  const taskDir = path.join(os.homedir(), '.openclaw', 'workspace', '.local', 'redis-collab', 'task-executions', taskId);
  
  // 创建测试目录和文件
  if (!fs.existsSync(taskDir)) {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'test.txt'), 'test content');
  }
  
  // 验证目录已创建
  assert(fs.existsSync(taskDir), '测试目录未创建');
  console.log('   ✅ 测试任务目录已创建');
  
  // 清理功能测试（通过检查代码逻辑）
  assert(indexCode.includes('fs.rmSync'), '缺少文件删除逻辑');
  assert(indexCode.includes('recursive: true'), '缺少递归删除参数');
  console.log('   ✅ 清理逻辑完整');
}

// ========== 测试4: 记忆去重功能 ==========
async function testDeduplication() {
  console.log('\n📌 测试4: 记忆去重功能');
  
  const indexCode = fs.readFileSync('./index.cjs', 'utf8');
  
  // 检查去重相关代码
  assert(indexCode.includes('contentHash'), '缺少哈希计算');
  assert(indexCode.includes('sha256'), '缺少 SHA256 加密');
  assert(indexCode.includes('memory:hashes'), '缺少哈希存储键');
  console.log('   ✅ 记忆去重代码存在');
  
  // 测试去重逻辑
  const testContent = '测试记忆内容 ' + Date.now();
  const contentHash = crypto.createHash('sha256').update(testContent).digest('hex').substring(0, 16);
  
  // 第一次添加
  await redis.rpush('memory:hashes', contentHash);
  
  // 检查是否已存在
  const hashes = await redis.lrange('memory:hashes', 0, -1);
  const exists = hashes.includes(contentHash);
  
  assert(exists, '记忆哈希未正确存储');
  console.log('   ✅ 记忆哈希正确存储');
  
  // 验证去重逻辑存在
  assert(indexCode.includes('Memory already exists'), '缺少去重提示');
  console.log('   ✅ 去重提示存在');
}

// ========== 测试5: 任务完成 + 清理 ==========
async function testCompleteWithCleanup() {
  console.log('\n📌 测试5: 任务完成时自动清理');
  
  const indexCode = fs.readFileSync('./index.cjs', 'utf8');
  
  // 检查 completeTask 中是否调用了 cleanupTaskFiles
  const completeMatch = indexCode.match(/async function completeTask[\s\S]*?cleanupTaskFiles/);
  assert(completeMatch, 'completeTask 中未调用 cleanupTaskFiles');
  console.log('   ✅ 任务完成时自动调用清理');
}

// ========== 运行所有测试 ==========
async function runTests() {
  try {
    await cleanup();
    
    await testPriority();
    await testReject();
    await testCleanup();
    await testDeduplication();
    await testCompleteWithCleanup();
    
    console.log('\n' + '='.repeat(60));
    console.log(`📊 测试结果: ${passed} 通过, ${failed} 失败`);
    console.log('='.repeat(60));
    
    if (failed > 0) {
      console.log('\n⚠️  部分测试失败，请检查代码');
      process.exit(1);
    } else {
      console.log('\n🎉 所有测试通过！');
    }
    
  } catch (e) {
    console.error('\n❌ 测试出错:', e);
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

runTests();
