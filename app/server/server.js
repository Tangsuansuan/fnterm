#!/usr/bin/env node
/**
 * FnTerm v2.0 — SSH Web Terminal + File Manager
 * =============================================
 * 架构:
 *   Browser ←──WebSocket──→ Server ←──SSH──→ Remote Host
 *   Browser ←──REST API──→ Server ←──SFTP──→ Remote Host
 *
 * API 端点:
 *   POST /api/connect         建立 SSH 连接
 *   POST /api/disconnect      断开连接
 *   GET  /api/status          连接状态
 *   GET  /api/files/list      列出目录
 *   GET  /api/files/read      读取文件内容(预览)
 *   GET  /api/files/download  下载文件
 *   POST /api/files/upload    上传文件
 *   POST /api/files/mkdir     创建目录
 *   DELETE /api/files/delete  删除文件
 *   WS   /ws                  终端 Shell
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const stream = require('stream');

// ============ 配置 ============
const PORT = parseInt(process.env.TRIM_SERVICE_PORT, 10) || 8099;
const HOST = '0.0.0.0';
const UPLOAD_DIR = path.join(os.tmpdir(), 'fnterm-uploads');

// ============ Express 初始化 ============
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer 配置（文件上传到临时目录）
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// ============ 会话管理 ============
class SSHSession {
    constructor() {
        this.client = null;
        this.sftpClient = null;
        this.connected = false;
        this.host = '';
        this.username = '';
        this.connectedAt = null;
    }

    connect(host, port, username, password) {
        return new Promise((resolve, reject) => {
            this.client = new Client();
            this.host = host;
            this.username = username;

            const timeout = setTimeout(() => {
                this.client.end();
                reject(new Error('SSH 连接超时'));
            }, 15000);

            this.client.on('ready', () => {
                clearTimeout(timeout);
                this.connected = true;
                this.connectedAt = new Date();
                console.log(`[FnTerm] SSH 已连接到 ${username}@${host}:${port}`);
                resolve();
            });

            this.client.on('error', (err) => {
                clearTimeout(timeout);
                this.connected = false;
                console.error(`[FnTerm] SSH 连接错误: ${err.message}`);
                reject(err);
            });

            this.client.on('close', () => {
                console.log(`[FnTerm] SSH 连接已关闭 ${this.username}@${this.host}`);
                this.connected = false;
                this.sftpClient = null;
            });

            this.client.connect({
                host,
                port: port || 22,
                username,
                password,
                readyTimeout: 15000,
                keepaliveInterval: 30000,
                keepaliveCountMax: 3
            });
        });
    }

    disconnect() {
        if (this.sftpClient) {
            try { this.sftpClient.end(); } catch (_) {}
            this.sftpClient = null;
        }
        if (this.client) {
            this.client.end();
            this.client = null;
        }
        this.connected = false;
    }

    createShell(cols, rows, onData, onClose) {
        return new Promise((resolve, reject) => {
            this.client.shell({
                term: 'xterm-256color',
                cols: cols || 80,
                rows: rows || 24,
                modes: {
                    // 启用鼠标报告
                    [1000]: true, // 鼠标按键事件
                    [1002]: true, // 单元格鼠标追踪
                    [1006]: true  // SGR 鼠标模式
                }
            }, (err, shellStream) => {
                if (err) return reject(err);

                shellStream.on('data', onData);
                shellStream.on('close', onClose);
                shellStream.on('error', (err) => {
                    console.error('[FnTerm] Shell 错误:', err.message);
                });

                // 设置终端标题
                shellStream.write('\x1b]0;FnTerm SSH\x07');

                resolve({
                    write: (data) => shellStream.write(data),
                    resize: (cols, rows) => {
                        shellStream.setWindow(rows, cols, 0, 0);
                    },
                    close: () => shellStream.end()
                });
            });
        });
    }

    getSFTP() {
        return new Promise((resolve, reject) => {
            if (this.sftpClient) {
                return resolve(this.sftpClient);
            }
            this.client.sftp((err, sftp) => {
                if (err) return reject(err);
                this.sftpClient = sftp;
                resolve(sftp);
            });
        });
    }

    isActive() {
        return this.connected && this.client;
    }
}

// 全局会话（单会话模式）
let session = new SSHSession();

// ============ REST API ============

// 连接状态
app.get('/api/status', (_req, res) => {
    res.json({
        connected: session.isActive(),
        host: session.host,
        username: session.username,
        connectedAt: session.connectedAt,
        uptime: process.uptime(),
        platform: os.platform(),
        arch: os.arch()
    });
});

// 建立 SSH 连接
app.post('/api/connect', async (req, res) => {
    if (session.isActive()) {
        return res.status(400).json({ error: '已有活跃连接，请先断开' });
    }

    const { host, port, username, password } = req.body;
    if (!host || !username || !password) {
        return res.status(400).json({ error: '缺少必要参数: host, username, password' });
    }

    try {
        await session.connect(host, parseInt(port, 10) || 22, username, password);
        res.json({
            success: true,
            host: session.host,
            username: session.username,
            connectedAt: session.connectedAt
        });
    } catch (err) {
        res.status(401).json({
            success: false,
            error: err.message || 'SSH 连接失败',
            detail: err.level === 'client-authentication' ? '认证失败，请检查用户名和密码' : err.message
        });
    }
});

// 断开 SSH 连接
app.post('/api/disconnect', (_req, res) => {
    session.disconnect();
    session = new SSHSession();
    res.json({ success: true });
});

// 列出目录
app.get('/api/files/list', async (req, res) => {
    if (!session.isActive()) {
        return res.status(400).json({ error: '未连接' });
    }

    const dirPath = req.query.path || '.';
    try {
        const sftp = await session.getSFTP();
        sftp.readdir(dirPath, (err, list) => {
            if (err) return res.status(500).json({ error: err.message });

            // 格式化文件列表
            const items = list.map(item => ({
                name: item.filename,
                longname: item.longname,
                isDirectory: item.attrs.isDirectory(),
                isFile: item.attrs.isFile(),
                isSymlink: item.attrs.isSymbolicLink(),
                size: item.attrs.size,
                mode: item.attrs.mode,
                uid: item.attrs.uid,
                gid: item.attrs.gid,
                mtime: item.attrs.mtime * 1000, // 转为毫秒
                atime: item.attrs.atime * 1000
            }));

            // 排序：目录在前，按名称排序
            items.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });

            res.json({ path: dirPath, items });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 读取文件内容（文本预览，限制 1MB）
app.get('/api/files/read', async (req, res) => {
    if (!session.isActive()) {
        return res.status(400).json({ error: '未连接' });
    }

    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });

    try {
        const sftp = await session.getSFTP();

        // 先获取文件信息
        sftp.stat(filePath, (statErr, stats) => {
            if (statErr) return res.status(404).json({ error: statErr.message });

            if (stats.isDirectory()) {
                return res.status(400).json({ error: '无法预览目录' });
            }

            const maxSize = 1 * 1024 * 1024; // 1MB
            const readSize = Math.min(stats.size, maxSize);

            const buffer = Buffer.alloc(readSize);
            sftp.open(filePath, 'r', (openErr, handle) => {
                if (openErr) return res.status(500).json({ error: openErr.message });

                sftp.read(handle, buffer, 0, readSize, 0, (readErr, bytesRead) => {
                    sftp.close(handle, () => {});

                    if (readErr) return res.status(500).json({ error: readErr.message });

                    const data = buffer.slice(0, bytesRead);

                    // 检测是否为文本文件
                    const isText = isTextFile(data, filePath);
                    const truncated = stats.size > maxSize;

                    res.json({
                        path: filePath,
                        size: stats.size,
                        mtime: stats.mtime * 1000,
                        truncated,
                        isText,
                        content: isText ? data.toString('utf-8') : null,
                        base64: isText ? null : data.toString('base64'),
                        encoding: isText ? 'utf-8' : 'base64'
                    });
                });
            });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 下载文件
app.get('/api/files/download', async (req, res) => {
    if (!session.isActive()) {
        return res.status(400).json({ error: '未连接' });
    }

    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });

    try {
        const sftp = await session.getSFTP();
        
        sftp.stat(filePath, (statErr, stats) => {
            if (statErr) return res.status(404).json({ error: statErr.message });
            if (stats.isDirectory()) return res.status(400).json({ error: '无法下载目录' });

            const fileName = path.posix.basename(filePath);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', stats.size);

            const readStream = sftp.createReadStream(filePath);
            readStream.on('error', (err) => {
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message });
                }
            });
            readStream.pipe(res);
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 上传文件
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
    if (!session.isActive()) {
        // 清理上传的临时文件
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: '未连接' });
    }

    const targetDir = req.body.path || '.';
    if (!req.file) return res.status(400).json({ error: '未选择文件' });

    try {
        const sftp = await session.getSFTP();
        const remotePath = path.posix.join(targetDir, req.file.originalname);
        const localPath = req.file.path;

        // 上传文件
        const writeStream = sftp.createWriteStream(remotePath);
        const readStream = fs.createReadStream(localPath);

        writeStream.on('close', () => {
            // 清理临时文件
            fs.unlink(localPath, () => {});
            res.json({
                success: true,
                path: remotePath,
                name: req.file.originalname,
                size: req.file.size
            });
        });

        writeStream.on('error', (err) => {
            fs.unlink(localPath, () => {});
            res.status(500).json({ error: err.message });
        });

        readStream.pipe(writeStream);
    } catch (err) {
        if (req.file) fs.unlink(req.file.path, () => {});
        res.status(500).json({ error: err.message });
    }
});

// 创建目录
app.post('/api/files/mkdir', async (req, res) => {
    if (!session.isActive()) return res.status(400).json({ error: '未连接' });

    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: '缺少 path 参数' });

    try {
        const sftp = await session.getSFTP();
        sftp.mkdir(dirPath, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, path: dirPath });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 删除文件/目录
app.delete('/api/files/delete', async (req, res) => {
    if (!session.isActive()) return res.status(400).json({ error: '未连接' });

    const filePath = req.query.path || req.body.path;
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' });

    try {
        const sftp = await session.getSFTP();
        sftp.stat(filePath, (statErr, stats) => {
            if (statErr) return res.status(404).json({ error: statErr.message });

            if (stats.isDirectory()) {
                sftp.rmdir(filePath, (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, path: filePath });
                });
            } else {
                sftp.unlink(filePath, (err) => {
                    if (err) return res.status(500).json({ error: err.message });
                    res.json({ success: true, path: filePath });
                });
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ 辅助函数 ============

// 检测文件是否为文本类型
function isTextFile(buffer, fileName) {
    // 基于扩展名判断
    const textExtensions = [
        '.txt', '.md', '.json', '.xml', '.html', '.htm', '.css', '.js', '.ts',
        '.jsx', '.tsx', '.vue', '.py', '.rb', '.php', '.java', '.c', '.cpp',
        '.h', '.hpp', '.go', '.rs', '.swift', '.kt', '.scala', '.sh', '.bash',
        '.zsh', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log',
        '.csv', '.tsv', '.sql', '.env', '.gitignore', '.dockerfile', '.makefile',
        '.patch', '.diff', '.tex', '.rst', '.org', '.lua', '.pl', '.pm',
        '.r', '.m', '.mm', '.gradle', '.properties', '.lock'
    ];
    const ext = path.extname(fileName).toLowerCase();
    if (textExtensions.includes(ext)) return true;

    // 检测 null 字节
    const checkLen = Math.min(buffer.length, 4096);
    for (let i = 0; i < checkLen; i++) {
        if (buffer[i] === 0) return false;
    }

    return true;
}

// 格式化文件大小
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
}

// ============ HTTP Server + WebSocket ============
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress || 'unknown';
    console.log(`[FnTerm] WebSocket 连接: ${clientIP}`);

    let shellHandle = null;

    // 创建 Shell 会话
    const startShell = async () => {
        if (!session.isActive()) {
            ws.send('\r\n\x1b[31m[FnTerm] 未建立 SSH 连接，请先在欢迎界面输入连接信息\x1b[0m\r\n');
            ws.close();
            return;
        }

        try {
            shellHandle = await session.createShell(80, 24,
                // onData: SSH 输出 → WebSocket
                (data) => {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(data.toString('utf-8'));
                    }
                },
                // onClose: Shell 退出
                () => {
                    console.log('[FnTerm] Shell 会话已关闭');
                    if (ws.readyState === ws.OPEN) {
                        ws.send('\r\n\x1b[33m[FnTerm] Shell 会话已结束\x1b[0m\r\n');
                        ws.close();
                    }
                }
            );
        } catch (err) {
            console.error('[FnTerm] 创建 Shell 失败:', err.message);
            ws.send(`\r\n\x1b[31m[FnTerm] 创建终端失败: ${err.message}\x1b[0m\r\n`);
            ws.close();
        }
    };

    // WebSocket 消息处理
    ws.on('message', (rawMsg) => {
        try {
            const msg = JSON.parse(rawMsg);

            switch (msg.type) {
                case 'init':
                    // 初始化终端会话
                    startShell();
                    break;

                case 'input':
                    if (shellHandle) {
                        shellHandle.write(msg.data);
                    }
                    break;

                case 'resize':
                    if (shellHandle && msg.cols && msg.rows) {
                        shellHandle.resize(msg.cols, msg.rows);
                    }
                    break;

                case 'ping':
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: 'pong' }));
                    }
                    break;

                default:
                    console.log(`[FnTerm] 未知消息: ${msg.type}`);
            }
        } catch (err) {
            console.error('[FnTerm] 消息解析错误:', err.message);
        }
    });

    // WebSocket 关闭
    ws.on('close', () => {
        console.log(`[FnTerm] WebSocket 断开: ${clientIP}`);
        if (shellHandle) {
            try { shellHandle.close(); } catch (_) {}
            shellHandle = null;
        }
    });

    ws.on('error', (err) => {
        console.error(`[FnTerm] WebSocket 错误: ${err.message}`);
        if (shellHandle) {
            try { shellHandle.close(); } catch (_) {}
            shellHandle = null;
        }
    });
});

// ============ 启动服务器 ============
server.listen(PORT, HOST, () => {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║  🖥  FnTerm v2.0 — SSH Web Terminal       ║`);
    console.log(`║  监听: ${HOST}:${PORT}                         ║`);
    console.log(`╚══════════════════════════════════════════╝`);
});

// 优雅关闭
function shutdown(signal) {
    console.log(`\n[FnTerm] 收到 ${signal}，关闭中...`);
    for (const client of wss.clients) client.close();
    session.disconnect();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', (err) => console.error('[FnTerm] 未捕获异常:', err));
process.on('unhandledRejection', (reason) => console.error('[FnTerm] Promise 拒绝:', reason));
