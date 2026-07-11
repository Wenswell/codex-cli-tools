import { execFile, spawn } from "node:child_process";

export { default as stripAnsi } from "strip-ansi";

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
