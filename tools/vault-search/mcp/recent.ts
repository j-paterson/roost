export class RecentRing<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be positive");
  }
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  snapshot(): T[] {
    return this.buf.slice();
  }
}
