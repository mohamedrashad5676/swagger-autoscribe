import { Controller, Get, Param, Version } from '@nestjs/common';

@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  @Get(':id')
  one(@Param('id') id: string): { id: string; total: number } {
    return { id, total: 1 };
  }

  @Version('2')
  @Get(':id')
  oneV2(@Param('id') id: string): { id: string; total: number; currency: string } {
    return { id, total: 1, currency: 'USD' };
  }
}
