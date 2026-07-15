export function writeLiveFrame(lines, stream = process.stdout) {
    stream.write(`\u001b[H${lines.map((line) => `\u001b[2K${line}`).join("\n")}\u001b[J`);
}
export function pinLiveViewFooter(lines, rows) {
    if (lines.length === 0 || !Number.isInteger(rows) || !rows || rows <= 0) {
        return lines;
    }
    if (lines.length >= rows) {
        return lines;
    }
    const footer = lines.at(-1) ?? "";
    const body = lines.slice(0, -1);
    return [
        ...body,
        ...Array(Math.max(0, rows - body.length - 1)).fill(""),
        footer,
    ];
}
export function createLiveViewController(options = {}) {
    const stream = options.stream ?? process.stdout;
    const input = options.input ?? process.stdin;
    const enabled = options.enabled ?? Boolean(stream.isTTY);
    let started = false;
    let stopped = false;
    let inputStarted = false;
    let resizeRender = null;
    const restoreTerminal = () => {
        if (enabled) {
            stream.write("\u001b[?25h\u001b[?1049l");
        }
    };
    const stop = () => {
        if (stopped) {
            return;
        }
        stopped = true;
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        stream.off("resize", repaintOnResize);
        if (inputStarted) {
            input.off("data", onInput);
            input.setRawMode(false);
            input.pause();
            inputStarted = false;
        }
        restoreTerminal();
        options.onStop?.();
    };
    const repaintOnResize = () => {
        resizeRender?.();
    };
    const onInput = (value) => {
        const key = value.toString();
        if (key === "\u0003") {
            stop();
            return;
        }
        options.onKey?.(key, { stop, render: () => resizeRender?.() });
    };
    return {
        get enabled() {
            return enabled;
        },
        start() {
            if (started) {
                return;
            }
            started = true;
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            if (enabled) {
                stream.write("\u001b[?1049h\u001b[?25l");
                stream.on("resize", repaintOnResize);
                if (options.onKey && input.isTTY) {
                    input.setRawMode(true);
                    input.resume();
                    input.on("data", onInput);
                    inputStarted = true;
                }
            }
        },
        stop,
        writeFrame(lines) {
            writeLiveFrame(options.pinFooter ? pinLiveViewFooter(lines, stream.rows) : lines, stream);
        },
        setResizeRender(render) {
            resizeRender = render;
        },
    };
}
export async function runLiveView(render, options) {
    let timer = null;
    let refreshing = false;
    let renderPending = false;
    let stopped = false;
    let resolveStopped = null;
    const controller = createLiveViewController({
        ...options,
        onKey: options.onKey
            ? (key, controls) => options.onKey?.(key, { stop: controls.stop, render: () => { void requestRender(); } })
            : undefined,
        onStop: () => {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            options.onStop?.();
            resolveStopped?.();
        },
    });
    const requestRender = async () => {
        if (stopped) {
            return;
        }
        if (refreshing) {
            renderPending = true;
            return;
        }
        refreshing = true;
        do {
            renderPending = false;
            const lines = await render();
            if (controller.enabled) {
                controller.writeFrame(lines);
            }
            else {
                (options.stream ?? process.stdout).write(`${lines.join("\n")}\n`);
            }
        } while (renderPending && !stopped);
        refreshing = false;
    };
    controller.setResizeRender(() => {
        void requestRender();
    });
    controller.start();
    try {
        await requestRender();
        if (!controller.enabled && options.onceWhenDisabled !== false) {
            controller.stop();
            return;
        }
        await new Promise((resolve) => {
            resolveStopped = resolve;
            if (stopped) {
                resolve();
                return;
            }
            timer = setInterval(() => {
                void requestRender();
            }, options.intervalMs);
        });
    }
    catch (error) {
        controller.stop();
        throw error;
    }
}
