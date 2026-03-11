# Redis Shared Memory & Message Skill

Multi-machine collaboration skill for OpenClaw using Redis.

## Features

- 🧠 **Shared Memory** - Share memories across all OpenClaw instances
- 📬 **Message Passing** - Send tasks with ACK confirmation
- 🔔 **Real-time Notifications** - Pub/Sub based messaging

## Setup

Set environment variable:
```bash
export REDIS_URL="redis://:OpenClaw2026!@43.131.241.215:6379"
```

Or create `~/.openclaw/.env`:
```
REDIS_URL=redis://:OpenClaw2026!@43.131.241.215:6379
```

## Commands

| Command | Description |
|---------|-------------|
| `/share-memory <content>` | Share a memory to all agents |
| `/memories` | View all shared memories |
| `/send-task <agent> <task>` | Send task with ACK confirmation |
| `/ack <taskId> <fromAgent>` | Acknowledge receiving a task |
| `/complete <taskId>` | Mark task as completed |
| `/my-tasks` | View your pending tasks |
| `/broadcast <message>` | Broadcast message to all agents |
| `/agents` | List all online agents |

## ACK Flow

```
1. Sender calls /send-task
2. Task stored in Redis (status: pending)
3. Real-time event published
4. Recipient receives → calls /ack <taskId> <sender>
5. Sender gets ACK confirmation
6. Recipient processes task → calls /complete <taskId>
```

## Task Status

| Status | Description |
|--------|-------------|
| ⏳ pending | Task sent, waiting for ACK |
| ✅ acknowledged | Recipient confirmed receipt |
| ✅ completed | Task finished |

## Usage Examples

```
/share-memory 今天是周三，讨论了分布式部署方案
/send-task 国内机器 分析一下这个代码
/ack abc123 国外机器
/complete abc123
/broadcast 开始今天的任务
/my-tasks
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| REDIS_URL | Redis connection string | Required |
| AGENT_NAME | Your agent name | hostname |

## Redis Data Structure

- `shared:memories` - List of shared memories
- `tasks:<agent>` - Task queue per agent
- `ack:<taskId>` - ACK confirmation (TTL 60s)
- `agent:*` - Online agent registration (TTL 5min)
- `collab:broadcasts` - Broadcast message history
