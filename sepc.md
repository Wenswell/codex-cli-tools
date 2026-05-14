**项目规格**
项目名暂定：`codex-tools`

目标：做一个个人跨平台开发工具箱，支持 Linux 和 macOS，使用 `Node.js + TypeScript + pnpm` 实现，通过 npm/pnpm 全局安装后提供多个 CLI 命令。

安装形态：

```bash
pnpm add -g codex-tools
```

或私有 Git 仓库安装：

```bash
pnpm add -g git+ssh://git@github.com/YOUR_NAME/codex-tools.git
```

技术要求：

- Runtime：Node.js 20+
- 语言：TypeScript
- 包管理：pnpm
- CLI 入口：`package.json` 的 `bin`
- 跨平台：必须兼容 Linux 和 macOS
- 不依赖 GNU-only 命令，例如 `sed -i`
- 所有文件写入都用 Node.js API
- 默认不把任何 API key 写进代码仓库

**命令列表**
提供以下命令：

```bash
ccs
cxs
cxsx
envsync
codex-session-move
```

命令职责：

- `ccs`：切换 Codex 当前 OpenAI-compatible provider/profile
- `cxs`：执行 `codex --search ...`
- `cxsx`：执行 `codex --search --dangerously-bypass-approvals-and-sandbox ...`
- `envsync`：把 `.env.example` 中缺失的变量补到 `.env`
- `codex-session-move`：文件夹重命名后迁移 Codex 历史 session 的 cwd 关联

**配置目录**
工具自身配置放在：

```text
~/.config/codex-tools/
```

主要配置文件：

```text
~/.config/codex-tools/profiles.json
```

格式：

```json
{
  "profiles": {
    "input": {
      "baseURL": "https://ai.input.im",
      "apiKey": "..."
    },
    "ciii": {
      "baseURL": "https://codex.ciii.club",
      "apiKey": "..."
    }
  }
}
```

要求：

- `profiles.json` 权限建议为 `0600`
- `ccs init` 创建或更新该文件
- API key 不进入 npm 包，不进入普通 Git 仓库明文
- 用户可用密码管理器、加密 Git、chezmoi+age 等方式同步该文件

**ccs**
用途：切换 Codex 使用的 OpenAI-compatible API profile。

目标文件：

```text
~/.codex/config.toml
~/.codex/auth.json
```

命令：

```bash
ccs
ccs status
ccs init
ccs input
ccs ciii
ccs toggle
ccs list
```

行为：

- `ccs`：显示帮助
- `ccs status`：显示当前 profile、baseURL、masked apiKey
- `ccs init`：交互式写入 `profiles.json`
- `ccs list`：列出已配置 profile
- `ccs input`：切换到 `input`
- `ccs ciii`：切换到 `ciii`
- `ccs toggle`：在 `input` 和 `ciii` 之间切换

切换逻辑：

- 读取 `~/.config/codex-tools/profiles.json`
- 更新 `~/.codex/config.toml` 中的 `base_url`
- 更新 `~/.codex/auth.json`：

```json
{
  "OPENAI_API_KEY": "..."
}
```

要求：

- 不修改无关配置项
- API key 输出时必须 mask
- 如果目标 profile 缺失，报错退出
- 如果 key 缺失，报错退出
- 写入前确保 `~/.codex` 存在
- `auth.json` 写入后设置权限 `0600`

**cxs / cxsx**
用途：Codex 搜索模式快捷命令。

命令：

```bash
cxs ARGS...
cxsx ARGS...
```

行为：

```bash
cxs foo
# 等价于
codex --search foo

cxsx foo
# 等价于
codex --search --dangerously-bypass-approvals-and-sandbox foo
```

要求：

- 直接转发 stdin/stdout/stderr
- 保留原始退出码
- 不吞参数
- 如果 `codex` 不存在，提示安装 `@openai/codex`

**envsync**
用途：同步 `.env.example` 到 `.env`，只补缺失 key，不覆盖已有值。

命令：

```bash
envsync
envsync --check
envsync --source .env.example --target .env
envsync --source .env.example --target .env.local
envsync --backup
```

默认行为：

```bash
envsync
# source = .env.example
# target = .env
```

语义：

```js
result = { ...exampleDefaults, ...existingEnv }
```

但写回文件时要尽量保留 `.env` 既有内容。

行为要求：

- 读取 source 中的 key
- 读取 target 中已有 key
- 找出 source 有但 target 没有的 key
- 将缺失 key 追加到 target 末尾
- 不覆盖 target 中已有 key
- 不删除 target 中多余 key
- 保留 target 原有注释、空行、顺序
- target 不存在时创建
- `--check` 只输出缺失 key，不写文件
- `--backup` 写入前创建备份，例如 `.env.backup-YYYYMMDD-HHMMSS`

