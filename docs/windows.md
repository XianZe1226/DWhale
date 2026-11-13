# Windows 安装

支持 Windows 10 22H2 / 11、64 位 Intel 或 AMD。首次准备需要联网及至少 6 GB 可用空间，不支持 32 位 Windows 或 Windows ARM。

## 桌面安装

1. 从 [Releases](https://github.com/XianZe1226/DWhale/releases)下载 `DWhale-版本-Windows-x86_64-setup.exe`。
2. 运行安装器，按提示安装。默认仅安装到当前用户，不要求以管理员运行，也无需选择目录；已有安装沿用原位置。
3. 打开 **DWhale**，进入「运行环境」并点击准备。无需预先安装 Python、Node.js、WinGet 或 FFmpeg。
4. 打开「QQ 连接」，启动服务，配置官方机器人的 AppID 与 AppSecret，并绑定消息列表私聊。在「模型与记忆」配置模型服务，详见[配置指南](setup.md)。

预览版默认没有可信发布者签名，系统可能显示未知发布者。请检查下载来源与 Release 校验文件，不要关闭系统整体安全保护。数据保存在 `%APPDATA%\DSWhale`，升级安装保留数据，详见[桌面指南](desktop.md)。

## QQ 与 B站

在「QQ 连接」启动服务，打开官方机器人设置，并根据提示绑定私聊。三端采用相同的官方接口流程，详见 [首次使用指南](qq-official.md)。

在 DSWhale 窗口开启 B站功能并进入 B站页面，扫码登录后配置偏好与渠道。账号登录、主动活动、QQ 推荐和 B站私信分别配置，见 [B站设置](bilibili.md)。

## 更新与排错

「应用设置」发现新版后，点击「更新」即可下载并查看进度，下载完成会提示覆盖安装，升级沿用当前安装目录。这里也提供自动备份与恢复、托盘和登录启动选项；插件可在「模型与记忆」独立更新。从 0.3.0a4 或更早版本升级时，先下载安装包覆盖安装，再准备运行环境，无需重新导入旧备份。详见[更新指南](updates.md)。

下载跟随系统网络，需要代理时在 Clash 开启系统代理或 TUN 后重试，不必在 DSWhale 填写代理。安装失败时可在「应用设置」导出诊断报告，详见[排错指南](troubleshooting.md)。

## 高级：源码与终端部署

需终端运行或维护现有 AstrBot 时，可下载 `DSWhale-版本-source.zip`，全部解压到固定目录，运行 `Install.cmd`，再运行 `Start.cmd`。安装失败时可重新执行 Install；启动日志中显示管理地址。数据位于源码旁的 `.runtime`，独立于桌面应用数据。

旧式安装脚本缺少 FFmpeg 时通过 WinGet 准备。需先安装 [Microsoft 应用安装程序](https://apps.microsoft.com/detail/9nblggh4nns1)，或自行把 FFmpeg / ffprobe 放入 PATH。旧式 B站设置入口是 `Bili-Settings.cmd`。

诊断时可在项目目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

执行策略参数只影响当前进程。已有 AstrBot 也可按[插件安装](setup.md#接入现有-astrbot)接入。升级前停止宿主并[备份数据](upgrading.md)。
