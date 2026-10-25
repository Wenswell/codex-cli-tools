# cx / cxx / cxxs

`cx` runs Codex in search mode and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
cx ARGS...
cx run PROFILE [CODEX_ARGS...]
cx version
cx -v
```

Equivalent to:

```bash
codex --search ARGS...
```

`cxx` also bypasses approvals and sandboxing.

```bash
cxx ARGS...
cxx run PROFILE [CODEX_ARGS...]
cxx version
cxx -v
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox ARGS...
```

`cxxs` resumes a Codex session with approvals and sandboxing bypassed.

```bash
cxxs ARGS...
cxxs run PROFILE [RESUME_ARGS...]
cxxs version
cxxs -v
```

Equivalent to:

```bash
codex --search --dangerously-bypass-approvals-and-sandbox resume ARGS...
```

All three wrappers can launch one local Codex process with a profile without changing the stored current profile:

```bash
cx run input
cxx run ciii "check this repo"
cxxs run input --last
```

`run PROFILE` is local because the selected provider API key is scoped to that Codex process. It passes temporary provider `base_url` and `env_key` overrides. When proxy mode is installed, it keeps using the local proxy and sends a temporary `x-ccs-profile` provider header; the proxy uses that profile for the process without changing `profiles.current` and removes the internal header before contacting the provider. No profile, Codex config, auth, or proxy state file is modified.

Use `cxx` and `cxxs` only in directories and tasks you trust.

# ccx / ccxs

`ccx` runs Claude Code with permission checks skipped and forwards stdin, stdout, stderr, arguments, and exit code.

```bash
ccx ARGS...
ccx version
ccx -v
ccx help
ccx -h
ccx --help
```

Equivalent to:

```bash
claude --dangerously-skip-permissions ARGS...
```

`ccxs` resumes a Claude Code session with the same `ccx` flags.

```bash
ccxs ARGS...
ccxs version
ccxs -v
ccxs help
ccxs -h
ccxs --help
```

Equivalent to:

```bash
claude --dangerously-skip-permissions --resume ARGS...
```

Use `ccx` and `ccxs` only in directories and tasks you trust.

