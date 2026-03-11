#!/usr/bin/env node

import { exec } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import os from 'os';
import crypto from 'crypto';

const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const REDIS_CLI = process.env.REDIS_CLI || 'redis-cli';
const HEARTBEAT_INTERVAL = process.env.HEARTBEAT_INTERVAL || 30;

// Validate required environment variables
if (!REDIS_HOST) {
  console.error('❌ REDIS_HOST environment variable is required!');
  console.error('Example: REDIS_HOST=43.131.241.215 REDIS_PASSWORD=yourpass node index.js ...');
  process.exit(1);
}
if (!REDIS_PASSWORD) {
  console.error('❌ REDIS_PASSWORD environment variable is required!');
  process.exit(1);
}

function redisCmd(...args) {
  return new Promise((resolve, reject) => {
    const cmd = [REDIS_CLI, '-h', REDIS_HOST, '-p', REDIS_PORT, '-a', REDIS_PASSWORD, ...args];
    exec(cmd.join(' '), (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ============== ROLE & PERSONA MANAGEMENT ==============

const ROLE_FILES = ['SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md'];

async function loadRoleFiles(roleDir = process.env.ROLE_DIR || '/root/.openclaw/workspace') {
  const files = {};
  
  for (const file of ROLE_FILES) {
    try {
      const filePath = join(roleDir, file);
      files[file] = readFileSync(filePath, 'utf8');
    } catch (e) {
      // File not found, skip
    }
  }
  
  return files;
}

async function detectRoleFromFiles() {
  const files = await loadRoleFiles();
  const roles = [];
  
  // Detect from SOUL.md
  if (files['SOUL.md']) {
    // Look for role-related keywords
    const content = files['SOUL.md'].toLowerCase();
    if (content.includes('research')) roles.push('researcher');
    if (content.includes('code') || content.includes('program')) roles.push('coder');
    if (content.includes('analyst') || content.includes('analyze')) roles.push('analyst');
    if (content.includes('writer') || content.includes('write')) roles.push('writer');
    if (content.includes('assistant')) roles.push('assistant');
  }
  
  // Detect from AGENTS.md
  if (files['AGENTS.md']) {
    const content = files['AGENTS.md'].toLowerCase();
    if (content.includes('vibe') || content.includes('chaotic')) roles.push('chaotic');
    if (content.includes('formal')) roles.push('formal');
    if (content.includes('helpful')) roles.push('helpful');
  }
  
  // Also check IDENTITY.md for explicit role
  if (files['IDENTITY.md']) {
    const content = files['IDENTITY.md'].toLowerCase();
    const nameMatch = content.match(/name:\s*(.+)/);
    if (nameMatch) {
      roles.unshift(nameMatch[1].trim());
    }
  }
  
  return [...new Set(roles)]; // Remove duplicates
}

// ============== AUTO DETECT COMPUTE CAPABILITIES ==============

async function detectComputeCapabilities() {
  const caps = [];
  
  const cpus = os.cpus().length;
  caps.push(`${cpus}核CPU`);
  
  const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
  caps.push(`${totalMemGB}GB内存`);
  if (totalMemGB >= 64) caps.push('64GB+');
  if (totalMemGB >= 128) caps.push('128GB+');
  
  try {
    const { execSync } = await import('child_process');
    const gpuInfo = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null', { encoding: 'utf8' });
    const lines = gpuInfo.trim().split('\n');
    for (const line of lines) {
      const parts = line.split(', ');
      if (parts.length >= 2) {
        const gpuName = parts[0].trim();
        const mem = parts[1].trim();
        caps.push(gpuName);
        if (gpuName.includes('4090')) caps.push('RTX-4090');
        if (gpuName.includes('3090')) caps.push('RTX-3090');
        if (gpuName.includes('A100')) caps.push('A100');
        if (gpuName.includes('A6000')) caps.push('A6000');
        if (gpuName.includes('A10')) caps.push('A10');
        if (mem.includes('24')) caps.push('24GB显存');
        if (mem.includes('40')) caps.push('40GB显存');
        if (mem.includes('80')) caps.push('80GB显存');
      }
    }
  } catch (e) {
    // No GPU
  }
  
  return caps;
}

// ============== AGENT REGISTRATION ==============

async function registerAgent(networkCaps = [], computeCaps = [], roleCaps = []) {
  let finalComputeCaps = computeCaps;
  if (finalComputeCaps.length === 0) {
    finalComputeCaps = await detectComputeCapabilities();
  }
  
  // Auto-detect role if not provided
  let finalRoleCaps = roleCaps;
  if (finalRoleCaps.length === 0) {
    finalRoleCaps = await detectRoleFromFiles();
  }
  
  const files = await loadRoleFiles();
  
  const timestamp = new Date().toISOString();
  const agentData = JSON.stringify({
    name: AGENT_NAME,
    registeredAt: timestamp,
    lastHeartbeat: timestamp,
    status: 'online',
    networkCapabilities: networkCaps,
    computeCapabilities: finalComputeCaps,
    roleCapabilities: finalRoleCaps,  // 🎭 角色: researcher, coder, analyst, etc
    personaFiles: Object.keys(files),  // 📄 已同步的角色文件
    hostname: os.hostname(),
    platform: os.platform(),
    cpus: os.cpus().length,
    totalMemory: Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10 + 'GB'
  });
  
  const ttl = HEARTBEAT_INTERVAL * 3;
  await redisCmd('SETEX', `agent:${AGENT_NAME}`, ttl, agentData);
  await redisCmd('SADD', 'agents:all', AGENT_NAME);
  
  return agentData;
}

async function heartbeat() {
  const agentData = await redisCmd('GET', `agent:${AGENT_NAME}`);
  if (agentData) {
    try {
      const data = JSON.parse(agentData);
      data.lastHeartbeat = new Date().toISOString();
      data.status = 'online';
      const ttl = HEARTBEAT_INTERVAL * 3;
      await redisCmd('SETEX', `agent:${AGENT_NAME}`, ttl, JSON.stringify(data));
    } catch {}
  } else {
    await registerAgent();
    console.log(`✅ Agent ${AGENT_NAME} registered`);
  }
}

async function getAgentStatus(agentName) {
  const data = await redisCmd('GET', `agent:${agentName}`);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ============== SYNC PERSONA FILES ==============

async function syncPersonaFiles(targetAgent = null) {
  const files = await loadRoleFiles();
  
  if (Object.keys(files).length === 0) {
    return 'No persona files found to sync.';
  }
  
  // Store files in Redis
  for (const [filename, content] of Object.entries(files)) {
    const key = targetAgent 
      ? `persona:${targetAgent}:${filename}` 
      : `persona:shared:${filename}`;
    await redisCmd('SET', key, content);
  }
  
  const target = targetAgent || 'all agents';
  return `✅ Synced ${Object.keys(files).length} persona files to ${target}`;
}

async function getPersonaFiles(agentName = null) {
  const pattern = agentName ? `persona:${agentName}:*` : 'persona:shared:*';
  const keys = await redisCmd('KEYS', pattern);
  
  if (!keys || keys.length === 0) {
    return 'No persona files found.';
  }
  
  const result = [];
  for (const key of keys.split('\n').filter(k => k)) {
    const content = await redisCmd('GET', key);
    const filename = key.split(':').pop();
    result.push(`📄 ${filename}:\n${content.substring(0, 200)}...`);
  }
  
  return result.join('\n\n');
}

// ============== CAPABILITY REGISTRATION ==============

async function registerCapabilities(network = '', compute = '', role = '') {
  const networkCaps = network ? network.split(',').map(c => c.trim()) : [];
  const computeCaps = compute ? compute.split(',').map(c => c.trim()) : [];
  const roleCaps = role ? role.split(',').map(c => c.trim()) : [];
  
  await registerAgent(networkCaps, computeCaps, roleCaps);
  
  let msg = `✅ Capabilities updated for ${AGENT_NAME}:\n`;
  if (networkCaps.length > 0) msg += `   🌐 网络: ${networkCaps.join(', ')}\n`;
  if (computeCaps.length > 0) msg += `   💻 计算: ${computeCaps.join(', ')}\n`;
  if (roleCaps.length > 0) msg += `   🎭 角色: ${roleCaps.join(', ')}\n`;
  
  return msg;
}

// ============== FIND AGENTS ==============

async function findAgents(capability, type = 'all') {
  const agents = await redisCmd('SMEMBERS', 'agents:all');
  if (!agents) return 'No agents registered.';
  
  const agentList = agents.split('\n').filter(a => a);
  const matches = [];
  
  for (const agent of agentList) {
    const data = await getAgentStatus(agent);
    if (!data) continue;
    
    const lastSeen = new Date(data.lastHeartbeat);
    const now = new Date();
    const secondsAgo = Math.floor((now - lastSeen) / 1000);
    const isOnline = secondsAgo < HEARTBEAT_INTERVAL * 3;
    const status = isOnline ? '🟢' : '🔴';
    
    let matched = false;
    let matchedType = '';
    
    // Network capability
    if (type === 'all' || type === 'network') {
      if (data.networkCapabilities && data.networkCapabilities.some(c => 
        c.toLowerCase().includes(capability.toLowerCase())
      )) {
        matched = true;
        matchedType = '🌐';
      }
    }
    
    // Compute capability
    if (!matched && (type === 'all' || type === 'compute')) {
      if (data.computeCapabilities && data.computeCapabilities.some(c => 
        c.toLowerCase().includes(capability.toLowerCase())
      )) {
        matched = true;
        matchedType = '💻';
      }
    }
    
    // Role capability
    if (!matched && (type === 'all' || type === 'role')) {
      if (data.roleCapabilities && data.roleCapabilities.some(c => 
        c.toLowerCase().includes(capability.toLowerCase())
      )) {
        matched = true;
        matchedType = '🎭';
      }
    }
    
    if (matched) {
      let info = `${status} ${agent} ${matchedType}\n`;
      if (data.networkCapabilities?.length) info += `      🌐 ${data.networkCapabilities.join(', ')}\n`;
      if (data.computeCapabilities?.length) info += `      💻 ${data.computeCapabilities.join(', ')}\n`;
      if (data.roleCapabilities?.length) info += `      🎭 ${data.roleCapabilities.join(', ')}`;
      matches.push(info);
    }
  }
  
  if (matches.length === 0) return `No agents found with:  
 ${capability}`;
  return `🔍 Agents with "${capability}":\n` + matches.join('\n');
}

// ============== LIST AGENTS ==============

async function listAgents(detailed = false) {
  await heartbeat();
  
  const agents = await redisCmd('SMEMBERS', 'agents:all');
  if (!agents) return 'No agents registered.';
  
  const agentList = agents.split('\n').filter(a => a);
  const results = [];
  
  for (const agent of agentList) {
    const data = await getAgentStatus(agent);
    if (!data) continue;
    
    const lastSeen = new Date(data.lastHeartbeat);
    const secondsAgo = Math.floor((new Date() - lastSeen) / 1000);
    const isOnline = secondsAgo < HEARTBEAT_INTERVAL * 3;
    const status = isOnline ? '🟢 online' : '🔴 offline';
    
    if (detailed) {
      let info = `🤖 ${agent} (${status}, ${secondsAgo}s ago)\n`;
      info += `   平台: ${data.platform} | CPU: ${data.cpus}核 | 内存: ${data.totalMemory}\n`;
      if (data.networkCapabilities?.length) info += `   🌐 网络: ${data.networkCapabilities.join(', ')}\n`;
      if (data.computeCapabilities?.length) info += `   💻 计算: ${data.computeCapabilities.join(', ')}\n`;
      if (data.roleCapabilities?.length) info += `   🎭 角色: ${data.roleCapabilities.join(', ')}\n`;
      if (data.personaFiles?.length) info += `   📄 文件: ${data.personaFiles.join(', ')}`;
      results.push(info);
    } else {
      results.push(`${agent} (${status})`);
    }
  }
  
  return detailed 
    ? '🤖 Agents:\n' + results.join('\n')
    : '🟢: ' + results.filter(r => r.includes('🟢')).map(r => r.split(' (')[0]).join(', ');
}

// ============== TASKS ==============

async function sendTask(targetAgent, task) {
  const id = crypto.randomBytes(4).toString('hex');
  const taskData = JSON.stringify({ 
    id, from: AGENT_NAME, to: targetAgent, task, timestamp: new Date().toISOString(), status: 'pending' 
  });
  
  await redisCmd('RPUSH', `tasks:${targetAgent}`, taskData);
  return `✅ Task sent to ${targetAgent}: ${task}\n📋 ID: ${id}`;
}

async function sendTaskWithCapability(requiredCapability, task, type = 'network') {
  const agents = await redisCmd('SMEMBERS', 'agents:all');
  if (!agents) return 'No agents registered.';
  
  for (const agent of agents.split('\n').filter(a => a)) {
    if (agent === AGENT_NAME) continue;
    
    const data = await getAgentStatus(agent);
    if (!data) continue;
    
    if (new Date() - new Date(data.lastHeartbeat) > HEARTBEAT_INTERVAL * 3 * 1000) continue;
    
    let matched = false;
    if (type === 'network' && data.networkCapabilities?.some(c => c.toLowerCase().includes(requiredCapability.toLowerCase()))) matched = true;
    if (type === 'compute' && data.computeCapabilities?.some(c => c.toLowerCase().includes(requiredCapability.toLowerCase()))) matched = true;
    if (type === 'role' && data.roleCapabilities?.some(c => c.toLowerCase().includes(requiredCapability.toLowerCase()))) matched = true;
    
    if (matched) {
      const id = crypto.randomBytes(4).toString('hex');
      const taskData = JSON.stringify({ id, from: AGENT_NAME, to: agent, task, timestamp: new Date().toISOString(), status: 'pending', requiredCapability: requiredCapability });
      await redisCmd('RPUSH', `tasks:${agent}`, taskData);
      return `✅ Sent to ${agent} (${requiredCapability}): ${task}\n📋 ID: ${id}`;
    }
  }
  
  return `❌ No online agent with ${requiredCapability}`;
}

async function acknowledgeTask(taskId, fromAgent) {
  await redisCmd('SET', `ack:${taskId}`, JSON.stringify({ from: AGENT_NAME, timestamp: new Date().toISOString() }), 'EX', '60');
  return `✅ Acknowledged ${taskId}`;
}

async function completeTask(taskId) {
  const tasks = await redisCmd('LRANGE', `tasks:${AGENT_NAME}`, '0', '99');
  if (!tasks) return 'No tasks.';
  
  for (const t of tasks.split('\n').filter(t => t)) {
    try {
      const p = JSON.parse(t);
      if (p.id === taskId) {
        p.status = 'completed';
        p.completedAt = new Date().toISOString();
        const idx = tasks.split('\n').indexOf(t);
        await redisCmd('LSET', `tasks:${AGENT_NAME}`, idx, JSON.stringify(p));
        return `✅ Task ${taskId} completed`;
      }
    } catch {}
  }
  return 'Task not found';
}

async function getMyTasks() {
  const tasks = await redisCmd('LRANGE', `tasks:${AGENT_NAME}`, '0', '99');
  if (!tasks || !tasks.length) return 'No tasks.';
  
  return '📋 Tasks:\n' + tasks.split('\n').reverse().filter(t => t).map(t => {
    try {
      const p = JSON.parse(t);
      const icon = p.status === 'completed' ? '✅' : '⏳';
      return `${icon} [${p.status}] ${p.from}: ${p.task}\n   ID: ${p.id}`;
    } catch { return t; }
  }).join('\n');
}

// ============== SHARED MEMORIES ==============

async function shareMemory(content) {
  const id = crypto.randomBytes(4).toString('hex');
  await redisCmd('RPUSH', 'shared:memories', JSON.stringify({ id, agent: AGENT_NAME, content, timestamp: new Date().toISOString() }));
  return `✅ Memory: ${content.substring(0, 50)}...`;
}

async function getMemories(limit = 20) {
  const memories = await redisCmd('LRANGE', 'shared:memories', '0', String(limit - 1));
  if (!memories) return 'No memories.';
  return '📚 Memories:\n' + memories.split('\n').reverse().filter(m => m).map(m => {
    try { return `[${JSON.parse(m).timestamp.slice(0,16)}] ${JSON.parse(m).agent}: ${JSON.parse(m).content}`; }
    catch { return m; }
  }).join('\n');
}

// ============== HEARTBEAT ==============

function startHeartbeat() {
  console.log(`💓 Heartbeat for ${AGENT_NAME} (${HEARTBEAT_INTERVAL}s)`);
  heartbeat();
  setInterval(() => heartbeat().catch(e => console.error('❌', e.message)), HEARTBEAT_INTERVAL * 1000);
}

// ============== CLI ==============

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === '--heartbeat' || cmd === '-hbt') {
  startHeartbeat();
} else if (cmd === 'agents') {
  listAgents(args.includes('--detailed') || args.includes('-d')).then(console.log).catch(console.error);
} else if (cmd === 'register') {
  let n='', c='', r='';
  for (let i=1; i<args.length; i++) {
    if (args[i]==='-n' || args[i]==='--network') n = args[++i] || '';
    else if (args[i]==='-c' || args[i]==='--compute') c = args[++i] || '';
    else if (args[i]==='-r' || args[i]==='--role') r = args[++i] || '';
  }
  registerCapabilities(n, c, r).then(console.log).catch(console.error);
} else if (cmd === 'find') {
  const type = args.includes('-n') ? 'network' : args.includes('-c') ? 'compute' : args.includes('-r') ? 'role' : 'all';
  const cap = args.slice(1).filter(a => !a.startsWith('-')).join(' ');
  findAgents(cap, type).then(console.log).catch(console.error);
} else if (cmd === 'sync') {
  const target = args.includes('--to') ? args[args.indexOf('--to')+1] : null;
  syncPersonaFiles(target).then(console.log).catch(console.error);
} else if (cmd === 'persona') {
  const agent = args.includes('--agent') ? args[args.indexOf('--agent')+1] : null;
  getPersonaFiles(agent).then(console.log).catch(console.error);
} else if (cmd === 'send') {
  sendTask(args[1], args.slice(2).join(' ')).then(console.log).catch(console.error);
} else if (cmd === 'request') {
  const cap = args[1];
  const task = args.slice(2).join(' ');
  const type = args.includes('-n') ? 'network' : args.includes('-c') ? 'compute' : args.includes('-r') ? 'role' : 'network';
  sendTaskWithCapability(cap, task, type).then(console.log).catch(console.error);
} else if (cmd === 'ack') acknowledgeTask(args[1], args[2]).then(console.log).catch(console.error);
else if (cmd === 'complete') completeTask(args[1]).then(console.log).catch(console.error);
else if (cmd === 'my-tasks') getMyTasks().then(console.log).catch(console.error);
else if (cmd === 'memories') getMemories().then(console.log).catch(console.error);
else if (cmd === 'share-memory') shareMemory(args.slice(1).join(' ')).then(console.log).catch(console.error);
else if (cmd === 'status') getAgentStatus(AGENT_NAME).then(d => d ? console.log(JSON.stringify(d, null, 2)) : console.log('Not registered')).catch(console.error);
else console.log(`
🤖 Redis Collaboration Skill v2

🎭 Role + Network + Compute Capabilities

Usage:
  node index.js <command>

━━━ Agent ━━━
  agents [--detailed]     List agents
  status                 Show own status
  register -n -c -r      Register capabilities

━━━ Capabilities ━━━
  find <cap>             Find by any capability
  find -n <cap>         Find by network
  find -c <cap>         Find by compute
  find -r <cap>         Find by role

━━━ Persona ━━━
  sync [--to <agent>]   Sync persona files to Redis
  persona [--agent <a>]  Get persona files

━━━ Tasks ━━━
  send <agent> <task>   Send to agent
  request <cap> <task>  Auto-find & send
  ack <id> <from>       Acknowledge
  complete <id>          Complete
  my-tasks              View tasks

━━━ Memory ━━━
  share-memory <text>   Share memory
  memories              View memories

━━━ System ━━━
  --heartbeat           Start daemon
`);
