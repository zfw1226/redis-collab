const { exec } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');
const crypto = require('crypto');

// Use ioredis for proper Redis communication (fixes encoding issues with Chinese chars)
let redis = null;
function getRedis() {
  if (!redis) {
    const Redis = require('ioredis');
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: 1
    });
  }
  return redis;
}

const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const REDIS_CLI = process.env.REDIS_CLI || 'redis-cli';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30');
const TASK_TIMEOUT = parseInt(process.env.TASK_TIMEOUT || '300');
const LOCK_TIMEOUT = parseInt(process.env.LOCK_TIMEOUT || '60');

async function redisCmd(...args) {
  const r = getRedis();
  const cmd = args[0].toUpperCase();
  
  if (cmd === 'GET') return await r.get(args[1]) || '';
  else if (cmd === 'SET') return await r.set(args[1], args[2]);
  else if (cmd === 'SETEX') return await r.setex(args[1], args[2], args[3]);
  else if (cmd === 'DEL') return await r.del(...args.slice(1));
  else if (cmd === 'SADD') return await r.sadd(args[1], ...args.slice(2));
  else if (cmd === 'SMEMBERS') { const m = await r.smembers(args[1]); return m ? m.join('\n') : ''; }
  else if (cmd === 'RPUSH') return await r.rpush(args[1], ...args.slice(2));
  else if (cmd === 'LTRIM') return await r.ltrim(args[1], args[2], args[3]);
  else if (cmd === 'LLEN') return await r.llen(args[1]);
  else if (cmd === 'LRANGE') { const l = await r.lrange(args[1], args[2], args[3]); return l ? l.join('\n') : ''; }
  else if (cmd === 'LSET') return await r.lset(args[1], args[2], args[3]);
  else if (cmd === 'INCR') return await r.incr(args[1]);
  else if (cmd === 'DECR') return await r.decr(args[1]);
  else if (cmd === 'KEYS') { const k = await r.keys(args[1]); return k ? k.join('\n') : ''; }
  return '';
}

async function detectCompute() {
  const caps = [os.cpus().length + '核CPU', Math.round(os.totalmem()/1024/1024/1024*10)/10 + 'GB内存'];
  try {
    const gpu = require('child_process').execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null')?.toString().trim();
    if (gpu) caps.push(gpu);
  } catch (e) { console.error("[Error]", e.message); }
  return caps;
}

// Get real-time system metrics
async function getSystemMetrics() {
  const metrics = {
    timestamp: new Date(new Date().getTime() + 8*3600000).toISOString(),
    cpuUsage: null,
    loadAvg: null,
    memoryTotal: null,
    memoryUsed: null,
    memoryFree: null,
    processes: null,
    availability: 'unknown'
  };
  
  try {
    // CPU usage (sum of all processes %CPU)
    const cpuOutput = require('child_process').execSync("ps -A -o %cpu 2>/dev/null | awk '{s+=$1} END {printf \"%.1f\", s}'").toString().trim();
    metrics.cpuUsage = parseFloat(cpuOutput) || 0;
  } catch (e) {}
  
  try {
    // Load average (1 min)
    const loadOutput = require('child_process').execSync("uptime | awk -F'load averages:' '{print $2}' | awk '{print $1}' | tr -d ','").toString().trim();
    metrics.loadAvg = parseFloat(loadOutput) || 0;
  } catch (e) {}
  
  try {
    // Memory info (in MB)
    const memTotal = Math.round(os.totalmem() / 1024 / 1024);
    metrics.memoryTotal = memTotal;
    
    // Try macOS memory_pressure
    try {
      const memPressure = require('child_process').execSync("memory_pressure 2>/dev/null | grep 'System-wide memory free percentage' | awk '{print $5}' | tr -d '%'").toString().trim();
      const freePercent = parseFloat(memPressure) || 50;
      metrics.memoryFree = Math.round(memTotal * freePercent / 100);
      metrics.memoryUsed = memTotal - metrics.memoryFree;
    } catch {
      // Fallback to os.freemem()
      metrics.memoryFree = Math.round(os.freemem() / 1024 / 1024);
      metrics.memoryUsed = memTotal - metrics.memoryFree;
    }
  } catch (e) {}
  
  try {
    // Process count
    const procOutput = require('child_process').execSync("ps -e | wc -l | tr -d ' '").toString().trim();
    metrics.processes = parseInt(procOutput) || 0;
  } catch (e) {}
  
  // Calculate availability level based on load
  const load = metrics.loadAvg || 0;
  if (load < 10) {
    metrics.availability = '空闲';
  } else if (load < 20) {
    metrics.availability = '轻载';
  } else if (load < 40) {
    metrics.availability = '中载';
  } else {
    metrics.availability = '高载';
  }
  
  return metrics;
}

