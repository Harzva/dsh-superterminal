<p align="center">
  <img src="https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/logo.svg" width="88" height="88" alt="DSH SuperTerminal" />
</p>

<h1 align="center">DSH SuperTerminal</h1>

<p align="center"><strong>用自然语言执行任务，让 Side Terminal 成为对话旁的工作台。</strong></p>

<p align="center">在 DSH 对话旁执行 AI 任务，打开你熟悉的智能体 CLI，把工作台排成自己的样子。</p>

<p align="center">
  <a href="https://harzva.github.io/dsh-superterminal/">官网交互导览</a> ·
  <a href="#安装">安装</a> ·
  <a href="https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md">使用指南</a> ·
  <a href="https://github.com/Harzva/dsh-superterminal/releases">更新记录</a>
</p>

![AI 修复购物车，Shell 并排展示测试结果与修改后的代码](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/workspace.jpg)

**实测用例：** 在独立示例项目中修复购物车合计，`35 → 80`，相关 **2 项测试通过**。所有截图均为 alpha.8 实际界面。

## 安装

当前版本 **0.1.0-alpha.8**，支持 **macOS · Node.js 24+ · 官方 DSH 0.1.1-rc.2**。

```sh
dsh plugin --profile web add https://github.com/Harzva/dsh-superterminal/releases/download/v0.1.0-alpha.8/harzva-dsh-terminal-0.1.0-alpha.8.tgz
```

首次运行：

1. 重启所选 DSH 配置（上述命令为 `web`），在输入栏点击 **终端**，或输入 **/terminal**。
2. 在来源对话中选择可用的 DSH 模型，第一次发送 AI 任务时会沿用它。任务按来源工作区权限执行；本插件不附带模型或额度。
3. 点击 **＋ 终端**，写下第一个任务；通过 **Agents** 打开本机 CLI。

目前仍为 Alpha，暂不支持 Windows、远程终端、其他 DSH 版本或 Harvis 接管。DSH Supervisor 的终端状态适配尚未包含在公开 Supervisor 0.2.4 中。

## 从一句话，到实际结果

输入「检查这个项目，修复失败的测试」，DSH 会调用当前配置允许的工具，读取文件、修改代码、执行命令并展示结果。你可以继续追问、在执行中追加要求，或停止任务。

每个终端有自己的上下文和草稿。模型、权限、工具步骤都能看见；选区由你决定是否附上，任务不会自动送回主对话。工作台支持自由分屏，拖动调整大小、放大或收起，最多 12 个窗格。同一服务最多同时执行 2 个 AI 任务；停止 AI 会话保留记录和 Shell，重启 DSH 会结束终端进程。

<details>
<summary><strong>查看截图：完整的 AI 执行过程</strong></summary>

查看工具步骤与返回结果，继续追问、追加要求或停止。

![AI 任务中的文件检查、编辑与测试步骤](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/ai-task.jpg)

</details>

<details>
<summary><strong>查看截图：对话旁的 Side Terminal</strong></summary>

绑定当前对话，或留在独立工作台。收起侧栏，任务继续。

![DSH 右侧的 Side Terminal](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/side-terminal.jpg)

</details>

## 熟悉的智能体，在同一个工作台

通过 **Agents** 打开本机 Shell、Codex、Claude Code、Kimi Code、Pi 等工具，保留各自的原生界面。目录显示可识别的版本与使用状态。

![本机智能体目录与使用状态](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/agents.jpg)

需要搭档时，可把任务交给 **Pi / piagent 或 Codex** 在后台执行，收到结果后验收或要求返工。当前受管后台交接支持这两类 Agent；其他 CLI 可在原生终端中交互使用。

Codex、Claude Code、Kimi 和 Pi 使用当前工作区的独立配置。即使你已在其他终端登录，在这里首次使用仍可能需要重新登录或配置模型。

目录分别显示安装、登录和上次任务的模型连接证据；无法确认的状态显示「未知」。本机已安装不代表已有登录或可用额度，套餐与额度以各服务提供的信息为准。

完整操作、恢复方式、协作范围与隐私说明见 **[中文使用指南](https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md)**。

---

[反馈问题](https://github.com/Harzva/dsh-superterminal/issues) · [MIT 许可](https://github.com/Harzva/dsh-superterminal/blob/main/LICENSE) · [第三方声明](https://github.com/Harzva/dsh-superterminal/blob/main/THIRD_PARTY_NOTICES.txt)

终端显示基于 [xterm.js](https://github.com/xtermjs/xterm.js)。设计参考与组件来源见[使用指南](https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md#开源与许可)。
