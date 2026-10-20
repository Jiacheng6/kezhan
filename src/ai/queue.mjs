import { randomUUID } from 'node:crypto';
import { throwIfStopped } from '../control.mjs';
// One owner for the whole web-chat transaction (draft/upload/send/read/verification).
// Never release a busy page merely because the caller stopped waiting.
export class AIQueue {
  constructor(changed = () => {}) { this.active = null; this.pending = []; this.changed = changed; }
  snapshot() { return { active: this.active?.info || null, pending: this.pending.map(item => item.info) }; }
  emit() { try { this.changed(this.snapshot()); } catch {} }
  run(operation, { shouldStop, ...metadata } = {}) {
    try { throwIfStopped(shouldStop); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const item = { operation, shouldStop, resolve, reject, info: { requestId: randomUUID(), ...metadata, queuedAt: Date.now() } };
      item.timer = setInterval(() => {
        try { throwIfStopped(shouldStop); } catch (error) {
          const index = this.pending.indexOf(item);
          if (index >= 0) { this.pending.splice(index, 1); clearInterval(item.timer); reject(error); this.emit(); }
        }
      }, 100);
      this.pending.push(item); this.emit(); this.drain();
    });
  }
  async drain() {
    if (this.active) return;
    const item = this.pending.shift(); if (!item) return;
    clearInterval(item.timer); this.active = item; this.emit();
    try { throwIfStopped(item.shouldStop); item.resolve(await item.operation(item.info)); }
    catch (error) { item.reject(error); }
    finally { this.active = null; this.emit(); void this.drain(); }
  }
}
let listener = () => {};
export const aiQueue = new AIQueue(value => listener(value));
export function onAIQueueChange(callback) { listener = callback; listener(aiQueue.snapshot()); }
