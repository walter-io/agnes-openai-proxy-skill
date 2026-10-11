---
name: agnes-openai-proxy
description: Agnes OpenAI 兼容代理的启动/停止/自启管理。把 Agnes 的图像/视频模型转成 OpenAI 协议(/v1/chat/completions、/v1/images/generations、/v1/videos,127.0.0.1:18787),让 Hypit 等 OpenAI 协议客户端直接调用 Agnes。当用户说"启动agnes代理/停止agnes代理/agnes代理状态/agnes转openai/agnes proxy/把hypit接到agnes/在另一台电脑上用agnes"时使用。
agent_created: true
---

# Agnes OpenAI Proxy

单文件 Node 代理(零依赖,Node >= 18),按模型名把 OpenAI 形状请求路由到 Agnes:
- model 名含 `image` → 转调 `/v1/images/generations`
- model 名含 `video` → 创建 `/v1/videos` 任务 + 自动轮询 `/agnesapi` 直到出片
- 其余 → 文本透传(支持 SSE 流式)

监听 `http://127.0.0.1:18787/v1`(可用环境变量 `PORT` 覆盖)。Key 读取顺序:`AGNES_API_KEY` → `AGNES_KEY_FILE` → `~/.agnes_key` → `~/.workbuddy/agnes-key.txt`。**不内置密钥**,代理脚本里没有任何密钥。

## 快速命令

先确认脚本目录(技能目录):`~/.workbuddy/skills/agnes-openai-proxy/scripts/`(Windows 上用户级技能实际落盘路径以 `~/.workbuddy/skills/` 为准,文件可能在其他盘的 workbuddy_data 下,用 Glob 确认)。

**启动(后台常驻)**

- Windows: 用 Bash 后台直跑 bat——`cd <scripts目录> && cmd //c agnes-proxy-start.bat`(run_in_background)。守护循环会在崩溃后 5s 自动重启。日志在同目录 `agnes-proxy.log`。
- macOS/Linux: `bash agnes-proxy-service.sh start`

**状态检查**

```bash
curl -s http://127.0.0.1:18787/healthz
curl -s http://127.0.0.1:18787/v1/models
```

**停止**

- Windows: `cmd //c agnes-proxy-stop.bat`(会同时结束守护 cmd 和 node 进程)
- macOS/Linux: `bash agnes-proxy-service.sh stop`

## 开机自启

- Windows: 把 `agnes-proxy-autostart.vbs` 复制到启动文件夹:
  `cp agnes-proxy-autostart.vbs "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/"`。
  它会静默拉起同目录的 start.bat(可移植,按脚本自身路径定位)。移除自启=删该文件。
- macOS/Linux: `bash agnes-proxy-service.sh install-autostart`(macOS 生成 launchd plist,systemd 机器生成 user service,其他输出 cron @reboot 指引)。卸载用 `uninstall-autostart`。

## 配置 Agnes Key(新机器必做)

```bash
echo "sk-xxxx你的agnes密钥" > ~/.agnes_key
```

或写 `~/.workbuddy/agnes-key.txt`。国内站(api.agnes-ai.cn)与国际站(apihub.agnes-ai.com)的 Key 通用此代理;若两站 Key 不同,用 `AGNES_API_KEY` 环境变量区分启动。

## 客户端接入(如 Hypit)

- Base URL: `http://127.0.0.1:18787/v1`
- API Key: 随意填(代理不校验,鉴权用 Agnes Key 文件)
- 生图: model 填 Agnes 图像模型名;生视频: model 填 Agnes 视频模型名;文本模型直接透传。

## 在另一台电脑上部署

1. 安装本技能(zip 可用 `~/.workbuddy/plugins/marketplaces/workbuddy-builtin/skills/skill-creator/scripts/package_skill.py <技能目录> -o <输出zip>` 生成;在目标电脑用 WorkBuddy 安装技能或手动解压到 `~/.workbuddy/skills/agnes-openai-proxy`)。
2. 目标电脑需 Node >= 18(无其他依赖)。
3. 写入 Key: `echo "sk-xxx" > ~/.agnes_key`。
4. 说"启动 agnes 代理"(或跑 start 脚本),`curl http://127.0.0.1:18787/healthz` 验证。
5. 需要开机自启则按上节操作。

## 故障排查

- **端口被占**: 18787 被其他程序占用时,设 `PORT=18788` 再启动,客户端 Base URL 同步改。
- **healthz 不通**: 看 `agnes-proxy.log`;常见原因是缺 Node(命令行跑 `node -v` 验证)或 4096 以下权限问题。
- **429/队列满**: Agnes 免费档限速,等 30-60s 重试;视频任务代理会自动轮询,无需干预。
- **Windows 上 PowerShell 隐藏启动 VBS 静默失败**: 改用 Bash `run_in_background` 直跑 start.bat。
