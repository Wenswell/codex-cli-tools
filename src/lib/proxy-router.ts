import { ChatToResponsesSseTransform, ProtocolConversionError, chatToResponses, createResponsesChatToolContext, responsesToChat, type ResponsesChatToolContext, type ResponsesRequest } from "./responses-to-chat.js";

export type RouteConversion = { needsConversion: boolean; toolContext: ResponsesChatToolContext };

export function determineRouteConversion(path: string, enabled: boolean): RouteConversion | null {
  if (path !== "/v1/responses" && path !== "/responses") return null;
  return { needsConversion: enabled, toolContext: createResponsesChatToolContext() };
}

export function convertRequestBody(body: Buffer, conversion: RouteConversion): { body: Buffer; error?: string } {
  if (!conversion.needsConversion) return { body };
  try {
    const request = JSON.parse(body.toString("utf8")) as ResponsesRequest;
    if (!request || typeof request.model !== "string" || !(typeof request.input === "string" || Array.isArray(request.input))) {
      return { body, error: "Responses request requires model and input for Chat Completions conversion" };
    }
    return { body: Buffer.from(JSON.stringify(responsesToChat(request, conversion.toolContext)), "utf8") };
  } catch (error) {
    return { body, error: error instanceof Error ? error.message : "Responses request conversion failed" };
  }
}

export function rewriteUpstreamPath(_path: string, conversion: RouteConversion): string {
  return conversion.needsConversion ? "/v1/chat/completions" : _path;
}

export function convertResponseBody(body: Buffer, conversion: RouteConversion): Buffer {
  if (!conversion.needsConversion) return body;
  try {
    return Buffer.from(JSON.stringify(chatToResponses(JSON.parse(body.toString("utf8")) as Record<string, unknown>, conversion.toolContext)), "utf8");
  } catch (error) {
    throw new ProtocolConversionError("response_json", error instanceof Error ? error.message : String(error));
  }
}

export function createStreamingResponseConverter(conversion: RouteConversion): ChatToResponsesSseTransform | null {
  return conversion.needsConversion ? new ChatToResponsesSseTransform(conversion.toolContext) : null;
}
