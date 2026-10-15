import { Body, Controller, Module, Post } from '@nestjs/common';
import { IsInt, IsString } from 'class-validator';
export class CreateItemDto { @IsString() name!: string; @IsInt() weight!: number; }
export interface ItemView { id: number; weight: number }
@Controller('a-items')
export class ItemsController {
  @Post() make(@Body() dto: CreateItemDto): ItemView { return { id: 1, weight: dto.weight }; }
}
@Module({ controllers: [ItemsController] })
export class ItemsModule {}
