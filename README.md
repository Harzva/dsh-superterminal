<p align="center">
  <img src="https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/logo.svg" width="88" height="88" alt="DSH SuperTerminal" />
</p>

<h1 align="center">DSH SuperTerminal</h1>

<p align="center"><strong>把目标说出来，让终端开始工作。</strong></p>

<p align="center">在 DSH 对话旁执行 AI 任务，打开你熟悉的智能体 CLI，把工作台排成自己的样子。</p>

<p align="center">
  <a href="https://harzva.github.io/dsh-superterminal/">官网</a> ·
  <a href="#安装">安装</a> ·
  <a href="https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md">使用指南</a> ·
  <a href="https://github.com/Harzva/dsh-superterminal/releases">更新记录</a>
</p>

![用自然语言执行任务，查看文件检查、编辑与测试步骤](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/ai-task.jpg)

以上及下方截图均为 **alpha.8 实际界面**，使用独立的示例项目。

## 从一句话，到实际结果

输入「检查这个项目，修复失败的测试」，DSH 会调用当前配置允许的工具，读取文件、修改代码、执行命令并展示结果。你可以继续追问、在执行中追加要求，或停止任务。

每个终端有自己的上下文和草稿。模型、权限、工具步骤都能看见；选区由你决定是否附上，任务不会自动送回主对话。

| 对话旁的 Side Terminal | 按你的习惯自由分屏 |
| --- | --- |
| 绑定当前对话，或留在独立工作台。收起侧栏，任务继续。 | 拖动调整大小、拆分、放大或收起，最多 12 个窗格。 |
| ![DSH 右侧的 Side Terminal](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/side-terminal.jpg) | ![可调整布局的多终端工作台](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/workspace.jpg) |

## 熟悉的智能体，在同一个工作台

Shell、Codex、Claude Code、Kimi、Pi……保留各自的原生界面。打开 **Agents**，查看本机工具、可识别的版本和登录状态。需要搭档时，把任务交给支持的 Agent，收到结果后验收或要求返工。

![本机智能体目录与使用状态](https://raw.githubusercontent.com/Harzva/dsh-superterminal/main/site/assets/screenshots/agents.jpg)

分别显示安装、登录和上次任务的模型连接证据；无法确认的状态显示「未知」。使用 CLI 仍需对应账号或模型配置，套餐与额度以各服务提供的信息为准。

## 安装

当前版本 **0.1.0-alpha.8**，支持 **macOS · Node.js 24+ · 官方 DSH 0.1.1-rc.2**。

```sh
dsh plugin --profile web add https://github.com/Harzva/dsh-superterminal/releases/download/v0.1.0-alpha.8/harzva-dsh-terminal-0.1.0-alpha.8.tgz
```

重启所选 DSH 配置，在输入栏点击 **终端**，或输入 **/terminal**。点击 **＋ 终端**，写下第一个任务；通过 **Agents** 打开本机 CLI。

AI 任务使用 DSH 已配置的模型及来源工作区权限，不会自动提权。同一服务最多同时执行 2 个 AI 任务；停止 AI 会话保留记录和 Shell，重启 DSH 会结束终端进程。

目前仍为 Alpha，暂不支持 Windows、远程终端、其他 DSH 版本或 Harvis 接管。DSH Supervisor 的终端状态适配尚未包含在公开 Supervisor 0.2.4 中。

完整操作、恢复方式、协作范围与隐私说明见 **[中文使用指南](https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md)**。

---

[反馈问题](https://github.com/Harzva/dsh-superterminal/issues) · [MIT 许可](https://github.com/Harzva/dsh-superterminal/blob/main/LICENSE) · [第三方声明](https://github.com/Harzva/dsh-superterminal/blob/main/THIRD_PARTY_NOTICES.txt)

终端显示基于 [xterm.js](https://github.com/xtermjs/xterm.js)。设计参考与组件来源见[使用指南](https://github.com/Harzva/dsh-superterminal/blob/main/docs/guide.zh-CN.md#开源与许可)。
