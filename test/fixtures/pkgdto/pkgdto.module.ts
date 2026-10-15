import { Body, Controller, Get, Module, Patch, Post, Query } from '@nestjs/common';
import { CreateThingDto, ListThingsQuery } from '@acme/shared';
import type { ThingView, UpdateThingDto } from '@acme/shared';

@Controller('pkg-things')
export class PkgThingsController {
  @Post()
  create(@Body() dto: CreateThingDto): ThingView {
    return { id: '1', name: dto.name, quantity: 1 };
  }

  // type-only import: the runtime sees an erased type
  @Patch(':id')
  update(@Body() dto: UpdateThingDto): ThingView {
    return { id: '1', name: dto.name ?? '', quantity: 1 };
  }

  @Get()
  list(@Query() q: ListThingsQuery): ThingView[] {
    void q;
    return [];
  }
}

@Module({ controllers: [PkgThingsController] })
export class PkgDtoModule {}
