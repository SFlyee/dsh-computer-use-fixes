#!/usr/bin/env bash
# 安装 dsh-computer-use-fixes 到 harness-desktop（home 级用户 patch 层）。
#
# 原理（dsh profile-boot）：
#   patch 层顺序 = bundle → profile 层 → HOME 层（$DSH_HOME/cordis.patch.yml）→ --patch
#   我们在 HOME 层 insert 插件，不修改任何 profile 配置，卸载也干净。
#
# 用法: ./install.sh [--dry-run]    卸载: ./uninstall.sh
set -euo pipefail

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/harness-desktop/dsh-home}"
SRC="$(cd "$(dirname "$0")" && pwd)"

echo "== dsh-computer-use-fixes install (home patch layer) =="
echo "  DSH_HOME: $DSH_HOME"
echo "  source  : $SRC"

# 1. 链接插件包到 profile 的 node_modules（加载器从 profile node_modules 解析插件名）
NM_DIR="$DSH_HOME/profiles/web/node_modules"
[ -d "$NM_DIR" ] || { echo "错误: 未找到 $NM_DIR"; exit 1; }
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] ln -sfn $SRC -> $NM_DIR/dsh-computer-use-fixes"
else
  ln -sfn "$SRC" "$NM_DIR/dsh-computer-use-fixes"
  echo "  [ok] 插件包已链接"
fi

# 2. 在 home 级 patch 层注册（幂等：已存在则跳过）
PATCH="$DSH_HOME/cordis.patch.yml"
if [ "$DRY_RUN" = 1 ]; then
  echo "  [dry-run] 写入 $PATCH : insert dsh-computer-use-fixes"
else
  touch "$PATCH"
  if grep -q "dsh-computer-use-fixes" "$PATCH"; then
    echo "  [ok] $PATCH 已含 dsh-computer-use-fixes（跳过）"
  else
    {
      printf '# dsh-computer-use-fixes 用户级注册（install.sh 生成）\n'
      printf -- '- insert:\n'
      printf '    - id: dsh-computer-use-fixes\n'
      printf '      name: dsh-computer-use-fixes\n'
      printf '      config:\n'
      printf '        ttlMs: 15000\n'
      printf '        maxElements: 500\n'
    } >> "$PATCH"
    echo "  [ok] 已写入 $PATCH"
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "== 预演完成（未写入任何文件）=="
else
  echo "== 安装完成，请重启 harness-desktop 生效 =="
fi
