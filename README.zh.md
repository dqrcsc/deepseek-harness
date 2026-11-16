# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

### 一行免管理员安装（Reins 发行版，macOS 与 Windows）

预构建的 Reins 发行版直接安装至当前用户目录（macOS 为 `~/.reins`，Windows 为 `%LOCALAPPDATA%\Reins`），内置独立 Node.js 24 运行时，全程无需管理员权限，按需在后台常驻提供 `http://127.0.0.1:3180` Web 服务，并将数据独立隔离在 `<root>/data` 下，与 `npm` 或源码运行模式（`3080` 端口与 `~/.dsh`）完全互不干扰。

在 macOS（`arm64` 与 `x64`）终端运行：

```sh
curl -fsSL https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.sh | bash
```

在 Windows（`x64` PowerShell，普通非管理员用户即可）运行：

```powershell
irm https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.ps1 | iex
```

在 Windows 上，安装脚本还会在桌面与开始菜单创建 **Reins** 快捷图标，双击即可无黑框拉起后台服务并打开默认浏览器。日常也可通过终端 CLI（命令行界面）命令 `reins`（或可选同构品牌别名 `loom`、`lumen`）管理服务：

- `reins`（或 `reins open`、`loom`、`lumen`）：按需拉起后台服务并在默认浏览器打开 `http://127.0.0.1:3180`。
- `reins start` / `reins stop` / `reins restart` / `reins status` / `reins logs -f`：启停后台守护进程并查看滚动日志。
- `reins upgrade`（`--check` 仅检查更新）/ `reins rollback`：从 GitHub Releases 无损热升级（健康检查失败自动回滚），或秒级切回本地保留的上一版本。
- `reins config set port <port>` / `reins config set mirror <url>`：修改本地监听端口或配置 GitHub Release 加速镜像。
- `reins alias list` / `reins alias enable|disable <loom|lumen>`：查看或开关品牌命令别名。
- `reins doctor` / `reins uninstall`：执行环境自检，或卸载程序与快捷方式（未显式传入 `--purge-data --yes` 时默认安全保留 `data/` 会话数据）。

### 通过 AI agent 自动安装与自检

将安装任务交给 AI（人工智能）agent 执行时，建议设置 `REINS_NO_OPEN=1` 让安装器在后台静默启动并完成就绪校验而不自动弹出浏览器窗口，随后直接通过垫片绝对路径调用自检命令（无需等待新终端重新加载 `PATH`）。

macOS：

```sh
curl -fsSL https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.sh | REINS_NO_OPEN=1 bash
~/.reins/bin/reins status
~/.reins/bin/reins doctor
```

Windows PowerShell：

```powershell
$env:REINS_NO_OPEN = '1'; irm https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.ps1 | iex
& "$env:LOCALAPPDATA\Reins\bin\reins.cmd" status
& "$env:LOCALAPPDATA\Reins\bin\reins.cmd" doctor
```

安装脚本还支持可选环境变量 `REINS_PORT`（自定义监听端口）、`REINS_GITHUB_MIRROR`（配置发布包镜像前缀）、`REINS_VERSION`（固定安装如 `reins-v1.0.0` 版本）与 `REINS_NO_START=1`（仅安装不启动后台服务）。当 `doctor` 自检通过后，可执行 `~/.reins/bin/reins open`（macOS）或 `& "$env:LOCALAPPDATA\Reins\bin\reins.cmd" open`（Windows）为用户打开带鉴权令牌的 Web UI。

### 通过 `npm` 运行

安装 `Node.js`，然后运行：

```sh
npx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
