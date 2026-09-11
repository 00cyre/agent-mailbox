import { EventEmitter } from 'node:events';

/**
 * One native reply at a time, keyed by thread id.
 *
 * Codex `exec resume` returns the assistant turn immediately. `codex queue`
 * and the ChatGPT Mac wrapper do not — they emit later, when the session log
 * or accessibility tree changes. The bridge waits on this bus after `send`.
 */
export class ReplyBus {
  readonly #events = new EventEmitter();

  constructor() {
    this.#events.setMaxListeners(50);
  }

  emit(threadId: string, body: string): void {
    this.#events.emit(threadId, body);
    this.#events.emit('*', threadId, body);
  }

  listen(threadId: string, handler: (body: string) => void): () => void {
    const wrapped = (body: string): void => {
      handler(body);
    };
    this.#events.on(threadId, wrapped);
    return () => {
      this.#events.off(threadId, wrapped);
    };
  }

  wait(threadId: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const stop = this.listen(threadId, (body) => {
        clearTimeout(timer);
        stop();
        resolve(body);
      });
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`no native reply from ${threadId} after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }
}
