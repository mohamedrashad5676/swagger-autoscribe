// Synthetic controller for the normalised-failure tests. Neutral domain only.
import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { OrderService } from './order.service';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get(':id')
  @ApiResponse({ status: 404, description: 'Declared: the order cannot be found' })
  find(@Param('id') id: string) {
    return this.orderService.find(id);
  }

  @Post('kind-a')
  kindA() {
    return this.orderService.kindA();
  }

  @Post('kind-b')
  kindB() {
    return this.orderService.kindB();
  }

  @Post('kind-unknown')
  kindUnknown() {
    return this.orderService.kindUnknown('a');
  }

  @Post('both-kinds')
  bothKinds() {
    return this.orderService.bothKinds();
  }

  @Post('chained')
  chained() {
    return this.orderService.chained();
  }

  @Post('module-kind-a')
  moduleKindA() {
    return this.orderService.moduleKindA();
  }

  // Explicitly declared status with nothing in the source producing it.
  @Post('declared-only')
  @ApiResponse({ status: 418, description: 'Declared: teapot' })
  declaredOnly() {
    return this.orderService.noop();
  }

  // Shares the service with `find` but never calls it.
  @Post('sibling')
  sibling() {
    return this.orderService.noop();
  }
}
