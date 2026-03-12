# Redis Collaboration Skill for OpenClaw

Multi-machine distributed collaboration system with network/compute capability awareness.

## Features

- 💓 **Heartbeat** - Real-time online/offline detection
- 🌐 **Network Capabilities** - Register access to specific networks (小红书, Google, etc)
- 💻 **Compute Capabilities** - Register hardware resources (GPU, RAM, etc)
- 🔍 **Smart Routing** - Auto-find agents with required capabilities
- 🧠 **Shared Memory** - Share memories across all agents
- 📬 **Task Distribution** - Send tasks with ACK confirmation
- ✅ **ACK Mechanism** - Ensures task delivery confirmation

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Mac本地   │     │  国内服务器  │     │  海外服务器  │
│ (小红书)   │     │ (微博/抖音) │     │ (Google)  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                    │                    │
       │  🌐 小红书         │  🌐 微博/抖音      │  🌐 Google
       └───────────────────┼────────────────────┘
                          │
                  ┌───────▼───────┐
                  │     Redis      │
                  │  能力注册      │
                  │  任务队列      │
                  │  共享记忆      │
                  └───────────────┘
```

## Setup

### 1. Install Redis

On one machine (recommended: machine with public IP):

```bash
# Using Docker
docker run -d --name redis \
  -p 6379:6379 \
  -v redis-data:/data \
  redis:7-alpine \
  redis-server --appendonly yes --requirepass YOUR_PASSWORD --protected-mode no
```

### 2. Configure Environment Variables

### 3. Install Dependencies

```bash
npm install
```


```bash
# Required
export REDIS_HOST="your-redis-ip"
export REDIS_PASSWORD="your-password"

# Optional
export REDIS_PORT="6379"
export AGENT_NAME="agent-name"
export HEARTBEAT_INTERVAL="30"
```

Or create `~/.openclaw/.env`:

```
REDIS_HOST=43.131.241.215
REDIS_PASSWORD=your-password
REDIS_PORT=6379
AGENT_NAME=机器A
HEARTBEAT_INTERVAL=30
```

### 4. Install Skill

```bash
cp -r redis-collab /root/.openclaw/workspace/skills/
```

## Commands

### Agent Management

| Command | Description |
|---------|-------------|
| `agents` | List online agents |
| `agents --detailed` | Detailed view with all capabilities |
| `status` | Show own status |

### Capabilities

| Command | Description |
|---------|-------------|
| `register -n <caps>` | Register network capabilities |
| `register -c <caps>` | Register compute capabilities |
| `find <cap>` | Find agents by capability |
| `find -n <cap>` | Find by network only |
| `find -c <cap>` | Find by compute only |

### Messaging

| Command | Description |
|---------|-------------|
| `memories` | View shared memories |
| `share-memory <content>` | Share a memory |
| `broadcast <message>` | Broadcast to all |

### Tasks

| Command | Description |
|---------|-------------|
| `send <agent> <task>` | Send to specific agent |
| `request <cap> <task>` | Auto-find capable agent & send |
| `ack <taskId> <from>` | Acknowledge task |
| `complete <taskId>` | Mark complete |
| `my-tasks` | View pending tasks |

## Usage Examples

### Register Capabilities

```bash
# 本地 Mac - 能上小红书
node index.js register -n 小红书,微博,抖音

# 国内服务器 - 微博抖音 + 强计算
node index.js register -n 微博,抖音 -c A100,64GB

# 海外服务器 - Google + 强计算
node index.js register -n Google,YouTube,Twitter -c A100,64GB
```

### Find Agents

```bash
# 找能上小红书的机器
node index.js find 小红书

# 找有A100的机器
node index.js find -c A100

# 找能上Google的机器
node index.js find -n Google
```

### Smart Task Routing

```bash
# 自动找有能力的机器执行任务
node index.js request 小红书 搜索最新热点
node index.js request -n Google 搜索AI新闻
node index.js request -c A100 运行这个模型
```

### Start Heartbeat

```bash
# 后台运行心跳
node index.js --heartbeat &
```

## Network vs Compute Capabilities

### 🌐 Network Capabilities (网络能力)

Things that depend on **where the machine is located**:

| Capability | Description |
|------------|-------------|
| 小红书 | Access to xiaohongshu.com |
| 微博 | Access to weibo.com |
| 抖音 | Access to douyin.com |
| Google | Access to google.com |
| YouTube | Access to youtube.com |
| Twitter | Access to twitter.com |
| GitHub | Access to github.com |
| 百度 | Access to baidu.com |
| 知乎 | Access to zhihu.com |

### 💻 Compute Capabilities (计算能力)

Things that depend on **hardware resources**:

| Capability | Description |
|------------|-------------|
| A100 | NVIDIA A100 GPU |
| A6000 | NVIDIA A6000 GPU |
| 4090 | NVIDIA RTX 4090 |
| 3090 | NVIDIA RTX 3090 |
| 64GB | 64GB+ RAM |
| 128GB | 128GB+ RAM |
| 多核 | Multi-core CPU |

## Task Flow

```
用户 → request 小红书 热点
   ↓
自动查找 → 找到"本地Mac"(有小红书能力)
   ↓
发送任务 → 本地Mac的任务队列
   ↓
本地Mac → 处理任务 → 返回结果
   ↓
完成
```

## ACK Flow

```
Sender                              Recipient
   │                                    │
   │─── send/request ──────────────►│
   │    (task in Redis queue)          │
   │                                    │
   │◄─── ack ────────────────────────│
   │    (confirmation)                 │
   │                                    │
   │─── complete ──────────────────►│
   │    (task done)                    │
```

## Redis Data Structure

| Key | Type | Description |
|-----|------|-------------|
| `agent:<name>` | String | Agent data (TTL: 90s) |
| `agents:all` | Set | All registered agents |
| `tasks:<agent>` | List | Task queue per agent |
| `ack:<taskId>` | String | ACK (TTL: 60s) |
| `shared:memories` | List | Shared memories |
| `collab:broadcasts` | List | Broadcast messages |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| REDIS_HOST | Yes | - | Redis server IP |
| REDIS_PASSWORD | Redis password |
| Yes | - | REDIS_PORT | No | 6379 | Redis port |
| AGENT_NAME | No | hostname | Agent name |
| HEARTBEAT_INTERVAL | No | 30 | Heartbeat seconds |

## Troubleshooting

### Connection Failed
```bash
# Check Redis
docker ps | grep redis

# Test connection
redis-cli -h $REDIS_HOST -p 6379 -a YOUR_PASSWORD ping
```

### No Agents Found
```bash
# Register first
node index.js register -n 小红书,微博

# Start heartbeat
node index.js --heartbeat &

# Check agents
node index.js agents --detailed
```

## License

MIT
