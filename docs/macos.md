# macOS 安装

支持 macOS 13+、Apple Silicon（M 系列芯片），不提供 Intel Mac 或 universal 安装包。首次准备需要联网及至少 6 GB 可用空间。

## 桌面安装

1. 从 [Releases](https://github.com/XianZe1226/DWhale/releases)下载 `DWhale-版本-macOS-arm64.dmg`。
2. 打开磁盘映像，将 **DWhale** 拖到「应用程序」，再从「应用程序」打开。
3. 在「运行环境」点击准备。兼容的工具会复用，缺失依赖下载到应用自己的目录；桌面安装无需 Homebrew 或预装 Python、Node.js。
4. 准备完成后启动服务，按[配置指南](setup.md)连接 QQ、配置模型和长期记忆。常用设置与高级页面均在应用窗口内打开。

预览版默认仅有本地临时签名，没有 Developer ID 身份或 Apple 公证。首次打开可能被系统拦截；确认来自项目 Release 且校验和一致后，可按 macOS「系统设置 → 隐私与安全性」提供的单个应用打开流程处理，不要关闭 Gatekeeper。若系统提示文件损坏或校验不一致，请重新下载并反馈。

数据位于 `~/Library/Application Support/DSWhale`，升级替换应用时保留。备份与详细说明见[桌面指南](desktop.md)。

## 独立连接 QQ

在「QQ 连接」配置 QQ 官方 WebSocket 机器人并绑定消息列表私聊，详见 [首次使用指南](qq-official.md)。

B站功能从应用内入口打开并单独扫码登录，详见 [B站设置](bilibili.md)。

## 更新与排错

应用更新、备份恢复和后台运行选项在「应用设置」管理；LivingMemory 等插件在「模型与记忆」独立更新。从 0.3.0a4 或更早版本升级时，替换应用后准备运行环境即可，详见[更新指南](updates.md)。

下载自动跟随系统网络，可直接配合 Clash 系统代理或 TUN，无需另配代理地址。环境准备前也可导出诊断报告，详见[排错指南](troubleshooting.md)。

## 高级：源码与终端部署

需终端运行或维护现有 AstrBot 时，可下载源码 ZIP 解压，运行 `Install.command`，再运行 `Start.command`。数据位于源码旁的 `.runtime`，独立于桌面应用数据。

```bash
bash Install.command
bash Start.command
```

旧式安装脚本缺少 FFmpeg 时使用 Homebrew，需按 [Homebrew 官网](https://brew.sh/)预先安装；也可自行提供 PATH 中的 FFmpeg 与 ffprobe。B站旧式入口为 `Bili-Settings.command`。源码工具链能否在其他 Mac 架构使用取决于各依赖，不属于本版桌面支持范围。

已有 AstrBot 可按[插件安装](setup.md#接入现有-astrbot)接入。升级前停止宿主并[备份数据](upgrading.md)。
