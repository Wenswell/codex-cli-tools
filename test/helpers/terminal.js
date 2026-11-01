import { execFile, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";

export { stripAnsi };

export function setStdoutProperties(properties) {
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(process.stdout, key, {
      configurable: true,
      value,
    });
  }
}

export function withStdoutProperties(properties, run) {
  const descriptors = Object.fromEntries(
    Object.keys(properties).map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)]),
  );
  let restoreNow = true;
  const restore = () => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) {
        Object.defineProperty(process.stdout, key, descriptor);
      } else {
        delete process.stdout[key];
      }
    }
  };

  try {
    setStdoutProperties(properties);
    const result = run();
    if (result && typeof result.then === "function") {
      restoreNow = false;
      return result.finally(restore);
    }
    return result;
  } finally {
    if (restoreNow) {
      restore();
    }
  }
}

export async function captureStdout(run, options = {}) {
  // Let pending node:test reporter writes reach the real stdout before replacing it.
  await new Promise((resolve) => setImmediate(resolve));
  const originalWrite = process.stdout.write;
  let output = "";
  return await withStdoutProperties(
    {
      isTTY: options.isTTY ?? process.stdout.isTTY,
      columns: options.columns ?? process.stdout.columns,
      rows: options.rows ?? process.stdout.rows,
    },
    async () => {
      process.stdout.write = (chunk, encoding, callback) => {
        output += Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
        options.onWrite?.(output);
        if (typeof encoding === "function") {
          encoding();
        }
        if (typeof callback === "function") {
          callback();
        }
        return true;
      };
      try {
        await run();
      } finally {
        process.stdout.write = originalWrite;
      }
      return output;
    },
  );
}

function execNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      args,
      {
        cwd: process.cwd(),
        maxBuffer: 1024 * 1024,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function execNodeStdout(args, options = {}) {
  try {
    const { stdout } = await execNode(args, options);
    return stdout;
  } catch (error) {
    const message = String(error.stderr || error.stdout || error.message).trim();
    const wrapped = new Error(message || error.message);
    wrapped.stdout = error.stdout;
    wrapped.stderr = error.stderr;
    wrapped.cause = error;
    throw wrapped;
  }
}

export function execNodeScript(script, options = {}) {
  return execNode(["--input-type=module", "-e", script], options);
}

export function spawnNode(args, options = {}) {
  return spawn(process.execPath, args, options);
}

export function stdoutPropertiesScript(properties = {}) {
  const lines = [];
  if (properties.noColor === true) {
    lines.push('process.env.NO_COLOR = "1";');
  }
  if (properties.noColor === false) {
    lines.push("delete process.env.NO_COLOR;");
  }
  for (const key of ["isTTY", "columns", "rows"]) {
    if (Object.hasOwn(properties, key)) {
      lines.push(`Object.defineProperty(process.stdout, ${JSON.stringify(key)}, { configurable: true, value: ${JSON.stringify(properties[key])} });`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export const KEYS = {
  up: "\u001b[A",
  down: "\u001b[B",
  enter: "\r",
  space: " ",
  backspace: "\u007f",
  escape: "\u001b",
  ctrlC: "\u0003",
};

// Runs `run` with a fake TTY stdin. Each step waits until its pattern appears in the
// ANSI-stripped output after the previous match, then sends keys or calls a function.
export async function runInteractive(run, steps, options = {}) {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const input = new PassThrough();
  Object.defineProperty(input, "isTTY", { configurable: true, value: true });
  input.setRawMode = () => input;
  Object.defineProperty(process, "stdin", { configurable: true, value: input });
  let stepIndex = 0;
  let searchFrom = 0;
  let result;
  try {
    const output = await captureStdout(async () => {
      result = await run();
    }, {
      isTTY: true,
      columns: options.columns ?? 120,
      rows: options.rows ?? 40,
      onWrite(raw) {
        const plain = stripAnsi(raw);
        while (stepIndex < steps.length) {
          const [pattern, action] = steps[stepIndex];
          const found = plain.indexOf(pattern, searchFrom);
          if (found < 0) break;
          searchFrom = found + pattern.length;
          stepIndex += 1;
          setImmediate(() => {
            if (typeof action === "function") action();
            else input.write(action);
          });
        }
      },
    });
    if (stepIndex < steps.length) {
      throw new Error(`interactive step was not reached: ${steps[stepIndex][0]}\n${stripAnsi(output)}`);
    }
    return { output: stripAnsi(output), result };
  } finally {
    if (stdinDescriptor) Object.defineProperty(process, "stdin", stdinDescriptor);
  }
}
