// A renderer-independent decision broker. Navigation can reattach to a pending
// prompt, and an old or repeated answer can never close the application.
class CloseConfirmation {
  constructor(notify) { this.notify = notify; this.sequence = 0; this.pending = null; }
  request() {
    if (this.pending) return this.pending.promise;
    const id = ++this.sequence;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this.pending = { id, resolve, promise };
    this.notify({ id });
    return promise;
  }
  snapshot() { return this.pending ? { id: this.pending.id } : null; }
  choose(id, choice) {
    if (!this.pending || this.pending.id !== id || !['hide', 'exit', 'cancel'].includes(choice)) return false;
    const pending = this.pending; this.pending = null; pending.resolve(choice); return true;
  }
}
module.exports = { CloseConfirmation };
