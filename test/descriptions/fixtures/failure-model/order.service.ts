// Synthetic fixture for the normalised-failure tests. Neutral domain only.
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

export class OrderRepository {
  async load(id: string): Promise<{ id: string } | undefined> {
    return id === 'known' ? { id } : undefined;
  }
}

function ensureKind(kind: string): void {
  if (kind === 'a') throw new ConflictException('Module kind a');
  if (kind === 'b') throw new ConflictException('Module kind b');
}

@Injectable()
export class OrderService {
  constructor(private readonly orderRepository: OrderRepository = new OrderRepository()) {}

  async find(id: string) {
    const order = await this.orderRepository.load(id);
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  // Helper whose two failures depend on a parameter.
  check(kind: string): void {
    if (kind === 'a') throw new ConflictException('Kind a');
    if (kind === 'b') throw new ConflictException('Kind b');
  }

  kindA(): void {
    this.check('a');
  }

  kindB(): void {
    this.check('b');
  }

  // Parameter is not a literal: nothing can be narrowed.
  kindUnknown(kind: string): void {
    this.check(kind);
  }

  // One method calls the helper with two different literals.
  bothKinds(): void {
    this.check('a');
    this.check('b');
  }

  viaFirst(): void {
    this.check('a');
  }

  viaSecond(): void {
    this.check('b');
  }

  // Two paths reach the same helper with different literals.
  chained(): void {
    this.viaFirst();
    this.viaSecond();
  }

  moduleKindA(): void {
    ensureKind('a');
  }

  noop(): number {
    return 1;
  }
}
