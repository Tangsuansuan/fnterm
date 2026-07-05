#!/bin/bash
# FnTerm v2.0 - FPK 打包脚本
# 用法: bash build.sh
# 依赖: fnpack 工具已安装 (https://developer.fnnas.com/)

set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="fnterm"

echo "=== FnTerm v2.0 打包 ==="
echo "项目目录: $APP_DIR"
echo ""

# 检查 fnpack 是否可用
if ! command -v fnpack &> /dev/null; then
    echo "❌ 未找到 fnpack 命令"
    echo "请从 https://developer.fnnas.com/ 下载 fnpack 并安装"
    exit 1
fi

echo "📦 开始构建..."
cd "$(dirname "$APP_DIR")"

fnpack build "$APP_NAME"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ 打包成功！"
    FPK_FILE="$(ls -t *.fpk 2>/dev/null | head -1)"
    if [ -n "$FPK_FILE" ]; then
        echo "📦 输出文件: $(pwd)/$FPK_FILE"
        echo "   大小: $(du -h "$FPK_FILE" | cut -f1)"
    fi
else
    echo "❌ 打包失败"
    exit 1
fi
