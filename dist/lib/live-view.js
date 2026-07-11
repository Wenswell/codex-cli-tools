export function writeLiveFrame(lines, stream = process.stdout) {
    stream.write(`\u001b[H${lines.map((line) => `\u001b[2K${line}`).join("\n")}\u001b[J`);
}
export function createLiveViewController(options = {}) {
    const stream = options.stream ?? process.stdout;
    const enabled = options.enabled ?? Boolean(stream.isTTY);
    let started = false;
    let stopped = false;
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
        restoreTerminal();
        options.onStop?.();
    };
    const repaintOnResize = () => {
        resizeRender?.();
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
            }
        },
        stop,
        writeFrame(lines) {
            writeLiveFrame(lines, stream);
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
        onStop: () => {
            stopped = true;
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            options.onStop?.();
            if (options.onKey && process.stdin.isTTY) {
                process.stdin.off("data", onInput);
                process.stdin.setRawMode(false);
                process.stdin.pause();
            }
            resolveStopped?.();
        },
    });
    const onInput = (value) => {
        options.onKey?.(value.toString(), { stop: controller.stop, render: () => { void requestRender(); } });
    };
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
        if (controller.enabled && options.onKey && process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on("data", onInput);
        }
        await requestRender();
        if (!controller.enabled && options.onceWhenDisabled !== false) {
            controller.stop();
            return;
        }
        await new Promise((resolve) => {
            resolveStopped = resolve;
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
