# FnTerm

飞牛 fnOS 的 SSH 网页终端。浏览器里直接连服务器敲命令，带侧边栏文件管理。

## 功能

- SSH 远程连接，填 IP 账号密码就能用
- xterm.js 终端模拟，256 色 + True Color
- 侧边栏文件管理：浏览、预览、上传、下载、删除
- 拖拽上传
- 自动重连

## 安装

1. 下载 [Releases](https://github.com/Tangsuansuan/fnterm/releases) 里的 `fnterm.fpk`
2. fnOS 应用中心 → 手动安装 → 选 fpk 文件
3. 需要 Node.js v22（应用市场自动安装）

## 使用

浏览器打开 `http://你的NAS:8099`，输入目标服务器 IP、用户名、密码，连上就能敲命令。

## 技术栈

- 前端：xterm.js 5.5
- 后端：Node.js + Express + ws + ssh2
- 协议：WebSocket（终端）+ REST API（文件操作）

## 开发

```bash
# 安装 fnpack（https://developer.fnnas.com/docs/cli/fnpack）
fnpack build
```

## License

MIT
