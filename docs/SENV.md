# senv

`senv` regenerates a target env file from an example env file while preserving existing values.

`senv version` and `senv -v` print the shared package version.

Default discovery:

```bash
senv
```

With no path options, `senv` finds the single file in the current directory whose
name ends with `.env.example` and removes the final `.example` suffix for the
target. For example, `.env.example` targets `.env`, while
`runtime.env.example` targets `runtime.env`. If the directory has no matching
file or more than one, specify both paths explicitly.

Explicit paths:

```bash
senv --source .env.example --target .env
```

Default mode is preview. Nothing is modified unless you type exact `yes` at the prompt.
Preview prints a unified diff; common sensitive env keys such as `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASS`, `AUTH`, and `CREDENTIAL` are masked in that diff. Apply mode first prints the same planned summary and diff as preview, asks for confirmation, then prints the updated result after writing.

Options:

```bash
senv
senv version
senv -v
senv --source .env.example --target .env.local
senv -b
```

`-b` is short for `--backup`.

Parsing:

- Supports `KEY=value`.
- Supports `export KEY=value`.
- Key pattern: `[A-Za-z_][A-Za-z0-9_]*`.
- Value is kept exactly as text after `=`.
- Empty lines, comments, and unparsable lines are raw lines.

Merge behavior:

- Output order follows the source file.
- Source comments, blank lines, and raw lines are preserved.
- `export KEY=value` is normalized to `KEY=value`.
- If target does not contain a source key, the source value is used and counted as `added`.
- If target contains a non-empty value, the target value is preserved.
- If target contains an empty value and source has a non-empty value, the source default is filled.
- If both target and source values are empty, the empty value is preserved.
- Keys that exist only in target are appended at the end under `# Extra keys from existing .env`.
- Extra keys are written as `KEY=value`; their original comments and positions are not preserved.
- Output always ends with a newline.

Important: an intentionally empty target value is filled when the source has a non-empty default. This is for default-value migration, not for cases where empty means disabled.

CLI output includes the target file and counts/lists for added, filled defaults, preserved, preserved empty, and extra keys.

