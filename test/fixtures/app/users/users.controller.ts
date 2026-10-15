import {
  All,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseArrayPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { Observable, of } from 'rxjs';
import { Public, QueryOptions, RequirePermissions, Resource } from '../common/decorators';
import { BetaGuard } from '../common/guards';
import { CreateUserDto, PagedUsers, UpdateUserDto, UserView } from './users.dto';
import { UserListResource, UserResource } from './users.resource';
import { UsersService } from './users.service';

/** Internal diagnostics, not part of the public API. @swagger-ignore */
@Controller('internal')
export class InternalController {
  @Get('ping')
  ping() {
    return { pong: true };
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' as const, uptime: 123 };
  }

  @Get()
  @Resource(UserListResource)
  list(@Query() q: QueryOptions, @Query('role') role?: string) {
    void q;
    void role;
    return [];
  }

  @Get('paged')
  async paged(@Query() q: QueryOptions): Promise<PagedUsers> {
    void q;
    return { items: [], total: 0 };
  }

  @ApiOperation({ description: 'Written by hand.' })
  @Get('manual')
  manual() {
    return { ok: true };
  }

  @Get('stream')
  stream(): Observable<UserView[]> {
    return of([]);
  }

  @Get(['alias-a', 'alias-b'])
  aliases(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }

  @Get(':id')
  @Resource(UserResource)
  get(@Param('id') id: string) {
    return this.users.get(id);
  }

  @Post()
  @RequirePermissions('users.create')
  async create(@Body() dto: CreateUserDto): Promise<UserView> {
    return this.users.create(dto) as Promise<UserView>;
  }

  @Post('bulk')
  async bulk(@Body() items: CreateUserDto[]): Promise<{ created: number }> {
    void items;
    return { created: 0 };
  }

  @Post('bulk-pipe')
  async bulkPipe(@Body(new ParseArrayPipe({ items: CreateUserDto })) items: CreateUserDto[]): Promise<{ created: number }> {
    void items;
    return { created: 0 };
  }

  @Post('partial')
  async partial(@Body() body: Pick<CreateUserDto, 'email' | 'name'>): Promise<void> {
    void body;
  }

  @Post('inline')
  async inline(@Body() body: { idempotencyKey?: string; amount: number }): Promise<{ started: boolean }> {
    void body;
    return { started: true };
  }

  @Post('fields')
  async fields(@Body('email') email: string, @Body('age') age?: number): Promise<void> {
    void email;
    void age;
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() dto: UpdateUserDto): Promise<UserView> {
    void dto;
    return this.users.get(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<void> {
    await this.users.quota();
    void id;
  }

  @All('any')
  anything(): { any: true } {
    return { any: true };
  }

  // @swagger-ignore
  @Get('debug')
  debug() {
    return { debug: true };
  }

  @UseGuards(BetaGuard)
  @Get('beta')
  beta(): { beta: boolean } {
    return { beta: true };
  }
}
