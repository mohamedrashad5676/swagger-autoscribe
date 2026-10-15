import { Body, Controller, Module, Post } from '@nestjs/common';
import { IsString } from 'class-validator';
export class CreateItemDto { @IsString() name!: string; @IsString() label!: string; }
export interface ItemView { id: number; label: string }
@Controller('b-items')
export class ItemsController {
  @Post() make(@Body() dto: CreateItemDto): ItemView { return { id: 1, label: dto.label }; }
}
@Module({ controllers: [ItemsController] })
export class ItemsModule {}