function loadRoleFiles(dir) {
  const files = ['SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md'];
  const result = {};
  for (const f of files) {
    try { result[f] = readFileSync(join(dir||'/root/.openclaw/workspace', f), 'utf8'); } catch (e) { console.error("[Error]", e.message); }
  }
  return result;
}

function detectRole() {
  const files = loadRoleFiles();
  const roles = [];
  if (files['SOUL.md']) {
    const c = files['SOUL.md'].toLowerCase();
    if (c.includes('research')) roles.push('researcher');
    if (c.includes('code')) roles.push('coder');
  }
  return roles;
}

// Fixed: check if already registered, preserve existing data
async function register(nets, computes, roles, force) {
  const existing = await redisCmd('GET', 'agent:' + AGENT_NAME);
  const isNew = !existing || force;
  
  const netCaps = nets ? nets.split(',').map(x => x.trim()) : [];
  const compCaps = computes ? computes.split(',').map(x => x.trim()) : await detectCompute();
  const roleCaps = roles ? roles.split(',').map(x => x.trim()) : detectRole();
  const files = Object.keys(loadRoleFiles());
  const metrics = await getSystemMetrics();
  
  let parsed = {};
  if (existing && !force) {
    try { parsed = JSON.parse(existing); } catch (e) { console.error("[Error]", e.message); }
  }
  
  const data = JSON.stringify({
    name: AGENT_NAME,
    registeredAt: parsed.registeredAt || new Date(new Date().getTime() + 8*3600000).toISOString(),
    lastHeartbeat: new Date(new Date().getTime() + 8*3600000).toISOString(),
    lastOnline: parsed.lastOnline || new Date(new Date().getTime() + 8*3600000).toISOString(),
    status: 'online',
    networkCapabilities: netCaps.length ? netCaps : (parsed.networkCapabilities || []),
    computeCapabilities: compCaps.length ? compCaps : (parsed.computeCapabilities || []),
    roleCapabilities: roleCaps.length ? roleCaps : (parsed.roleCapabilities || []),
    personaFiles: files,
    hostname: os.hostname(),
    platform: os.platform(),
    eventCount: (parsed.eventCount || 0) + 1,
    metrics: metrics
  });
  
  await redisCmd('SETEX', 'agent:' + AGENT_NAME, HEARTBEAT_INTERVAL * 3, data);
  await redisCmd('SADD', 'agents:all', AGENT_NAME);
  
  // Only log when it's a NEW registration
  if (isNew) {
    await logEvent('agent_registered', { name: AGENT_NAME });
    return '✅ New agent registered: ' + AGENT_NAME;
  }
  return '✅ Agent updated: ' + AGENT_NAME;
}

async function heartbeat() {
  const existing = await redisCmd('GET', 'agent:' + AGENT_NAME);
  if (existing) {
    const d = JSON.parse(existing);
    d.lastHeartbeat = new Date(new Date().getTime() + 8*3600000).toISOString();
    d.status = 'online';
    d.eventCount = (d.eventCount || 0) + 1;
    d.metrics = await getSystemMetrics();  // Update real-time metrics
    await redisCmd('SETEX', 'agent:' + AGENT_NAME, HEARTBEAT_INTERVAL * 3, JSON.stringify(d));
  } else {
    await register();
  }
  await redisCmd('RPUSH', 'heartbeat:history:' + AGENT_NAME, new Date(new Date().getTime() + 8*3600000).toISOString());
  await redisCmd('LTRIM', 'heartbeat:history:' + AGENT_NAME, -100, -1);
  
  // 清理过期 agent（每10次心跳清理一次）
  if ((d?.eventCount || 0) % 10 === 0) {
    await cleanupExpiredAgents();
  }
}

