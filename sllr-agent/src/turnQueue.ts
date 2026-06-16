export class TurnQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): void {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (this.tails.get(key) === next) this.tails.delete(key);
      });
    this.tails.set(key, next);
    next.catch(() => {});
  }
}
