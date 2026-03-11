#!/usr/bin/env node

import { exec } from 'child_process';
import os from 'os';
import crypto from 'crypto';

const AGENT_NAME = process.env.AGENT_NAME || os.hostname();
const REDIS_HOST = process.env.REDIS_HOST || '43.131.241.215';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || 'OpenClaw2026!';
const REDIS_CLI = process.env.REDIS_CLI || '/usr/bin/redis-cli';
const TASK_TIMEOUT_SECONDS = 60;

function redisCmd(...args) {
  return new Promise((resolve, reject) => {
    const cmd = [REDIS_CLI, '-h', REDIS_HOST, '-p', REDIS_PORT, '-a', REDIS_PASSWORD, ...args];
    exec(cmd.join(' '), (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

// ============== SHARED MEMORIES ==============

async function shareMemory(content) {
  const id = crypto.randomBytes(4).toString('hex');
  const timestamp = new Date().toISOString();
  const memory = JSON.stringify({ id, agent: AGENT_NAME, content, timestamp });
  
  await redisCmd('RPUSH', 'shared:memories', memory);
  await redisCmd('PUBLISH', 'collab:events', JSON.stringify({ type: 'memory', agent: AGENT_NAME }));
  
  return `✅ Memory shared: ${content.substring(0, 50)}...`;
}

async function getMemories() {
  const memories = await redisCmd('LRANGE', 'shared:memories', '0', '99');
  if (!memories || memories.length === 0) return 'No shared memories yet.';
  
  const list = memories.split('\n').reverse().filter(m => m).map(m => {
    try {
      const p = JSON.parse(m);
      return `[${p.timestamp.slice(0,16)}] ${p.agent}: ${p.content}`;
    } catch { return m; }
  }).join('\n');
  
  return `📚 Shared Memories:\n${list}`;
}

// ============== TASKS WITH ACK ==============

async function sendTask(targetAgent, task) {
  const id = crypto.randomBytes(4).toString('hex');
  const timestamp = new Date().toISOString();
  
  const taskData = JSON.stringify({ 
    id, 
    from: AGENT_NAME, 
    to: targetAgent, 
    task, 
    timestamp,
    status: 'pending'
  });
  
  await redisCmd('RPUSH', `tasks:${targetAgent}`, taskData);
  await redisCmd('PUBLISH', 'collab:events', JSON.stringify({ 
    type: 'task_new', 
    to: targetAgent, 
    from: AGENT_NAME,
    taskId: id 
  }));
  
  return `✅ Task sent to ${targetAgent}: ${task}\n📋 Task ID: ${id}`;
}

async function acknowledgeTask(taskId, fromAgent) {
  const ackKey = `ack:${taskId}`;
  await redisCmd('SET', ackKey, JSON.stringify({
    from: AGENT_NAME,
    timestamp: new Date().toISOString()
  }), 'EX', '60');
  
  return `✅ Acknowledged task ${taskId}`;
}

async function completeTask(taskId) {
  const tasks = await redisCmd('LRANGE', `tasks:${AGENT_NAME}`, '0', '99');
  if (!tasks) return 'No tasks found.';
  
  const taskList = tasks.split('\n').filter(t => t);
  for (const t of taskList) {
    try {
      const p = JSON.parse(t);
      if (p.id === taskId) {
        p.status = 'completed';
        p.completedAt = new Date().toISOString();
        const idx = taskList.indexOf(t);
        await redisCmd('LSET', `tasks:${AGENT_NAME}`, idx, JSON.stringify(p));
        return `✅ Task ${taskId} marked as completed`;
      }
    } catch {}
  }
  return 'Task not found';
}

async function getMyTasks() {
  const tasks = await redisCmd('LRANGE', `tasks:${AGENT_NAME}`, '0', '99');
  if (!tasks || tasks.length === 0) return 'No pending tasks.';
  
  const list = tasks.split('\n').reverse().filter(t => t).map(t => {
    try {
      const p = JSON.parse(t);
      const icon = p.status === 'completed' ? '✅' : '⏳';
      return `${icon} [${p.status}] From ${p.from}: ${p.task}\n   ID: ${p.id}`;
    } catch { return t; }
  }).join('\n');
  
  return `📋 Your Tasks:\n${list}`;
}

// ============== BROADCAST ==============

async function broadcast(message) {
  const msg = JSON.stringify({
    type: 'broadcast',
    from: AGENT_NAME,
    message,
    timestamp: new Date().toISOString()
  });
  
  await redisCmd('RPUSH', 'collab:broadcasts', msg);
  await redisCmd('PUBLISH', 'collab:events', 'broadcast');
  
  return `📢 Broadcast sent: ${message}`;
}

// ============== AGENTS ==============

async function listAgents() {
  await redisCmd('SETEX', `agent:${AGENT_NAME}`, '300', new Date().toISOString());
  const keys = await redisCmd('KEYS', 'agent:*');
  const agents = keys.split('\n').filter(k => k).map(k => k.replace('agent:', ''));
  
  if (agents.length === 0) return 'No agents online.';
  return `🤖 Online Agents: ${agents.join(', ')}`;
}

// CLI mode
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'share-memory') {
  shareMemory(args.slice(1).join(' ')).then(console.log).catch(console.error);
} else if (cmd === 'memories') {
  getMemories().then(console.log).catch(console.error);
} else if (cmd === 'send-task') {
  const agent = args[1];
  const task = args.slice(2).join(' ');
  sendTask(agent, task).then(console.log).catch(console.error);
} else if (cmd === 'ack') {
  acknowledgeTask(args[1], args[2]).then(console.log).catch(console.error);
} else if (cmd === 'complete') {
  completeTask(args[1]).then(console.log).catch(console.error);
} else if (cmd === 'my-tasks') {
  getMyTasks().then(console.log).catch(console.error);
} else if (cmd === 'broadcast') {
  broadcast(args.slice(1).join(' ')).then(console.log).catch(console.error);
} else if (cmd === 'agents') {
  listAgents().then(console.log).catch(console.error);
}
