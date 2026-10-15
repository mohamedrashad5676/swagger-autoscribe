import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import type { ItQuery, ItBody, ItParams, ItResponse, ItIface } from './dtos';

@Controller('it')
export class ItController {
  @Post()
  create(@Body() _b: ItBody): Promise<ItResponse> {
    return null as any;
  }
  @Get('list')
  list(@Query() _q: ItQuery): Promise<ItIface> {
    return null as any;
  }
  @Get(':id')
  one(@Param() _p: ItParams): Promise<ItIface[]> {
    return null as any;
  }
}
@Module({ controllers: [ItController] })
export class M {}