// 清理过期 agent
async function cleanupExpiredAgents() {
  try {
    const allAgents = await redisCmd('SMEMBERS', 'agents:all');
    const now = Date.now();
    const EXPIRE_THRESHOLD = 5 * 60 * 1000; // 5分钟超时
    
    for (const agent of allAgents) {
      const agentData = await redisCmd('GET', 'agent:' + agent);
      if (agentData) {
        const parsed = JSON.parse(agentData);
        const lastHeartbeat = new Date(parsed.lastHeartbeat).getTime();
        if (now - lastHeartbeat > EXPIRE_THRESHOLD) {
          // 标记为 offline
          parsed.status = 'offline';
          await redisCmd('SET', 'agent:' + agent, JSON.stringify(parsed));
          console.log(`[Cleanup] Agent ${agent} marked as offline (no heartbeat > 5min)`);
        }
      }
    }
  } catch (e) {
    console.error('[Cleanup] Failed:', e.message);
  }
}

async function logEvent(type, data) {
  const event = JSON.stringify({ type, agent: AGENT_NAME, timestamp: new Date(new Date().getTime() + 8*3600000).toISOString(), data });
  await redisCmd('RPUSH', 'events:global', event);
  await redisCmd('LTRIM', 'events:global', -500, -1);
}

async function acquireLock(resource, owner) {
  owner = owner || AGENT_NAME;
  const lockKey = 'lock:' + resource;
  const existing = await redisCmd('GET', lockKey);
  if (existing) {
    const lock = JSON.parse(existing);
    if (lock.owner !== owner && Date.now() < lock.expireAt) return null;
  }
  const lock = JSON.stringify({ owner, acquireAt: new Date(new Date().getTime() + 8*3600000).toISOString(), expireAt: Date.now() + LOCK_TIMEOUT * 1000 });
  await redisCmd('SET', lockKey, lock, 'EX', LOCK_TIMEOUT);
  return lock;
}

async function releaseLock(resource, owner) {
  owner = owner || AGENT_NAME;
  const lockKey = 'lock:' + resource;
  const existing = await redisCmd('GET', lockKey);
  if (existing) {
    const lock = JSON.parse(existing);
    if (lock.owner === owner) { await redisCmd('DEL', lockKey); return true; }
  }
  return false;
}

async function sendTask(to, task, priority) {
  priority = priority || 'normal';
  const id = crypto.randomBytes(4).toString('hex');
  const taskData = { id, from: AGENT_NAME, to, task, priority, timestamp: new Date(new Date().getTime() + 8*3600000).toISOString(), status: 'pending', attempts: 0, result: null };
  
  // 1. Add to queue (persistence)
  await redisCmd('RPUSH', 'tasks:' + to, JSON.stringify(taskData));
  
  // 2. Publish Pub/Sub notification (real-time)
  await publishMessage(`new-task:${to}`, taskData);
  
  await logEvent('task_sent', { id, to, task: task.substring(0, 50) });
  return '✅ Task to ' + to + ': ' + task + '\nID: ' + id + '\nPriority: ' + priority;
}

async function completeTask(taskId, result) {
  const tasks = await redisCmd('LRANGE', 'tasks:' + AGENT_NAME, '0', '99');
  if (!tasks) return 'No tasks';
  const list = tasks.split('\n').filter(x => x);
  for (let i = 0; i < list.length; i++) {
    try {
      const p = JSON.parse(list[i]);
      if (p.id === taskId) {
        p.status = 'completed';
        p.completedAt = new Date(new Date().getTime() + 8*3600000).toISOString();
        p.result = result;
        const resultData = JSON.stringify({ taskId, from: AGENT_NAME, to: p.from, result, timestamp: new Date(new Date().getTime() + 8*3600000).toISOString() });
        await redisCmd('RPUSH', 'results:' + p.from, resultData);
        await redisCmd('LSET', 'tasks:' + AGENT_NAME, i, JSON.stringify(p));
        await logEvent('task_completed', { taskId, result: (typeof result === "string" ? result.substring(0, 50) : JSON.stringify(result).substring(0, 50)) });
        await releaseLock('task:' + taskId);
        return '✅ Task ' + taskId + ' completed, result sent to ' + p.from;
      }
    } catch (e) { console.error("[Error]", e.message); }
  }
  return 'Task not found';
}

// 🔴 Pub/Sub: Publish message to channel
async function publishMessage(channel, message) {
  const r = getRedis();
  const msg = typeof message === 'string' ? message : JSON.stringify(message);
  await r.publish(channel, msg);
  console.log(`[Pub/Sub] 📢 Published to ${channel}`);
}

