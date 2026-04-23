export class Semaphore {
  private _max: number;
  private _active = 0;
  private _queue: Array<() => void> = [];

  constructor(max: number) {
    this._max = max;
  }

  get active(): number {
    return this._active;
  }

  get waiting(): number {
    return this._queue.length;
  }

  acquire(): Promise<void> {
    if (this._max === 0 || this._active < this._max) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._active--;
    }
  }
}
