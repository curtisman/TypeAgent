// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { NotifyConfig } from "./config.js";

/** A notification event payload. */
export interface NotifyEvent {
    lane: string;
    event: "blocked" | "failed" | "done" | "error";
    message: string;
}

/** Abstract notifier interface. */
export interface Notifier {
    notify(event: NotifyEvent): Promise<void>;
}

/** No-op notifier for testing or when notifications are disabled. */
class NoneNotifier implements Notifier {
    async notify(_event: NotifyEvent): Promise<void> {
        // intentionally empty
    }
}

/** Notifier that sends HTTP POST to ntfy.sh (or a self-hosted instance). */
class NtfyNotifier implements Notifier {
    private readonly url: string;

    constructor(topic: string) {
        // Support full URLs for self-hosted ntfy, default to ntfy.sh
        if (topic.startsWith("http://") || topic.startsWith("https://")) {
            this.url = topic;
        } else {
            this.url = `https://ntfy.sh/${encodeURIComponent(topic)}`;
        }
    }

    async notify(event: NotifyEvent): Promise<void> {
        const title = `[${event.event.toUpperCase()}] ${event.lane}`;
        try {
            await fetch(this.url, {
                method: "POST",
                headers: {
                    Title: title,
                    Tags: event.event,
                },
                body: event.message,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`Warning: ntfy notification failed: ${msg}\n`);
        }
    }
}

/**
 * Create a notifier from the config's notify section.
 * Only "ntfy" and "none" are supported in Phase 1.
 */
export function createNotifier(config: NotifyConfig): Notifier {
    switch (config.channel) {
        case "ntfy":
            if (config.topic === undefined || config.topic.length === 0) {
                throw new Error(
                    `ntfy notifier requires a "topic" in notify config`,
                );
            }
            return new NtfyNotifier(config.topic);
        case "none":
            return new NoneNotifier();
        default:
            // desktop and webhook not implemented in Phase 1
            return new NoneNotifier();
    }
}
