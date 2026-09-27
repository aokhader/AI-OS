import { EventEmitter } from 'node:events';
import type {
  ConsoleMessage,
  Escalation,
  EscalationControls,
  Operator,
  RecordedStep,
} from '@handsoff/core';

/**
 * Escalations the process that owns the browser can act on (D-036): the console operator adds
 * each one here, the API claims and hands back through its controls, and every change is pushed
 * to WebSocket subscribers. Records themselves live in the store; this holds only the live
 * controls.
 */
export class LiveRegistry {
  private readonly entries = new Map<string, EscalationControls>();
  private readonly emitter = new EventEmitter();

  add(escalation: Escalation, controls: EscalationControls): void {
    this.entries.set(escalation.id, controls);
    this.publish({ type: 'escalation', escalation });
    controls.onHumanAction((step: RecordedStep) => {
      this.publish({
        type: 'human_action',
        escalationId: escalation.id,
        runId: escalation.runId,
        step,
      });
    });
    void controls.settled.then((final) => {
      this.entries.delete(escalation.id);
      this.publish({ type: 'escalation', escalation: final });
      this.publish({ type: 'run', runId: escalation.runId });
    });
  }

  get(id: string): EscalationControls | undefined {
    return this.entries.get(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  subscribe(listener: (message: ConsoleMessage) => void): () => void {
    this.emitter.on('message', listener);
    return () => {
      this.emitter.off('message', listener);
    };
  }

  publish(message: ConsoleMessage): void {
    this.emitter.emit('message', message);
  }
}

/** The operator behind `--operator console`: hands every escalation to the live API. */
export function createConsoleOperator(registry: LiveRegistry): Operator {
  return {
    info: () => ({ id: 'console' }),
    escalate(escalation, controls) {
      registry.add(escalation, controls);
    },
  };
}