// 🔴 Pub/Sub: Subscribe and handle messages
async function startPubSubSubscriber() {
  const Redis = require('ioredis');
  const subscriber = new Redis({
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD
  });
  
  // Subscribe to my task channel and result channel
  const myTaskChannel = `new-task:${AGENT_NAME}`;
  const myResultChannel = `result:${AGENT_NAME}`;
  
  await subscriber.subscribe(myTaskChannel, myResultChannel);
  console.log(`[Pub/Sub] ✅ Subscribed to: ${myTaskChannel}, ${myResultChannel}`);
  
  subscriber.on('message', async (channel, message) => {
    try {
      const data = JSON.parse(message);
      if (channel === myTaskChannel) {
        console.log(`[Pub/Sub] 📥 New task from ${data.from}: ${data.task?.substring(0, 50)}...`);
        
        // 收到新任务 → 立即执行
        try {
          const result = await taskProcessor.processTask(
            data.task,
            data,
            getRedis(),
            async (notification) => {
              console.log('[Feishu] ' + notification.substring(0, 100));
            }
          );
          
          // 执行完成 → 返回结果
          if (result.success) {
            await completeTask(data.id, result.result);
            // 通过飞书发送结果给请求方
            const resultStr = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
            const resultMsg = `✅ 任务完成\n\n任务: ${data.task}\n结果: ${resultStr.substring(0, 200)}`;
            try {
              const { execSync } = require('child_process');
              execSync(`openclaw message send --message "${resultMsg.replace(/"/g, '\\"')}" --target ${data.from}`, { stdio: 'ignore' });
              console.log('[Feishu] ✅ Result sent to ' + data.from);
            } catch (e) {}
          }
        } catch (e) {
          console.error('[Pub/Sub] Task execution error:', e.message);
        }
      } else if (channel === myResultChannel) {
        console.log(`[Pub/Sub] ✅ Result for ${data.taskId} from ${data.from}`);
        console.log(`[Pub/Sub] Result: ${(typeof data.result === "string" ? data.result.substring(0, 100) : JSON.stringify(data.result).substring(0, 100))}...`);
        
        // 收到结果 → 转发给请求方（飞书）
        const resultStr = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
        const resultMsg = `📥 任务结果\n\n来自: ${data.from}\n结果: ${resultStr.substring(0, 300)}`;
        try {
          const { execSync } = require('child_process');
          // 发送给原始请求方
          execSync(`openclaw message send --message "${resultMsg.replace(/"/g, '\\"')}" --target ${data.from}`, { stdio: 'ignore' });
          console.log('[Feishu] ✅ Result forwarded to ' + data.from);
        } catch (e) {
          console.log('[Feishu] ⚠️ Failed to forward:', e.message);
        }
      }
    } catch (err) {
      console.error('[Pub/Sub] Error:', err.message);
    }
  });
  
  return subscriber;
}

// 🔴 Pub/Sub: Send task with notification
async function sendTaskWithPubSub(to, task, priority = 'normal') {
  const id = crypto.randomBytes(4).toString('hex');
  const taskData = { id, from: AGENT_NAME, to, task, priority, timestamp: new Date().toISOString(), status: 'pending', attempts: 0, result: null };
  
  // 1. Add to queue (persistence)
  await redisCmd('RPUSH', 'tasks:' + to, JSON.stringify(taskData));
  
  // 2. Publish Pub/Sub notification (real-time)
  await publishMessage(`new-task:${to}`, taskData);
  
  await logEvent('task_sent', { id, to, task: task.substring(0, 50) });
  return '✅ Task sent to ' + to + ' (with Pub/Sub notification)\nID: ' + id;
}

// 🔴 Pub/Sub: Complete task with notification
async function completeTaskWithPubSub(taskId, result) {
  // First complete normally
  const completionResult = await completeTask(taskId, result);
  
  // Then publish Pub/Sub notification
  const tasks = await redisCmd('LRANGE', 'tasks:' + AGENT_NAME, '0', '99');
  if (tasks) {
    const list = tasks.split('\n').filter(x => x);
    for (const t of list) {
      try {
        const p = JSON.parse(t);
        if (p.id === taskId) {
          await publishMessage(`result:${p.from}`, { taskId, from: AGENT_NAME, result, timestamp: new Date().toISOString() });
          break;
        }
      } catch (e) { console.error("[Error]", e.message); }
    }
  }
  
  return completionResult;
}

