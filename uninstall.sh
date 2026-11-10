#!/usr/bin/env bash
# 卸载 dsh-computer-use-fixes（移除 home patch 层注册 + 插件链接）。
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/Library/Application Support/harness-desktop/dsh-home}"
PATCH="$DSH_HOME/cordis.patch.yml"

echo "== dsh-computer-use-fixes uninstall =="

if [ -f "$PATCH" ]; then
  python3 - "$PATCH" <<'PY'
import sys, re
p = sys.argv[1]
s = open(p).read()
before = s
s = re.sub(r"\n?# dsh-computer-use-fixes 用户级注册（install\.sh 生成）\n(?:- insert:\n(?:[ \t]+.*\n?)*)", "\n", s, count=1)
s = s.strip("\n") + "\n"
open(p, "w").write(s)
print("  [ok] 已从", p, "移除注册块" if s != before else "（未找到注册块）")
PY
else
  echo "  [skip] 无 patch 文件"
fi

rm -f "$DSH_HOME/profiles/web/node_modules/dsh-computer-use-fixes"
echo "== 卸载完成，请重启 harness-desktop 生效 =="
