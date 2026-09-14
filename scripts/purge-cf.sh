#!/usr/bin/env bash
# purge-cf.sh —— 前端发布后的 Cloudflare 缓存清理（卦灵前端流程的固定最后一步）
#
# 为什么要有它：此前流程里写着「发布后必须 purge」，却没有任何可执行手段——
# 一个跑不了的步骤等于没写。本脚本让这一步变成 `npm run purge:cf`。
#
# token 来源（按优先级）：
#   1) 环境变量 CF_TOKEN
#   2) 文件 ~/.cf_token（权限 600，不进仓库、不进 git）
# 注意：不要用 Cloudflare 的 /user/tokens/verify 端点判断本 token 是否有效——
#       该端点只验「用户级」token，对 zone 级 scoped token 必然返回 Invalid API Token（假阴性）。
#       判断有效性请直接读 zone：GET /zones/<ZONE>。
set -euo pipefail

ZONE="${CF_ZONE:-8a8550fa2d1423bccd1d6364b16f0acf}"
TOKEN_FILE="${CF_TOKEN_FILE:-$HOME/.cf_token}"

if [ -n "${CF_TOKEN:-}" ]; then
  TOKEN="$CF_TOKEN"
elif [ -f "$TOKEN_FILE" ]; then
  TOKEN="$(cat "$TOKEN_FILE")"
else
  echo "✗ 找不到 Cloudflare token。" >&2
  echo "  请把它写入 $TOKEN_FILE（chmod 600），或设置环境变量 CF_TOKEN。" >&2
  exit 1
fi

echo "→ 读取 zone $ZONE 以确认 token 可用…"
WHO=$(curl -s -m 20 "https://api.cloudflare.com/client/v4/zones/$ZONE" -H "Authorization: Bearer $TOKEN")
case "$WHO" in
  *'"success":true'*) : ;;
  *) echo "✗ token 不可用或无权访问该 zone。原始响应：" >&2; echo "$WHO" >&2; exit 1 ;;
esac

echo "→ purge_everything…"
RESP=$(curl -s -m 30 -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/purge_cache" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{"purge_everything":true}')
echo "  $RESP"
case "$RESP" in
  *'"success":true'*) echo "✅ Cloudflare 缓存已清空（zone $ZONE）" ;;
  *) echo "✗ purge 失败，响应见上" >&2; exit 1 ;;
esac
