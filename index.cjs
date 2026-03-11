const { exec } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');
const os = require('os');
const crypto = require('crypto');

const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const REDIS_CLI = process.env.REDIS_CLI || 'redis-cli';
const HEARTBEAT_INTERVAL = parseInt(process.env.HEARTBEAT_INTERVAL || '30');
const TASK_TIMEOUT = parseInt(process.env.TASK_TIMEOUT || '300');
const LOCK_TIMEOUT = parseInt(process.env.LOCK_TIMEOUT || '60');

function redisCmd(...args) {
  return new Promise((resolve, reject) => {
    const cmd = [REDIS_CLI, '-h', REDIS_HOST, '-p', REDIS_PORT, '-a', REDIS_PASSWORD, ...args];
    exec(cmd.join(' '), (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

async function detectCompute() {
  const caps = [os.cpus().length + '核CPU', Math.round(os.totalmem()/1024/1024/1024*10)/10 + 'GB内存'];
  try {
    const gpu = require('child_process').execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null')?.toString().trim();
    if (gpu) caps.push(gpu);
  } catch {}
  return caps;
}

function loadRoleFiles(dir) {
  const files = ['SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md'];
  const result = {};
  for (const f of files) {
    try { result[f] = readFileSync(join(dir||'/root/.openclaw/workspace', f), 'utf8'); } catch {}
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
  
  let parsed = {};
  if (existing && !force) {
    try { parsed = JSON.parse(existing); } catch {}
  }
  
  const data = JSON.stringify({
    name: AGENT_NAME,
    registeredAt: parsed.registeredAt || new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    lastOnline: parsed.lastOnline || new Date().toISOString(),
    status: 'online',
    networkCapabilities: netCaps.length ? netCaps : (parsed.networkCapabilities || []),
    computeCapabilities: compCaps.length ? compCaps : (parsed.computeCapabilities || []),
    roleCapabilities: roleCaps.length ? roleCaps : (parsed.roleCapabilities || []),
    personaFiles: files,
    hostname: os.hostname(),
    platform: os.platform(),
    eventCount: (parsed.eventCount || 0) + 1
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
    d.lastHeartbeat = new Date().toISOString();
    d.status = 'online';
    d.eventCount = (d.eventCount || 0) + 1;
    await redisCmd('SETEX', 'agent:' + AGENT_NAME, HEARTBEAT_INTERVAL * 3, JSON.stringify(d));
  } else {
    await register();
  }
  await redisCmd('RPUSH', 'heartbeat:history:' + AGENT_NAME, new Date().toISOString());
  await redisCmd('LTRIM', 'heartbeat:history:' + AGENT_NAME, -100, -1);
}

async function logEvent(type, data) {
  const event = JSON.stringify({ type, agent: AGENT_NAME, timestamp: new Date().toISOString(), data });
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
  const lock = JSON.stringify({ owner, acquireAt: new Date().toISOString(), expireAt: Date.now() + LOCK_TIMEOUT * 1000 });
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
  const taskData = JSON.stringify({ id, from: AGENT_NAME, to, task, priority, timestamp: new Date().toISOString(), status: 'pending', attempts: 0, result: null });
  await redisCmd('RPUSH', 'tasks:' + to, taskData);
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
        p.completedAt = new Date().toISOString();
        p.result = result;
        const resultData = JSON.stringify({ taskId, from: AGENT_NAME, to: p.from, result, timestamp: new Date().toISOString() });
        await redisCmd('RPUSH', 'results:' + p.from, resultData);
        await redisCmd('LSET', 'tasks:' + AGENT_NAME, i, JSON.stringify(p));
        await logEvent('task_completed', { taskId, result: result?.substring(0, 50) });
        await releaseLock('task:' + taskId);
        return '✅ Task ' + taskId + ' completed, result sent to ' + p.from;
      }
    } catch {}
  }
  return 'Task not found';
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
    } catch {}
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
  await redisCmd('RPUSH', 'shared:memories', JSON.stringify({ id, agent: AGENT_NAME, content, timestamp: new Date().toISOString() }));
  await logEvent('memory_shared', { id, content: content.substring(0, 30) });
  return '✅ Memory shared';
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

// CLI handler
if (require.main === module) {
  if (!REDIS_HOST || !REDIS_PASSWORD) {
    console.log('Usage: REDIS_HOST=xxx REDIS_PASSWORD=xxx node index.cjs <command>');
    console.log('Commands: agents [--detailed], find <cap>, register, send <to> <task>, complete <id> <result>, tasks, results, memories, history, status, --heartbeat');
    process.exit(1);
  }
  
  const args = process.argv.slice(2);
  const cmd = args[0];
  
  // If no command provided, run as daemon (auto-register + heartbeat)
  if (!cmd) {
    register().then(r => console.log(r));
    setInterval(() => heartbeat().catch(() => {}), HEARTBEAT_INTERVAL * 1000);
  } else if (cmd === 'agents') listAgents(args.includes('--detailed')).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'find') find(args[1], args[2]||'all').then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'register') register(args[1], args[2], args[3]).then(r => console.log(r)).catch(e=>console.error(e.message));
  else if (cmd === 'send') sendTask(args[1], args.slice(2).join(' ')).then(console.log).catch(e=>console.error(e.message));
  else if (cmd === 'complete') completeTask(args[1], args.slice(2).join(' ')).then(console.log).catch(e=>console.error(e.message));
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
    console.log('Commands: agents [--detailed], find <cap>, register, send <to> <task>, complete <id> <result>, tasks, results, memories, history, status, --heartbeat');
    process.exit(1);
  }
}

module.exports = { skills };
