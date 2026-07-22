# Codex Profile Commands Plan

Status: implemented in `0.2.56`

## Goal

Move one-process profile selection from `ccs run` to the Codex wrapper family:

```text
cx run PROFILE [CODEX_ARGS...]
cxx run PROFILE [CODEX_ARGS...]
cxxs run PROFILE [RESUME_ARGS...]
```

`ccs` remains responsible for profile configuration, inspection, switching, and
proxy management. The Codex wrappers own launching Codex.

## Command Contract

| command | behavior |
| --- | --- |
| `cx run PROFILE ...` | local Codex process with search and the selected profile |
| `cxx run PROFILE ...` | same, with approvals and sandboxing bypassed |
| `cxxs run PROFILE ...` | same as `cxx`, then resumes a session |

Profile launches are local because the selected provider's `env_key` is a
process environment variable. A client connected with `--remote` cannot inject
that variable into an already-running app-server daemon. Ordinary wrapper calls
keep their current default remote behavior and leading `local` mode.

The profile launch passes temporary provider `base_url` and `env_key` config
overrides. When the local proxy is installed, it also passes the temporary
`x-ccs-profile` routing header. It does not modify profile, Codex, auth, or proxy
files.

`ccs run` is removed without an alias or compatibility path. `run` is reserved
only as the first argument to each wrapper.

## Implementation

1. Extract shared profile reading and validation from `ccs` into a library.
2. Add a shared profile-launch resolver for the three Codex wrappers.
3. Add dedicated wrapper help and dispatch `run PROFILE` through the resolver.
4. Remove `ccs run` implementation and command documentation.
5. Update proxy documentation, README, focused tests, built output, and version.

## Acceptance

- All three wrappers select a named profile without changing stored state.
- Their generated Codex arguments preserve search, bypass, and resume semantics.
- Installed proxy routing remains pinned to the requested profile.
- Missing, unknown, and incomplete profiles fail before Codex starts.
- `ccs run` is absent from source, help, README, tests, and built output.
- `help`, `-h`, and `--help` print dedicated wrapper help.
- Type checks, focused tests, and the complete test suite pass.

## Result

- `cx`, `cxx`, and `cxxs` share one `run PROFILE` implementation while keeping
  their search, bypass, and resume differences.
- Profile launches use a local process with temporary provider configuration and
  `CODEX_TOOLS_PROFILE_API_KEY`; ordinary wrapper calls remain remote by default.
- Installed proxy launches keep policy and observability while routing through
  the requested profile header.
- `ccs run` and its obsolete design document were removed.
- README, proxy specifications, built output, and package version are aligned.
- `pnpm test` passes all 158 tests.