`.env` 解析范围：

- 支持 `KEY=value`
- 支持 `export KEY=value`
- 支持空值：`KEY=`
- 忽略空行和注释行
- 第一版不需要完整支持复杂 shell 语法

输出示例：

```text
source: .env.example
target: .env
missing: 3

added:
  DATABASE_URL
  OPENAI_API_KEY
  REDIS_URL
```

**codex-session-move**
用途：项目目录重命名后，把 Codex 历史 session 的 cwd 从旧路径迁移到新路径。

背景：

Codex session 目录关联主要存在两处：

```text
~/.codex/state_5.sqlite
~/.codex/sessions/**/*.jsonl
```

需要更新：

```text
threads.cwd
session_meta.payload.cwd
```

命令：

```bash
codex-session-move OLD_PATH NEW_PATH
codex-session-move OLD_PATH NEW_PATH --prefix
codex-session-move OLD_PATH NEW_PATH --dry-run
codex-session-move OLD_PATH NEW_PATH --prefix --apply
```

默认行为：

- 默认 dry-run
- 只有带 `--apply` 才真实写入

路径语义：

- 默认模式：只迁移 cwd 精确等于 `OLD_PATH` 的 session
- `--prefix`：迁移 cwd 等于 `OLD_PATH` 或以 `OLD_PATH/` 开头的 session
- `--prefix` 要保留相对路径

示例：

```bash
codex-session-move /Users/me/repos/old /Users/me/repos/new --prefix --apply
```

迁移：

```text
/Users/me/repos/old
/Users/me/repos/old/app
/Users/me/repos/old/packages/api
```

到：

```text
/Users/me/repos/new
/Users/me/repos/new/app
/Users/me/repos/new/packages/api
```

SQLite 要求：

- 自动发现 `~/.codex/state*.sqlite`
- 优先使用最新或明确匹配的 state sqlite
- 查询 `threads` 表
- 字段至少使用：
  - `cwd`
  - `rollout_path`

备份要求：

真实写入前必须创建备份目录：

```text
~/.codex/backups/session-cwd-migration-YYYYMMDD-HHMMSS/
```

备份内容：

- state sqlite 文件
- 所有将被修改的 rollout jsonl 文件

更新要求：

- 更新 SQLite 中匹配记录的 `threads.cwd`
- 更新每个 `rollout_path` 指向的 jsonl 文件第一行
- 只修改第一行 `session_meta.payload.cwd`
- 不修改其他字段
- 不删除任何 session
- 遇到 JSONL 第一行损坏时，报告错误并跳过或中止；建议默认中止，避免半迁移
- 写入完成后输出验证结果

dry-run 输出：

```text
mode: prefix
old: /old/path
new: /new/path
matched sessions: 12

will update:
  /old/path -> /new/path
  /old/path/app -> /new/path/app

rollout files:
  ~/.codex/sessions/.../rollout-xxx.jsonl
```

apply 后输出：

```text
backup: ~/.codex/backups/session-cwd-migration-20260514-153000
sqlite updated: 12
jsonl updated: 12
old cwd remaining: 0
new cwd count: 12
```

验证要求：

- 旧 cwd 剩余数量
- 新 cwd 数量
- 被修改 jsonl 文件数量
- jsonl 第一行 cwd 是否与 sqlite 同步

**代码结构**
建议目录：

```text
codex-tools/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  src/
    bin/
      ccs.ts
      cxs.ts
      cxsx.ts
      envsync.ts
      codex-session-move.ts
    commands/
      ccs.ts
      envsync.ts
      codex-session-move.ts
    lib/
      backup.ts
      codex.ts
      config.ts
      env-file.ts
      fs.ts
      paths.ts
      process.ts
      sqlite.ts
```

`package.json` bin：

```json
{
  "bin": {
    "ccs": "./dist/bin/ccs.js",
    "cxs": "./dist/bin/cxs.js",
    "cxsx": "./dist/bin/cxsx.js",
    "envsync": "./dist/bin/envsync.js",
    "codex-session-move": "./dist/bin/codex-session-move.js"
  }
}
```

**测试策略**
只做必要测试：

- `envsync`：测试补缺、不覆盖、`--check`
- `ccs`：用临时目录测试 profiles/config/auth 写入
- `codex-session-move`：用临时 sqlite + jsonl 测试 exact/prefix/dry-run/apply

不需要搞大型测试项目。

**优先级**
建议实现顺序：

1. `cxs` / `cxsx`
2. `envsync`
3. `ccs`
4. `codex-session-move`

`codex-session-move` 风险最高，最后做，并且默认必须 dry-run。