async function getResults() {
  const results = await redisCmd('LRANGE', 'results:' + AGENT_NAME, '0', '99');
  if (!results) return 'No results';
  return results.split('\n').filter(x => x).reverse().map(r => { try { var p = JSON.parse(r); return '📥 From ' + p.from + ': ' + (p.result || '(empty)'); } catch { return r; } }).join('\n');
}

async function listAgents(detailed) {
  detailed = detailed || false;
  await heartbeat();
  const agents = (await redisCmd('SMEMBERS', 'agents:all') || '').split('\n').filter(x => x);
  const results = [];
  for (const a of agents) {
    const data = await redisCmd('GET', 'agent:' + a);
    if (!data) continue;
    const d = JSON.parse(data);
    const secondsAgo = Math.floor((Date.now() - new Date(d.lastHeartbeat).getTime()) / 1000);
    const isOnline = secondsAgo < HEARTBEAT_INTERVAL * 3;
    const pendingTasks = await redisCmd('LLEN', 'tasks:' + a);
    const myResults = await redisCmd('LLEN', 'results:' + a);
    if (detailed) {
      results.push('🤖 ' + a + ' (' + (isOnline ? '🟢 online' : '🔴 offline') + ', ' + secondsAgo + 's ago)\n   🌐 ' + (d.networkCapabilities||[]).join(', ') + '\n   💻 ' + (d.computeCapabilities||[]).join(', ') + '\n   🎭 ' + (d.roleCapabilities||[]).join(', ') + '\n   📋 Pending: ' + pendingTasks + ' | 📥 Results: ' + myResults);
    } else {
      results.push(a + ' (' + (isOnline ? '🟢' : '🔴') + ', ' + pendingTasks + ' tasks)');
    }
  }
  return results.join('\n') || 'No agents';
}

async function getMyTasks() {
  const tasks = await redisCmd('LRANGE', 'tasks:' + AGENT_NAME, '0', '99');
  if (!tasks) return 'No tasks';
  return tasks.split('\n').filter(x => x).reverse().map(t => { try { var p = JSON.parse(t); return (p.status==='completed'?'✅':p.status==='failed'?'❌':'⏳') + ' [' + p.status + '] ' + p.from + ': ' + p.task + '\n   ID: ' + p.id + ' | Attempts: ' + p.attempts; } catch { return t; } }).join('\n');
}

async function retryTask(taskId) {
  const retryCount = await redisCmd('GET', 'task:retry:' + taskId);
  if (!retryCount || parseInt(retryCount) <= 0) return 'No retry available';
  const tasks = await redisCmd('LRANGE', 'tasks:' + AGENT_NAME, '0', '99');
  if (!tasks) return 'No tasks';
  for (const t of tasks.split('\n').filter(x => x)) {
    try {
      const p = JSON.parse(t);
      if (p.id === taskId && p.status === 'failed') {
        p.status = 'pending';
        p.attempts = (p.attempts || 0) + 1;
        p.failedAt = null;
        await redisCmd('DECR', 'task:retry:' + taskId);
        await redisCmd('RPUSH', 'tasks:' + AGENT_NAME, JSON.stringify(p));
        await logEvent('task_retried', { taskId, attempt: p.attempts });
        return '✅ Task ' + taskId + ' queued for retry (attempt ' + p.attempts + ')';
      }
    } catch (e) { console.error("[Error]", e.message); }
  }
  return 'Task not found or not in failed state';
}

async function getHistory(limit) {
  limit = limit || 50;
  const events = await redisCmd('LRANGE', 'events:global', -limit, -1);
  if (!events) return 'No history';
  return events.split('\n').filter(x => x).reverse().map(e => { try { var p = JSON.parse(e); return '[' + p.timestamp.slice(0,16) + '] ' + p.agent + ': ' + p.type; } catch { return e; } }).join('\n');
}

