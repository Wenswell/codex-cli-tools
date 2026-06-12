import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCodexUsageEvents } from "../dist/lib/codex-usage.js";

test("loads fork rollout usage from the current task boundary", async () => {
  const createdAtMs = Date.parse("2026-06-10T08:50:19.684Z");
  const project = "/tmp/codex-tools-project";
  const parentTurnId = uuidV7At(createdAtMs - 60_000);
  const previousForkTurnId = uuidV7At(createdAtMs - 10_000);
  const currentTurnId = uuidV7At(createdAtMs + 10);
  const laterTurnId = uuidV7At(createdAtMs + 40_000);

  await withCodexFixture({
    createdAtMs,
    project,
    lines: [
      sessionMeta("019eb0b9-af9f-79b3-9c25-a2f1d1aa0565", createdAtMs, project, "019e981c-06ef-7970-8bf7-2b1afb0b63cc"),
      taskStarted(parentTurnId, createdAtMs - 60_000),
      turnContext(parentTurnId, project),
      tokenCount("2026-06-10T08:49:19.700Z", { input: 1000, output: 10 }),
      taskStarted(previousForkTurnId, createdAtMs - 10_000),
      turnContext(previousForkTurnId, project),
      tokenCount("2026-06-10T08:50:09.700Z", { input: 2000, output: 20 }),
      taskStarted(currentTurnId, createdAtMs + 10),
      turnContext(currentTurnId, project),
      tokenCount("2026-06-10T08:50:20.000Z", { input: 200, output: 2 }),
      threadRolledBack("2026-06-10T08:50:30.000Z"),
      taskStarted(laterTurnId, createdAtMs + 40_000),
      turnContext(laterTurnId, project),
      tokenCount("2026-06-10T08:51:00.000Z", { input: 300, output: 3 }),
    ],
  }, async () => {
    const events = await loadCodexUsageEvents({ timezone: "UTC" });

    assert.deepEqual(events.map((event) => event.usage.inputTokens), [200, 300]);
    assert.deepEqual(events.map((event) => event.usage.outputTokens), [2, 3]);
    assert.deepEqual(events.map((event) => event.model), ["gpt-5.5", "gpt-5.5"]);
    assert.deepEqual(events.map((event) => event.project), [project, project]);
  });
});

test("loads subagent fork usage without a rollback event", async () => {
  const createdAtMs = Date.parse("2026-05-16T04:25:50.371Z");
  const project = "/tmp/codex-tools-subagent-project";
  const parentTurnId = uuidV7At(createdAtMs - 40_000);
  const currentTurnId = uuidV7At(createdAtMs + 35);

  await withCodexFixture({
    createdAtMs,
    project,
    lines: [
      sessionMeta("019e2f08-8e23-7471-bfa8-03da7485b786", createdAtMs, project, "019e2f07-9c25-7fe1-b1d1-3dc5d1f9c3f7"),
      taskStarted(parentTurnId, createdAtMs - 40_000),
      turnContext(parentTurnId, project),
      tokenCount("2026-05-16T04:25:10.400Z", { input: 900, output: 9 }),
      taskStarted(currentTurnId, createdAtMs + 35),
      turnContext(currentTurnId, project),
      tokenCount("2026-05-16T04:25:54.396Z", { input: 700, output: 7 }),
    ],
  }, async () => {
    const events = await loadCodexUsageEvents({ timezone: "UTC" });

    assert.deepEqual(events.map((event) => event.usage.inputTokens), [700]);
    assert.deepEqual(events.map((event) => event.usage.outputTokens), [7]);
  });
});

async function withCodexFixture(fixture, run) {
  const home = await mkdtemp(join(tmpdir(), "codex-usage-home-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const codexDir = join(home, ".codex");
    const sessionsDir = join(codexDir, "sessions", "2026", "06", "10");
    await mkdir(sessionsDir, { recursive: true });
    const rolloutPath = join(sessionsDir, "rollout-fixture.jsonl");
    await writeFile(rolloutPath, `${fixture.lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    const dbPath = join(codexDir, "state.sqlite");
    await sqliteRun(dbPath, `
      create table threads (
        id text primary key,
        rollout_path text not null,
        created_at integer not null,
        updated_at integer not null,
        cwd text not null,
        model text,
        created_at_ms integer,
        updated_at_ms integer
      );
      insert into threads values (
        'thread-fixture',
        '${sqlString(rolloutPath)}',
        ${Math.floor(fixture.createdAtMs / 1000)},
        ${Math.floor((fixture.createdAtMs + 120000) / 1000)},
        '${sqlString(fixture.project)}',
        'gpt-5.5',
        ${fixture.createdAtMs},
        ${fixture.createdAtMs + 120000}
      );
    `);

    await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(home, { recursive: true, force: true });
  }
}

function sessionMeta(id, timestampMs, cwd, forkedFromId) {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    type: "session_meta",
    payload: {
      id,
      forked_from_id: forkedFromId,
      timestamp: new Date(timestampMs).toISOString(),
      cwd,
    },
  };
}

function taskStarted(turnId, timestampMs) {
  return {
    timestamp: new Date(timestampMs).toISOString(),
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
      started_at: Math.floor(timestampMs / 1000),
    },
  };
}

function turnContext(turnId, cwd) {
  return {
    timestamp: new Date(uuidV7TimestampMs(turnId)).toISOString(),
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd,
      model: "gpt-5.5",
    },
  };
}

function tokenCount(timestamp, usage) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: usage.input,
          cached_input_tokens: usage.cached ?? 0,
          output_tokens: usage.output,
          reasoning_output_tokens: usage.reasoning ?? 0,
          total_tokens: usage.input + usage.output,
        },
        last_token_usage: {
          input_tokens: usage.input,
          cached_input_tokens: usage.cached ?? 0,
          output_tokens: usage.output,
          reasoning_output_tokens: usage.reasoning ?? 0,
          total_tokens: usage.input + usage.output,
        },
      },
    },
  };
}

function threadRolledBack(timestamp) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "thread_rolled_back",
      num_turns: 1,
    },
  };
}

function uuidV7At(timestampMs) {
  const prefix = Math.floor(timestampMs).toString(16).padStart(12, "0");
  return `${prefix.slice(0, 8)}-${prefix.slice(8, 12)}-7000-8000-000000000000`;
}

function uuidV7TimestampMs(value) {
  return Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
}

function sqliteRun(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = execFile("sqlite3", [dbPath], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve();
    });
    child.stdin?.end(sql);
  });
}

function sqlString(value) {
  return value.replaceAll("'", "''");
}
