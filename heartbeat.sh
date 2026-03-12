#!/bin/bash

REDIS_HOST="43.131.241.215"
REDIS_PASSWORD="OpenClaw2026!"
REDIS_PORT="6379"
AGENT_NAME="MacStudio-本地"
NETWORK_CAPS="小红书,微博,抖音,百度,知乎,GitHub,Bilibili"

echo "💓 Starting heartbeat for $AGENT_NAME"
echo "Redis: $REDIS_HOST:$REDIS_PORT"
echo "功能: 静态硬件 + 实时算力监控"

while true; do
    TIMESTAMP=$(date +%s)
    
    # 获取 CPU 使用率 (使用更简单的方法)
    CPU_USAGE=$(ps -A -o %cpu | awk '{s+=$1} END {printf "%.1f", s}')
    
    # 获取内存使用情况
    MEM_TOTAL=$(echo "96 * 1024" | bc)  # 96GB in MB
    MEM_PRESSURE=$(memory_pressure 2>/dev/null | grep "System-wide memory free percentage" | awk '{print $5}' | tr -d '%' || echo "50")
    MEM_USED=$(echo "scale=0; $MEM_TOTAL * (100 - $MEM_PRESSURE) / 100" | bc)
    MEM_FREE=$(echo "scale=0; $MEM_TOTAL * $MEM_PRESSURE / 100" | bc)
    
    # 获取负载
    LOAD=$(uptime | awk -F'load averages:' '{print $2}' | awk '{print $1}' | tr -d ',')
    
    # 进程数
    PROCS=$(ps -e | wc -l | tr -d ' ')
    
    # 根据负载确定可用性等级
    LOAD_INT=${LOAD%.*}
    if [ -z "$LOAD_INT" ]; then LOAD_INT=0; fi
    if [ "$LOAD_INT" -lt 10 ]; then
        AVAIL_COMPUTE="M3-Ultra(空闲),96GB-RAM,28-Core"
    elif [ "$LOAD_INT" -lt 20 ]; then
        AVAIL_COMPUTE="M3-Ultra(轻载),96GB-RAM,28-Core"
    elif [ "$LOAD_INT" -lt 40 ]; then
        AVAIL_COMPUTE="M3-Ultra(中载),96GB-RAM,28-Core"
    else
        AVAIL_COMPUTE="M3-Ultra(高载),96GB-RAM,28-Core"
    fi
    
    ALL_CAPS="${NETWORK_CAPS},${AVAIL_COMPUTE}"
    
    # 构建状态信息
    STATUS_INFO="CPU:${CPU_USAGE}%|Load:${LOAD}|Mem:${MEM_USED}MB/${MEM_TOTAL}MB|Procs:${PROCS}"
    
    # Set agent data
    redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD \
        hset agent:$AGENT_NAME \
        name "$AGENT_NAME" \
        timestamp "$TIMESTAMP" \
        capabilities "$ALL_CAPS" \
        compute "$AVAIL_COMPUTE" \
        status "online" \
        metrics "$STATUS_INFO" \
        > /dev/null 2>&1
    
    # Set TTL
    redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD \
        expire agent:$AGENT_NAME 90 \
        > /dev/null 2>&1
    
    # Add to agents set
    redis-cli -h $REDIS_HOST -p $REDIS_PORT -a $REDIS_PASSWORD \
        sadd agents:all "$AGENT_NAME" \
        > /dev/null 2>&1
    
    echo "[$(date '+%H:%M:%S')] $STATUS_INFO | $AVAIL_COMPUTE ✅"
    
    sleep 30
done