async function find(cap, type) {
  type = type || 'all';
  const agents = (await redisCmd('SMEMBERS', 'agents:all') || '').split('\n').filter(x => x);
  const results = [];
  for (const a of agents) {
    const data = await redisCmd('GET', 'agent:' + a);
    if (!data) continue;
    const d = JSON.parse(data);
    const isOnline = (Date.now() - new Date(d.lastHeartbeat).getTime()) < HEARTBEAT_INTERVAL * 3000;
    let match = false;
    if ((type === 'all' || type === 'network') && (d.networkCapabilities||[]).some(x => x.toLowerCase().includes(cap.toLowerCase()))) match = true;
    if (!match && (type === 'all' || type === 'compute') && (d.computeCapabilities||[]).some(x => x.toLowerCase().includes(cap.toLowerCase()))) match = true;
    if (!match && (type === 'all' || type === 'role') && (d.roleCapabilities||[]).some(x => x.toLowerCase().includes(cap.toLowerCase()))) match = true;
    if (match) results.push((isOnline ? '🟢' : '🔴') + ' ' + a);
  }
  return results.join('\n') || 'No agents with ' + cap;
}

async function shareMemory(content) {
  const id = crypto.randomBytes(4).toString('hex');
  
  // Check if content is a file path
  let fileInfo = null;
  if (content.startsWith('/') || content.startsWith('./') || content.startsWith('~')) {
    const path = content.startsWith('~') ? require('os').homedir() + content.slice(1) : content;
    try {
      const stats = fs.statSync(path);
      if (stats.isFile()) {
        fileInfo = {
          path: path,
          name: require('path').basename(path),
          size: stats.size,
          isFile: true
        };
        // For now, just reference the file path (actual upload can be added later)
        content = '[文件] ' + fileInfo.name + ' (' + Math.round(fileInfo.size/1024) + 'KB)';
      }
    } catch(e) {
      // File doesn't exist, treat as normal text
    }
  }
  
  const memory = { 
    id, 
    agent: AGENT_NAME, 
    content, 
    timestamp: new Date(new Date().getTime() + 8*3600000).toISOString() 
  };
  if (fileInfo) memory.file = fileInfo;
  
  await redisCmd('RPUSH', 'shared:memories', JSON.stringify(memory));
  await logEvent('memory_shared', { id, content: content.substring(0, 30) });
  return fileInfo ? '✅ 文件记忆共享: ' + fileInfo.name : '✅ Memory shared';
}

async function memories(limit) {
  limit = limit || 20;
  const mems = await redisCmd('LRANGE', 'shared:memories', '0', String(limit-1));
  if (!mems) return 'No memories';
  return mems.split('\n').reverse().filter(x => x).map(m => { try { var p = JSON.parse(m); return '[' + p.timestamp.slice(0,16) + '] ' + p.agent + ': ' + p.content; } catch { return m; } }).join('\n');
}

const skills = {
  'redis-agents': { description: 'List all agents', params: [{ name: 'detailed', type: 'boolean', required: false }], handler: async function(args) { return listAgents(args.detailed); } },
  'redis-find': { description: 'Find agents by capability', params: [{ name: 'capability', type: 'string', required: true }, { name: 'type', type: 'string', required: false }], handler: async function(args) { return find(args.capability, args.type||'all'); } },
  'redis-register': { description: 'Register this agent', params: [{ name: 'network', type: 'string', required: false }, { name: 'compute', type: 'string', required: false }, { name: 'role', type: 'string', required: false }], handler: async function(args) { return register(args.network, args.compute, args.role); } },
  'redis-tasks': { description: 'Get my tasks', handler: async function() { return getMyTasks(); } },
  'redis-results': { description: 'Get results sent to me', handler: async function() { return getResults(); } },
  'redis-send': { description: 'Send task', params: [{ name: 'to', type: 'string', required: true }, { name: 'task', type: 'string', required: true }, { name: 'priority', type: 'string', required: false }], handler: async function(args) { return sendTask(args.to, args.task, args.priority||'normal'); } },
  'redis-complete': { description: 'Complete task with result', params: [{ name: 'taskId', type: 'string', required: true }, { name: 'result', type: 'string', required: true }], handler: async function(args) { return completeTask(args.taskId, args.result); } },
  'redis-retry': { description: 'Retry failed task', params: [{ name: 'taskId', type: 'string', required: true }], handler: async function(args) { return retryTask(args.taskId); } },
  'redis-memory': { description: 'Share memory', params: [{ name: 'content', type: 'string', required: true }], handler: async function(args) { return shareMemory(args.content); } },
  'redis-memories': { description: 'View memories', params: [{ name: 'limit', type: 'number', required: false }], handler: async function(args) { return memories(args.limit); } },
  'redis-history': { description: 'View global history', params: [{ name: 'limit', type: 'number', required: false }], handler: async function(args) { return getHistory(args.limit); } },
  'redis-status': { description: 'Get my status', handler: async function() { const d = await redisCmd('GET', 'agent:'+AGENT_NAME); return d ? JSON.stringify(JSON.parse(d), null, 2) : 'Not registered'; } }
};

