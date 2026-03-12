# Redis Collaboration Skill for OpenClaw

分布式多智能体协作系统，支持任务分发、Sub-Agent 执行和 Agent Reach 集成。

## 功能特性

- 💓 **心跳机制** - 实时在线/离线检测
- 🌐 **网络能力注册** - 注册特定网络访问能力（小红书、Google 等）
- 💻 **计算能力注册** - 注册硬件资源（GPU、RAM 等）
- 🔍 **智能任务路由** - 自动匹配具备所需能力的 Agent
- 🤖 **Sub-Agent 执行** - 主 Agent 派发任务，Sub-Agent 执行
- 📱 **Agent Reach 集成** - 支持小红书、Twitter、GitHub 等社交平台搜索
- 🧠 **共享内存** - 跨 Agent 共享记忆
- ✅ **ACK 确认机制** - 确保任务送达确认

## 架构概览

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Mac本地   │     │  国内服务器  │     │  海外服务器  │
│ (小红书)   │     │ (微博/抖音) │     │ (Google)  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                   ┌────────▼────────┐
                   │     Redis       │
                   │  - 能力注册      │
                   │  - 任务队列      │
                   │  - 共享记忆      │
                   └─────────────────┘
                            │
                   ┌────────▼────────┐
                   │  Main Agent     │
                   │  (Orchestrator) │
                   └────────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌─────────┐   ┌─────────┐   ┌─────────┐
        │Sub-Agent│   │Sub-Agent│   │Sub-Agent│
        │执行工具  │   │执行工具  │   │执行工具  │
        └─────────┘   └─────────┘   └─────────┘
```

## 安装

### 1. 克隆仓库

```bash
git clone https://github.com/zfw1226/redis-collab.git
cd redis-collab
npm install
```

### 2. 配置 Redis

在 `~/.openclaw/.env` 或环境变量中配置：

```bash
export REDIS_HOST="your-redis-ip"
export REDIS_PASSWORD="your-password"
export REDIS_PORT="6379"
export AGENT_NAME="your-agent-name"
export HEARTBEAT_INTERVAL="30"
```

### 3. 配置 Agent Reach（可选，用于社交平台搜索）

**安装 Agent Reach：**

```bash
# 创建 conda 环境
conda create -n agent-reach python=3.11
conda activate agent-reach
pip install agent-reach
```

**配置 PATH：**

在 `~/.openclaw/.env` 中添加：
```bash
export PATH=/opt/anaconda3/envs/agent-reach/bin:$PATH
```

**启动小红书 MCP 服务（Docker）：**

```bash
docker run -d --name xiaohongshu-mcp \
  -p 18060:18060 \
  -v $(pwd)/cookies.json:/app/cookies.json \
  xpzouying/xiaohongshu-mcp
```

### 4. 验证配置

```bash
# 测试 Redis 连接
redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD ping

# 测试 Agent Reach
agent-reach --version

# 测试小红书 MCP
curl http://localhost:18060/mcp
```

## 使用方法

### 启动 Auto 模式

```bash
# 设置环境变量并启动
export REDIS_HOST=your-redis-ip
export REDIS_PASSWORD=your-password
export REDIS_PORT=6379
export AGENT_NAME=MacStudio-本地
export HEARTBEAT_INTERVAL=30

node index.cjs --auto
```

### 命令列表

| 命令 | 说明 | 示例 |
|------|------|------|
| `agents` | 列出在线 Agent | `node index.cjs agents --detailed` |
| `register` | 注册能力 | `node index.cjs register -n 小红书,微博` |
| `find` | 查找具备能力的 Agent | `node index.cjs find 小红书` |
| `send` | 发送任务 | `node index.cjs send 目标Agent "任务内容"` |
| `tasks` | 查看我的任务 | `node index.cjs tasks` |
| `complete` | 完成任务 | `node index.cjs complete taskId "结果"` |
| `status` | 查看状态 | `node index.cjs status` |

### 查看待派发任务

```bash
node task-dispatcher.js list
node task-dispatcher.js dispatch
```

## 工具优先级策略

Sub-Agent 执行任务时，按以下优先级选择工具：

### Priority 1 - Agent Reach（社交平台）

支持的平台：
- 小红书 (`search-xhs`)
- Twitter (`search-twitter`)
- Instagram (`search-instagram`)
- YouTube (`search-youtube`)
- Bilibili (`search-bilibili`)
- GitHub (`search-github`)
- LinkedIn (`search-linkedin`)
- Boss直聘 (`search-bosszhipin`)

通用功能：
- 网页读取 (`read`) - 读取任意 URL
- 通用搜索 (`search`) - 综合多平台搜索

**使用示例：**
```bash
agent-reach search-xhs "AI工具推荐"
agent-reach read "https://example.com"
agent-reach search "量子计算"
```

### Priority 2 - MCP Search

- Tavily MCP: `mcporter call tavily.tavily_search query="关键词"`
- MiniMax MCP: `mcporter call minimax-coding.web_search query="关键词"`

### Priority 3 - Browser

用于需要复杂交互或登录的场景。

## Sub-Agent 执行流程

```
1. Auto Processor 检测 Redis 任务队列中的 pending 任务
        ↓
