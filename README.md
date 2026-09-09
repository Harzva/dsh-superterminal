# DSH SuperTerminal

在一个 DSH 工作台中运行多个智能体：自由分屏、管理本机工具，并随时向终端助手提问。

## 开始使用

当前支持 **macOS、Node.js 24+ 和官方 DSH 0.1.1-rc.2**。暂不支持 Windows、远程终端或其他 DSH 版本。

下载并安装发布包，然后重启所选 DSH 配置：

```sh
dsh plugin --profile web add https://github.com/Harzva/dsh-superterminal/releases/download/v0.1.0-alpha.4/harzva-dsh-terminal-0.1.0-alpha.4.tgz
```

在 DSH 输入栏点击 **终端**，或输入 **/terminal** 并选择“打开终端”。从旧版 DSH Terminal 升级时继续使用同一插件，无需额外安装第二份。

## 按你的方式安排工作

- **自由分屏**：选择双栏、主次布局、六格或十二格，也可以继续拆分窗格。
- **拖动调节**：拖动分隔线调整大小，双击均分；放大单个窗格以专注工作。
- **智能体目录**：搜索已安装工具，查看可识别的版本、使用配置和安装详情。
- **独立终端**：打开 Shell、Codex、Claude Code、Kimi、Pi 等本机工具；其他命令可从“使用其他命令”输入。
- **终端助手**：描述目标或粘贴报错，获得命令建议与核对步骤。复制命令后，由你决定在哪里执行。

返回 DSH 或切换布局会保留正在运行的终端。点击窗格上的 **×** 会结束该终端；关闭或重启 DSH 也会结束其中的任务。每个会话最多打开 12 个终端。

## 账号与配置

Codex、Claude、Kimi 和 Pi 在当前工作区使用独立配置。即使你已在其他终端登录，在这里首次使用仍可能需要重新登录。其他工具使用本机配置，并遵守 DSH 的访问权限。

“已安装”表示检测到了启动程序，不代表已登录或有可用额度。账号、套餐、剩余额度和智能体连接状态尚未自动查询，请打开相应智能体查看。部分安装方式无法读取版本号，会显示“版本未识别”。

工作区中的 `.dsh-terminal` 保存本地运行数据，请勿提交或分享；使用中的数据目录也不应删除。

## 智能建议与隐私

点击“生成建议”时，终端助手使用 DSH 已配置的模型，发送本次输入和当前会话的终端运行状态。不自动读取终端内容、工作区文件或智能体登录凭据，也不自动执行建议中的命令。模型费用按所选服务的计费规则计算。

安装兼容的 **DSH Supervisor** 后，可在工作台查看它对运行状态的建议。终端仍在运行不代表任务已完成，请结合实际结果核对。

## 使用提示

- 连接中断时会暂停输入并尝试重连；尚未确认送达的输入不会自动重发。
- 刷新浏览器后，部分历史画面可能无法完整恢复。
- 当前为 Alpha 版本，尚不包含 Harvis 接管、跨智能体调度或 DSH 重启后的任务恢复。
- 升级 DSH 前，请先确认 SuperTerminal 是否支持目标版本。

问题与反馈：[GitHub Issues](https://github.com/Harzva/dsh-superterminal/issues)。

## 开源与许可

MIT。依赖与图标许可见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

终端显示使用 [xterm.js](https://github.com/xtermjs/xterm.js)。交互设计参考了 [Wave Terminal](https://github.com/wavetermdev/waveterm)、[Warp](https://github.com/warpdotdev/warp) 和 [Smart Terminal](https://github.com/muralianand12345/Smart-Terminal)，未包含这些应用的源码。

开发与兼容性说明见 [DEVELOPING.md](https://github.com/Harzva/dsh-superterminal/blob/main/DEVELOPING.md)。插件包名保留为 `@harzva/dsh-terminal`，用于兼容已有安装。