// Auto task processor (optional feature)
let autoProcessorEnabled = false;
let taskProcessor = null;

async function startAutoTaskProcessor() {
  if (autoProcessorEnabled) return;
  autoProcessorEnabled = true;
  
  try {
    // Dynamic import for ES module compatibility
    taskProcessor = await import('./task-processor.js');
    console.log('🤖 Auto task processor started');
    
    // Task polling loop
    setInterval(async () => {
      try {
        const tasks = await redisCmd('LRANGE', 'tasks:' + AGENT_NAME, '0', '-1');
        if (!tasks) return;
        
        const taskList = tasks.split('\n').filter(x => x);
        for (const taskStr of taskList) {
          try {
            const taskData = JSON.parse(taskStr);
            if (taskData.status !== 'pending') continue;
            
            // Skip if already notified (check Redis)
            const notifiedKey = `notified:${taskData.id}`;
            const alreadyNotified = await redisCmd('GET', notifiedKey);
            if (alreadyNotified) {
              console.log(`[Auto] Task ${taskData.id} already notified`);
            } else {
              // Mark as notified
              await redisCmd('SET', notifiedKey, '1', 'EX', 3600);
            }
            
            console.log(`[Auto] Processing task: ${taskData.id}`);
            
            // Process task with whitelist check
            const result = await taskProcessor.processTask(
              taskData.task,
              taskData,
              getRedis(),
              async (notification) => {
                // Send Feishu notification via OpenClaw CLI
                console.log('[Feishu] ' + notification.substring(0, 100) + '...');
                try {
                  const { execSync } = require('child_process');
                  // Send to current feishu user
                  execSync(`openclaw message send --message "🔔 ${notification.replace(/"/g, '\\"')}" --target ${process.env.FEISHU_USER_ID || "ou_361e694e501482a6af662457cefbf0d9"}`, { stdio: 'ignore' });
                  console.log('[Feishu] ✅ Notification sent');
                } catch (e) {
                  console.log('[Feishu] ⚠️ Failed to send:', e.message);
                }
              }
            );
            
            // Send result notification via Feishu - send to task sender (taskData.from)
            const taskKey = `task:${taskData.id}:status`;
            const prevStatus = await redisCmd('GET', taskKey);
            const currentStatus = result.success ? 'completed' : (result.reason === 'not_confirmed' ? 'pending_confirm' : 'failed');
            
            // Only notify if status changed AND result is not a placeholder
            const resultStr = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
            const isPlaceholder = resultStr.includes('任务已提交执行') || resultStr.includes('processing');
            
            if (prevStatus !== currentStatus && !isPlaceholder) {
              // Status changed to completed - send notification to requester
              await redisCmd('SET', taskKey, currentStatus, 'EX', 3600);
              
              try {
                const { execSync } = require('child_process');
                let resultMsg = '';
                if (result.success) {
                  resultMsg = `✅ 任务完成\n\n任务: ${taskData.task}\n结果: ${resultStr.substring(0, 200)}`;
                } else {
                  resultMsg = `❌ 任务失败\n\n任务: ${taskData.task}\n原因: ${result.message || result.reason}`;
                }
                // Send to the requester (from), not to current user
                const targetUser = taskData.from || process.env.FEISHU_USER_ID;
                execSync(`openclaw message send --message "${resultMsg.replace(/"/g, '\\"')}" --target ${targetUser}`, { stdio: 'ignore' });
                console.log('[Feishu] ✅ Result notification sent to ' + targetUser);
              } catch (e) {}
            }
            
            // Clean up notified flag
            if (result.success || result.reason === 'not_confirmed') {
              await redisCmd('DEL', `notified:${taskData.id}`);
            }
            
            if (result.success) {
              await completeTask(taskData.id, result.result);
            } else if (result.reason === 'not_confirmed') {
              // Send confirmation request notification
              const confirmMsg = `⏳ 任务待确认\n\n任务: ${taskData.task}\n来自: ${taskData.from}\nID: ${taskData.id}\n\n请回复确认执行`;
              try {
                const { execSync } = require('child_process');
                execSync(`openclaw message send --message "${confirmMsg.replace(/"/g, '\\"')}" --target ${process.env.FEISHU_USER_ID || "ou_361e694e501482a6af662457cefbf0d9"}`, { stdio: 'ignore' });
                console.log('[Feishu] ✅ Confirmation request sent');
              } catch (e) {}
              console.log(`[Auto] Task ${taskData.id} waiting for confirmation`);
            } else {
              console.log(`[Auto] Task ${taskData.id} failed: ${result.message}`);
            }
          } catch (e) {
            console.error('[Auto] Task processing error:', e.message);
          }
        }
      } catch (e) {
        console.error('[Auto] Polling error:', e.message);
      }
    }, 10000);
    
  } catch (e) {
    console.error('Failed to start auto task processor:', e.message);
  }
}

