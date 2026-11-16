# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### One-line install (Reins distribution, macOS & Windows)

The prebuilt Reins distribution installs into user space (`~/.reins` on macOS, `%LOCALAPPDATA%\Reins` on Windows) with a bundled Node.js 24 runtime, requires no administrator privileges, runs the Web service on demand in the background at `http://127.0.0.1:3180`, and isolates its data under `<root>/data` so it never conflicts with `npm` or source checkouts (`3080` and `~/.dsh`).

On macOS (`arm64` and `x64`), run:

```sh
curl -fsSL https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.sh | bash
```

On Windows (`x64` PowerShell, standard non-admin user), run:

```powershell
irm https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.ps1 | iex
```

On Windows, the installer also creates Desktop and Start Menu **Reins** shortcuts that start the background service without a console window and open the default browser. Manage the service from the terminal with `reins` (or the optional brand aliases `loom` and `lumen`):

- `reins` (or `reins open`, `loom`, `lumen`): start the background service on demand and open `http://127.0.0.1:3180` in the default browser.
- `reins start` / `reins stop` / `reins restart` / `reins status` / `reins logs -f`: control the background daemon and inspect rotating logs.
- `reins upgrade` (`--check` to check only) / `reins rollback`: hot-upgrade from GitHub Releases with health-check auto-rollback, or switch back to the retained previous version.
- `reins config set port <port>` / `reins config set mirror <url>`: change the loopback port or configure a GitHub Release mirror.
- `reins alias list` / `reins alias enable|disable <loom|lumen>`: list or toggle brand command aliases.
- `reins doctor` / `reins uninstall`: run self-diagnostics or uninstall binaries and shortcuts while keeping `data/` sessions unless `--purge-data --yes` is passed.

### Install and verify with an AI agent

When delegating installation to an AI agent, set `REINS_NO_OPEN=1` so the installer starts and verifies the background service without opening a browser window, then invoke the shim by its explicit path (which works immediately before a new interactive shell reloads `PATH`).

On macOS:

```sh
curl -fsSL https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.sh | REINS_NO_OPEN=1 bash
~/.reins/bin/reins status
~/.reins/bin/reins doctor
```

On Windows PowerShell:

```powershell
$env:REINS_NO_OPEN = '1'; irm https://github.com/dqrcsc/deepseek-harness/releases/latest/download/install.ps1 | iex
& "$env:LOCALAPPDATA\Reins\bin\reins.cmd" status
& "$env:LOCALAPPDATA\Reins\bin\reins.cmd" doctor
```

Optional installer environment variables include `REINS_PORT` (custom loopback port), `REINS_GITHUB_MIRROR` (release mirror prefix), `REINS_VERSION` (pin a tag such as `reins-v1.0.0`), and `REINS_NO_START=1` (install files without starting the daemon). Once `doctor` reports healthy status, run `~/.reins/bin/reins open` (macOS) or `& "$env:LOCALAPPDATA\Reins\bin\reins.cmd" open` (Windows) to launch the authenticated Web UI for the user.

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
