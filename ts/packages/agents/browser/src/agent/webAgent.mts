// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SessionContext } from "@typeagent/agent-sdk";
import { createGenericChannelProvider } from "@typeagent/agent-sdk/helpers/rpc/client";
import { BrowserActionContext } from "./actionHandler.mjs";

function ensureSharedChannelProvider(
  context: SessionContext<BrowserActionContext>,
) {
  const existing = context.agentContext.channelProvider;
  if (existing) {
    return existing;
  }

  const webSocket = context.agentContext.webSocket;
  if (webSocket === undefined) {
    return undefined;
  }

  const provider = createGenericChannelProvider((message) => {
    webSocket.send(
      JSON.stringify({
        target: "webAgent",
        source: "dispatcher",
        messageType: "message",
        message,
      }),
    );
  });
  context.agentContext.channelProvider = provider;
  return provider;
}

export function processWebAgentMessage(
  type: string,
  data: any,
  context: SessionContext<BrowserActionContext>,
) {
  const channelProvider = ensureSharedChannelProvider(context);
  if (channelProvider === undefined) {
    return;
  }

  switch (type) {
    case "add":
      channelProvider.createChannel(data.name);
      break;
    case "message":
      channelProvider.message(data);
      break;
    case "remove":
      channelProvider.deleteChannel(data.name);
      break;
  }
}
