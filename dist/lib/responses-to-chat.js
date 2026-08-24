import { createHash, randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
export class ProtocolConversionError extends Error {
    stage;
    constructor(stage, message) {
        super(message);
        this.stage = stage;
        this.name = "ProtocolConversionError";
    }
}
export function createResponsesChatToolContext() {
    return { byChatName: new Map() };
}
export function buildResponsesChatToolContext(request) {
    const context = createResponsesChatToolContext();
    for (const tool of request.tools ?? [])
        convertTool(tool, context);
    return context;
}
export function responsesToChat(request, toolContext = createResponsesChatToolContext()) {
    const messages = [];
    if (request.instructions) {
        messages.push({ role: "system", content: request.instructions });
    }
    if (typeof request.input === "string") {
        messages.push({ role: "user", content: request.input });
    }
    else {
        for (const item of request.input) {
            appendInputItem(messages, item, toolContext);
        }
    }
    const result = {
        model: request.model,
        messages,
        stream: request.stream ?? false,
    };
    if (request.stream)
        result.stream_options = { include_usage: true };
    if (request.temperature !== undefined)
        result.temperature = request.temperature;
    if (request.max_output_tokens !== undefined)
        result.max_completion_tokens = request.max_output_tokens;
    if (request.parallel_tool_calls !== undefined)
        result.parallel_tool_calls = request.parallel_tool_calls;
    if (request.service_tier !== undefined)
        result.service_tier = request.service_tier;
    if (request.store !== undefined)
        result.store = request.store;
    if (request.reasoning && typeof request.reasoning.effort === "string") {
        result.reasoning_effort = request.reasoning.effort;
    }
    if (request.tools?.length)
        result.tools = request.tools.flatMap((tool) => convertTool(tool, toolContext));
    if (request.tool_choice !== undefined)
        result.tool_choice = convertToolChoice(request.tool_choice);
    const responseFormat = convertTextFormat(request.text);
    if (responseFormat)
        result.response_format = responseFormat;
    return result;
}
function appendInputItem(messages, item, toolContext) {
    const type = item.type;
    if (type === "message" || (!type && typeof item.role === "string")) {
        const role = item.role;
        if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
            throw new Error(`unsupported Responses message role: ${String(role)}`);
        }
        messages.push({ role, content: convertMessageContent(item.content, role) });
        return;
    }
    if (type === "function_call") {
        const call = {
            id: requireString(item.call_id, "function_call.call_id"),
            type: "function",
            function: {
                name: chatToolName(requireString(item.name, "function_call.name"), typeof item.namespace === "string" ? item.namespace : undefined, toolContext),
                arguments: typeof item.arguments === "string" ? item.arguments : "",
            },
        };
        const previous = messages.at(-1);
        if (previous?.role === "assistant") {
            const toolCalls = Array.isArray(previous.tool_calls) ? previous.tool_calls : [];
            toolCalls.push(call);
            previous.tool_calls = toolCalls;
        }
        else {
            messages.push({ role: "assistant", content: null, tool_calls: [call] });
        }
        return;
    }
    if (type === "function_call_output") {
        messages.push({
            role: "tool",
            tool_call_id: requireString(item.call_id, "function_call_output.call_id"),
            content: stringifyOutput(item.output),
        });
        return;
    }
    if (type === "reasoning") {
        const summary = Array.isArray(item.summary)
            ? item.summary.flatMap((part) => isJson(part) && typeof part.text === "string" ? [part.text] : []).join("\n")
            : "";
        if (summary)
            messages.push({ role: "assistant", content: summary });
        return;
    }
    throw new Error(`unsupported Responses input item: ${String(type)}`);
}
function convertMessageContent(content, role) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        throw new Error("Responses message content must be a string or array");
    const parts = content.map((part) => {
        if (!isJson(part))
            throw new Error("Responses message content parts must be objects");
        if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
            return { type: "text", text: part.text };
        }
        if (part.type === "input_image" && typeof part.image_url === "string" && role === "user") {
            return {
                type: "image_url",
                image_url: {
                    url: part.image_url,
                    ...(typeof part.detail === "string" ? { detail: part.detail } : {}),
                },
            };
        }
        throw new Error(`unsupported Responses message content: ${String(part.type)}`);
    });
    if (parts.length === 1 && parts[0].type === "text")
        return parts[0].text;
    return parts;
}
function convertTool(tool, toolContext) {
    if (tool.type === "web_search" || tool.type === "web_search_preview")
        return [];
    if (tool.type === "namespace") {
        const namespace = requireString(tool.name, "namespace.name");
        if (!Array.isArray(tool.tools))
            throw new Error("namespace.tools must be an array");
        return tool.tools.flatMap((child) => {
            if (!isJson(child) || child.type !== "function")
                throw new Error(`unsupported namespace child tool: ${isJson(child) ? String(child.type) : typeof child}`);
            return convertFunctionTool(child, toolContext, namespace);
        });
    }
    if (tool.type !== "function")
        throw new Error(`unsupported Responses tool: ${String(tool.type)}`);
    return convertFunctionTool(tool, toolContext);
}
function convertFunctionTool(tool, toolContext, namespace) {
    const name = requireString(tool.name, "tool.name");
    const chatName = namespace ? flattenNamespaceToolName(namespace, name) : name;
    const existing = toolContext.byChatName.get(chatName);
    if (existing && (existing.name !== name || existing.namespace !== namespace)) {
        throw new Error(`Responses tools flatten to duplicate Chat tool name: ${chatName}`);
    }
    toolContext.byChatName.set(chatName, { name, ...(namespace ? { namespace } : {}) });
    return [{
            type: "function",
            function: {
                name: chatName,
                ...(typeof tool.description === "string" ? { description: tool.description } : {}),
                parameters: isJson(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
                ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
            },
        }];
}
function convertToolChoice(choice) {
    if (choice === "auto" || choice === "required" || choice === "none")
        return choice;
    if (isJson(choice) && choice.type === "function" && typeof choice.name === "string") {
        return { type: "function", function: { name: choice.name } };
    }
    throw new Error("unsupported Responses tool_choice");
}
function convertTextFormat(text) {
    if (!text || !isJson(text.format))
        return null;
    const format = text.format;
    if (format.type === "text")
        return null;
    if (format.type === "json_object")
        return { type: "json_object" };
    if (format.type === "json_schema" && typeof format.name === "string" && isJson(format.schema)) {
        return {
            type: "json_schema",
            json_schema: {
                name: format.name,
                schema: format.schema,
                ...(typeof format.description === "string" ? { description: format.description } : {}),
                ...(typeof format.strict === "boolean" ? { strict: format.strict } : {}),
            },
        };
    }
    throw new Error(`unsupported Responses text format: ${String(format.type)}`);
}
export function chatToResponses(chat, toolContext = createResponsesChatToolContext()) {
    const choice = Array.isArray(chat.choices) && isJson(chat.choices[0]) ? chat.choices[0] : null;
    if (!choice || !isJson(choice.message))
        throw new Error("Chat Completions response requires choices[0].message");
    const message = choice.message;
    const output = buildResponseOutput(message, toolContext);
    const finishReason = choice?.finish_reason;
    return responseObject({
        id: typeof chat.id === "string" ? chat.id : responseId(),
        createdAt: typeof chat.created === "number" ? chat.created : Math.floor(Date.now() / 1000),
        model: typeof chat.model === "string" ? chat.model : "unknown",
        status: finishReason === "length" || finishReason === "content_filter" ? "incomplete" : "completed",
        output,
        usage: convertUsage(chat.usage),
        incompleteReason: finishReason === "length" ? "max_output_tokens" : finishReason === "content_filter" ? "content_filter" : null,
    });
}
function buildResponseOutput(message, toolContext) {
    const output = [];
    if (typeof message.content === "string" || typeof message.refusal === "string") {
        const content = [];
        if (typeof message.content === "string")
            content.push({ type: "output_text", text: message.content, annotations: [] });
        if (typeof message.refusal === "string")
            content.push({ type: "refusal", refusal: message.refusal });
        output.push({ id: itemId("msg"), type: "message", status: "completed", role: "assistant", content });
    }
    if (Array.isArray(message.tool_calls)) {
        for (const rawCall of message.tool_calls) {
            if (!isJson(rawCall) || !isJson(rawCall.function))
                continue;
            const chatName = requireString(rawCall.function.name, "tool_call.function.name");
            const identity = toolContext.byChatName.get(chatName);
            output.push({
                id: itemId("fc"),
                type: "function_call",
                status: "completed",
                call_id: requireString(rawCall.id, "tool_call.id"),
                name: identity?.name ?? chatName,
                ...(identity?.namespace ? { namespace: identity.namespace } : {}),
                arguments: typeof rawCall.function.arguments === "string" ? rawCall.function.arguments : "",
            });
        }
    }
    return output;
}
function responseObject(input) {
    return {
        id: input.id,
        object: "response",
        created_at: input.createdAt,
        completed_at: input.status === "in_progress" ? null : Math.floor(Date.now() / 1000),
        status: input.status,
        error: null,
        incomplete_details: input.incompleteReason ? { reason: input.incompleteReason } : null,
        instructions: null,
        max_output_tokens: null,
        model: input.model,
        output: input.output,
        parallel_tool_calls: true,
        previous_response_id: null,
        reasoning: { effort: null, summary: null },
        store: false,
        temperature: null,
        text: { format: { type: "text" } },
        tool_choice: "auto",
        tools: [],
        top_p: null,
        truncation: "disabled",
        usage: input.usage,
        metadata: {},
    };
}
export class ChatToResponsesSseTransform extends Transform {
    toolContext;
    #decoder = new StringDecoder("utf8");
    #buffer = "";
    #id = responseId();
    #model = "unknown";
    #createdAt = Math.floor(Date.now() / 1000);
    #sequence = 0;
    #started = false;
    #completed = false;
    #finishReason = null;
    #usage = null;
    #outputs = [];
    #message = null;
    #messageText = "";
    #refusalText = "";
    #messageParts = [];
    #tools = new Map();
    constructor(toolContext = createResponsesChatToolContext()) {
        super();
        this.toolContext = toolContext;
    }
    endAfterUpstreamDisconnect() {
        if (this.#completed || this.#finishReason === null)
            return false;
        this.end();
        return true;
    }
    _transform(chunk, _encoding, callback) {
        try {
            this.#buffer += this.#decoder.write(chunk);
            const events = this.#buffer.split(/\r?\n\r?\n/);
            this.#buffer = events.pop() ?? "";
            for (const event of events)
                this.#convertEvent(event);
            callback();
        }
        catch (error) {
            callback(error instanceof ProtocolConversionError
                ? error
                : new ProtocolConversionError("response_stream", error instanceof Error ? error.message : String(error)));
        }
    }
    _flush(callback) {
        try {
            this.#buffer += this.#decoder.end();
            if (this.#buffer.trim())
                this.#convertEvent(this.#buffer);
            if (!this.#completed && this.#finishReason !== null)
                this.#complete();
            callback();
        }
        catch (error) {
            callback(error instanceof ProtocolConversionError
                ? error
                : new ProtocolConversionError("response_stream", error instanceof Error ? error.message : String(error)));
        }
    }
    #convertEvent(event) {
        const data = event.split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
        if (!data)
            return;
        if (data === "[DONE]") {
            if (this.#finishReason === null)
                throw new Error("Chat Completions stream ended before finish_reason");
            this.#complete();
            return;
        }
        const chunk = JSON.parse(data);
        if (typeof chunk.id === "string")
            this.#id = chunk.id;
        if (typeof chunk.model === "string")
            this.#model = chunk.model;
        if (typeof chunk.created === "number")
            this.#createdAt = chunk.created;
        if (isJson(chunk.usage))
            this.#usage = convertUsage(chunk.usage);
        this.#start();
        const choice = Array.isArray(chunk.choices) && isJson(chunk.choices[0]) ? chunk.choices[0] : null;
        if (!choice)
            return;
        if (choice.finish_reason !== null && choice.finish_reason !== undefined)
            this.#finishReason = choice.finish_reason;
        if (!isJson(choice.delta))
            return;
        const delta = choice.delta;
        if (typeof delta.content === "string" && delta.content)
            this.#appendText(delta.content);
        if (typeof delta.refusal === "string" && delta.refusal)
            this.#appendRefusal(delta.refusal);
        if (Array.isArray(delta.tool_calls)) {
            for (const rawTool of delta.tool_calls)
                if (isJson(rawTool))
                    this.#appendTool(rawTool);
        }
    }
    #start() {
        if (this.#started)
            return;
        this.#emit("response.created", {
            response: responseObject({ id: this.#id, createdAt: this.#createdAt, model: this.#model, status: "in_progress", output: [], usage: null }),
        });
        this.#emit("response.in_progress", {
            response: responseObject({ id: this.#id, createdAt: this.#createdAt, model: this.#model, status: "in_progress", output: [], usage: null }),
        });
        this.#started = true;
    }
    #ensureMessagePart(type) {
        if (!this.#message) {
            const item = { id: itemId("msg"), type: "message", status: "in_progress", role: "assistant", content: [] };
            this.#outputs.push(item);
            this.#message = item;
            this.#emit("response.output_item.added", { output_index: this.#outputs.length - 1, item });
        }
        let contentIndex = this.#messageParts.indexOf(type);
        if (contentIndex === -1) {
            contentIndex = this.#messageParts.length;
            this.#messageParts.push(type);
            this.#emit("response.content_part.added", {
                item_id: this.#message.id,
                output_index: this.#outputs.indexOf(this.#message),
                content_index: contentIndex,
                part: type === "output_text"
                    ? { type, text: "", annotations: [] }
                    : { type, refusal: "" },
            });
        }
        return { item: this.#message, contentIndex };
    }
    #appendText(delta) {
        const { item, contentIndex } = this.#ensureMessagePart("output_text");
        this.#messageText += delta;
        this.#emit("response.output_text.delta", {
            item_id: item.id,
            output_index: this.#outputs.indexOf(item),
            content_index: contentIndex,
            delta,
            logprobs: [],
        });
    }
    #appendRefusal(delta) {
        const { item, contentIndex } = this.#ensureMessagePart("refusal");
        this.#refusalText += delta;
        this.#emit("response.refusal.delta", {
            item_id: item.id,
            output_index: this.#outputs.indexOf(item),
            content_index: contentIndex,
            delta,
        });
    }
    #appendTool(rawTool) {
        const index = typeof rawTool.index === "number" ? rawTool.index : 0;
        let item = this.#tools.get(index);
        const fn = isJson(rawTool.function) ? rawTool.function : {};
        if (!item) {
            item = {
                id: itemId("fc"),
                type: "function_call",
                status: "in_progress",
                call_id: typeof rawTool.id === "string" ? rawTool.id : itemId("call"),
                name: typeof fn.name === "string" ? fn.name : "",
                arguments: "",
            };
            this.#tools.set(index, item);
            const outputIndex = this.#outputs.length;
            this.#outputs.push(item);
            this.#emit("response.output_item.added", { output_index: outputIndex, item: { ...item } });
        }
        else {
            if (typeof rawTool.id === "string")
                item.call_id = rawTool.id;
            if (typeof fn.name === "string")
                item.name = `${item.name}${fn.name}`;
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
            item.arguments = `${item.arguments}${fn.arguments}`;
            this.#emit("response.function_call_arguments.delta", {
                item_id: item.id,
                output_index: this.#outputs.indexOf(item),
                delta: fn.arguments,
            });
        }
    }
    #complete() {
        if (this.#completed)
            return;
        this.#start();
        if (this.#message) {
            const outputIndex = this.#outputs.indexOf(this.#message);
            const content = this.#messageParts.map((type) => type === "output_text"
                ? { type, text: this.#messageText, annotations: [] }
                : { type, refusal: this.#refusalText });
            this.#message.status = "completed";
            this.#message.content = content;
            for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
                const part = content[contentIndex];
                if (part.type === "output_text") {
                    this.#emit("response.output_text.done", { item_id: this.#message.id, output_index: outputIndex, content_index: contentIndex, text: this.#messageText, logprobs: [] });
                }
                else {
                    this.#emit("response.refusal.done", { item_id: this.#message.id, output_index: outputIndex, content_index: contentIndex, refusal: this.#refusalText });
                }
                this.#emit("response.content_part.done", { item_id: this.#message.id, output_index: outputIndex, content_index: contentIndex, part });
            }
            this.#emit("response.output_item.done", { output_index: outputIndex, item: this.#message });
        }
        for (const item of this.#tools.values()) {
            const outputIndex = this.#outputs.indexOf(item);
            const identity = this.toolContext.byChatName.get(String(item.name));
            if (identity) {
                item.name = identity.name;
                if (identity.namespace)
                    item.namespace = identity.namespace;
            }
            item.status = "completed";
            this.#emit("response.function_call_arguments.done", { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
            this.#emit("response.output_item.done", { output_index: outputIndex, item });
        }
        const incompleteReason = this.#finishReason === "length"
            ? "max_output_tokens"
            : this.#finishReason === "content_filter" ? "content_filter" : null;
        this.#emit(incompleteReason ? "response.incomplete" : "response.completed", {
            response: responseObject({
                id: this.#id,
                createdAt: this.#createdAt,
                model: this.#model,
                status: incompleteReason ? "incomplete" : "completed",
                output: this.#outputs,
                usage: this.#usage,
                incompleteReason,
            }),
        });
        this.#completed = true;
    }
    #emit(type, fields) {
        const payload = { type, sequence_number: this.#sequence++, ...fields };
        this.push(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
}
function convertUsage(value) {
    if (!isJson(value))
        return null;
    const promptTokens = numberOrZero(value.prompt_tokens ?? value.input_tokens);
    const completionTokens = numberOrZero(value.completion_tokens ?? value.output_tokens);
    const promptDetails = isJson(value.prompt_tokens_details) ? value.prompt_tokens_details : {};
    const completionDetails = isJson(value.completion_tokens_details) ? value.completion_tokens_details : {};
    return {
        input_tokens: promptTokens,
        input_tokens_details: { cached_tokens: numberOrZero(promptDetails.cached_tokens) },
        output_tokens: completionTokens,
        output_tokens_details: { reasoning_tokens: numberOrZero(completionDetails.reasoning_tokens) },
        total_tokens: typeof value.total_tokens === "number" ? value.total_tokens : promptTokens + completionTokens,
    };
}
function numberOrZero(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function stringifyOutput(output) {
    return typeof output === "string" ? output : JSON.stringify(output ?? "");
}
function requireString(value, field) {
    if (typeof value !== "string" || !value)
        throw new Error(`${field} must be a non-empty string`);
    return value;
}
function isJson(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function responseId() {
    return `resp_${randomUUID().replaceAll("-", "")}`;
}
function itemId(prefix) {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
function chatToolName(name, namespace, toolContext) {
    if (!namespace)
        return name;
    const chatName = flattenNamespaceToolName(namespace, name);
    const identity = toolContext.byChatName.get(chatName);
    if (!identity || identity.name !== name || identity.namespace !== namespace) {
        throw new Error(`function_call references unknown namespace tool: ${namespace}/${name}`);
    }
    return chatName;
}
function flattenNamespaceToolName(namespace, name) {
    const fullName = `${namespace}__${name}`;
    if (Buffer.byteLength(fullName) <= 64)
        return fullName;
    const suffix = `__${createHash("sha256").update(fullName).digest("hex").slice(0, 12)}`;
    let prefix = "";
    for (const character of fullName) {
        if (Buffer.byteLength(prefix + character + suffix) > 64)
            break;
        prefix += character;
    }
    return `${prefix}${suffix}`;
}