2. 创建任务目录 task-executions/<task-id>/
   - task.txt: 任务描述
   - prompt.txt: 系统提示词（含工具优先级）
   - meta.json: 任务元数据
        ↓
3. 主 Agent (Orchestrator) 检测待派发任务
        ↓
4. 派生 Sub-Agent 执行任务
   - 读取 prompt.txt 了解工具优先级
   - 选择合适的工具执行任务
   - 将结果写入 task.txt.result
   - 记录工具到 tools.json
        ↓
5. Auto Processor 检测结果，标记任务完成
        ↓
6. 通知任务发送方
```

## 配置示例

### task-config.yaml

```yaml
WHITELIST:
  - "search*": "搜索类任务"
  - "fetch*": "数据获取类任务"
  - "read*": "读取文件/网页类任务"

BLACKLIST:
  - "delete*": "删除操作"
  - "rm *": "删除命令"
  - "exec*": "执行任意命令"

FEISHU:
  enabled: true

CONFIRM_TIMEOUT: 300
RETRY:
  max_attempts: 3
  delay_seconds: 10
```

### mcporter.json（MCP 配置）

```json
{
  "mcpServers": {
    "xiaohongshu": {
      "baseUrl": "http://localhost:18060/mcp"
    },
    "tavily": {
      "baseUrl": "https://mcp.tavily.com/mcp/?tavilyApiKey=YOUR_KEY"
    },
    "minimax-coding": {
      "command": "uvx minimax-coding-plan-mcp -y",
      "env": {
        "MINIMAX_API_KEY": "YOUR_KEY"
      }
    }
  }
}
```

## 故障排除

### 问题 1: Agent Reach 命令未找到

**症状：** `command not found: agent-reach`

**解决：**
```bash
# 检查 PATH 配置
echo $PATH | grep agent-reach

# 手动激活环境
source /opt/anaconda3/etc/profile.d/conda.sh
conda activate agent-reach

# 或更新 ~/.openclaw/.env
export PATH=/opt/anaconda3/envs/agent-reach/bin:$PATH
```

### 问题 2: 小红书 MCP 超时

**症状：** `xiaohongshu.search_feeds timed out`

**解决：**
```bash
# 检查 Docker 容器
docker ps | grep xiaohongshu

# 查看日志
docker logs xiaohongshu-mcp --tail 20

# 重启服务
docker restart xiaohongshu-mcp
```

**注意：** 小红书搜索响应时间较长（30-60秒），需要设置足够长的超时。

### 问题 3: Redis 连接失败

**症状：** `Redis connection failed`

**解决：**
```bash
# 测试连接
redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD ping

# 检查环境变量
echo $REDIS_HOST $REDIS_PORT
```

### 问题 4: Sub-Agent 没有使用 Agent Reach

**症状：** Sub-Agent 直接使用 browser 而不是 Agent Reach

**解决：**
- 检查 `prompt.txt` 是否正确生成
- 确保 Agent Reach 在 PATH 中可用
- 重启 OpenClaw 使配置生效

## 文件结构

```
redis-collab/
├── index.cjs                    # 主入口（CommonJS）
├── index.esm.js                 # ES Module 版本
├── task-processor.js            # 任务处理器
├── sub-agent-orchestrator.js    # Sub-Agent 编排器
├── task-dispatcher.js           # 任务派发 CLI
├── openclaw-bridge.js           # OpenClaw 桥接
├── task-config.yaml             # 任务配置
├── SKILL.md                     # Skill 文档
├── package.json
└── task-executions/             # 任务执行目录
    └── <task-id>/
        ├── task.txt             # 任务描述
        ├── prompt.txt           # 系统提示词
        ├── meta.json            # 任务元数据
        ├── task.txt.result      # 执行结果
        └── tools.json           # 使用工具记录
```

## Redis 数据结构

| Key | 类型 | 说明 |
|-----|------|------|
| `agent:<name>` | String | Agent 数据（TTL: 90s） |
| `agents:all` | Set | 所有注册 Agent |
| `tasks:<agent>` | List | Agent 的任务队列 |
| `execution:<id>` | String | 任务执行状态 |
| `shared:memories` | List | 共享记忆 |

## 贡献

欢迎提交 Issue 和 PR！

## 许可证

MIT

## 作者

- OpenClaw Skill 封装
- 基于 Redis 和 Agent Reach 构建
