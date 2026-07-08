import type { NeutralEvent } from 'analytics-kit';

// Minimal in-memory hand-off for minted server events. The real batch queue —
// locked defaults, size/interval flush triggers, drop-oldest on overflow — lands in
// E7-S3; this stub only receives an event so the capture path is exercised end-to-end.
export interface EventBuffer {
  add(event: NeutralEvent): void;
}

export class InMemoryEventBuffer implements EventBuffer {
  private readonly events: NeutralEvent[] = [];

  add(event: NeutralEvent): void {
    this.events.push(event);
  }

  drain(): NeutralEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
