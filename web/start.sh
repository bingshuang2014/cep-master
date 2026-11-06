#!/system/bin/sh
# CPE Pilot 启动脚本：已在跑就直接返回，否则后台拉起并等待健康检查
set -u
cd "$(dirname "$0")" || exit 1

if curl -sf -m 2 http://127.0.0.1:8090/healthz >/dev/null 2>&1; then
  echo "CPE Pilot 已在运行：http://127.0.0.1:8090"
  exit 0
fi

setsid node server.mjs >>server.log 2>&1 &
sleep 1.2
if curl -sf -m 2 http://127.0.0.1:8090/healthz >/dev/null 2>&1; then
  echo "CPE Pilot 已启动"
  grep -o 'http://[0-9.]*:8090' server.log | sort -u
else
  echo "启动失败，查看 server.log：" >&2
  tail -n 20 server.log >&2
  exit 1
fi
