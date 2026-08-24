import { ChatToResponsesSseTransform, ProtocolConversionError, chatToResponses, createResponsesChatToolContext, responsesToChat } from "./responses-to-chat.js";
export function determineRouteConversion(path, enabled) {
    if (path !== "/v1/responses" && path !== "/responses")
        return null;
    return { needsConversion: enabled, toolContext: createResponsesChatToolContext() };
}
export function convertRequestBody(body, conversion) {
    if (!conversion.needsConversion)
        return { body };
    try {
        const request = JSON.parse(body.toString("utf8"));
        if (!request || typeof request.model !== "string" || !(typeof request.input === "string" || Array.isArray(request.input))) {
            return { body, error: "Responses request requires model and input for Chat Completions conversion" };
        }
        return { body: Buffer.from(JSON.stringify(responsesToChat(request, conversion.toolContext)), "utf8") };
    }
    catch (error) {
        return { body, error: error instanceof Error ? error.message : "Responses request conversion failed" };
    }
}
export function rewriteUpstreamPath(_path, conversion) {
    return conversion.needsConversion ? "/v1/chat/completions" : _path;
}
export function convertResponseBody(body, conversion) {
    if (!conversion.needsConversion)
        return body;
    try {
        return Buffer.from(JSON.stringify(chatToResponses(JSON.parse(body.toString("utf8")), conversion.toolContext)), "utf8");
    }
    catch (error) {
        throw new ProtocolConversionError("response_json", error instanceof Error ? error.message : String(error));
    }
}
export function createStreamingResponseConverter(conversion) {
    return conversion.needsConversion ? new ChatToResponsesSseTransform(conversion.toolContext) : null;
}