// Auto processor commands
async function enableAutoProcessor() {
  await startAutoTaskProcessor();
  return '✅ Auto task processor enabled';
}

async function disableAutoProcessor() {
  autoProcessorEnabled = false;
  return '✅ Auto task processor disabled';
}

// Add new skills
skills['redis-auto-enable'] = { 
  description: 'Enable auto task processor', 
  handler: async function() { return enableAutoProcessor(); }
};

skills['redis-auto-disable'] = { 
  description: 'Disable auto task processor', 
  handler: async function() { return disableAutoProcessor(); }
};

// CLI handler
if (require.main === module) {
  if (!REDIS_HOST || !REDIS_PASSWORD) {
    console.log('Usage: REDIS_HOST=xxx REDIS_PASSWORD=xxx node index.cjs <command>');
    console.log('Commands: agents [--detailed], find <cap>, register, send <to> <task>, complete <id> <result>, tasks, results, memories, history, status, --heartbeat, --auto');
    process.exit(1);
  }
  
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  // If no command provided, run as daemon (auto-register + heartbeat)
  if (!cmd) {
    register().then(r => console.log(r));
    setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_INTERVAL * 1000);
  } else if (cmd === '--auto') {
    // Daemon mode with auto task processing + Pub/Sub
    console.log('💓 Heartbeat + Auto Task Processor + Pub/Sub for ' + AGENT_NAME);
    register().then(r => console.log(r));
    setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_INTERVAL * 1000);
    startAutoTaskProcessor();
    startPubSubSubscriber(); // 🔴 Start Pub/Sub subscriber
  } else if (cmd === 'agents') listAgents(args.includes('--detailed')).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'find') find(args[1], args[2]||'all').then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'register') register(args[1], args[2], args[3]).then(r => console.log(r)).catch(e=>console.error(e.message));
  else if (cmd === 'send') sendTask(args[1], args.slice(2).join(' ')).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'send-pubsub') sendTaskWithPubSub(args[1], args.slice(2).join(' ')).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'complete') completeTask(args[1], args.slice(2).join(' ')).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'complete-pubsub') completeTaskWithPubSub(args[1], args.slice(2).join(' ')).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'subscribe') startPubSubSubscriber().then(() => console.log('Subscribed. Waiting for messages...')).catch(e=>console.error(e.message));
  else if (cmd === 'tasks') getMyTasks().then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'results') getResults().then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'memories') memories().then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'history') getHistory(args[1]||50).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'retry') retryTask(args[1]).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'status') redisCmd('GET','agent:'+AGENT_NAME).then(d=>console.log(d?JSON.stringify(JSON.parse(d),null,2):'Not registered')).catch(console.error);
  else if (cmd === '--heartbeat') {
    console.log('💓 Heartbeat for ' + AGENT_NAME);
    register().then(r => console.log(r));
    setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_INTERVAL * 1000);
  } else {
    console.log('Commands: agents [--detailed], find <cap>, register, send <to> <task>, send-pubsub <to> <task>, complete <id> <result>, complete-pubsub <id> <result>, subscribe, tasks, results, memories, history, status, --heartbeat, --auto');
    process.exit(1);
  }
}

module.exports = { skills, completeTask, publishMessage, startPubSubSubscriber, sendTaskWithPubSub, completeTaskWithPubSub };
