import 'reflect-metadata';
import { Controller, Get, Module, Query, SetMetadata, UseGuards, UseInterceptors, CanActivate, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ApiOkResponse, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { APP_GUARD } from '@nestjs/core';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum UserSort { CreatedAt = 'createdAt', Name = 'name' }
export enum Direction { Asc = 'asc', Desc = 'desc' }

export class ListUsersQuery {
  @ApiPropertyOptional({ default: 1, minimum: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
  @ApiPropertyOptional({ enum: UserSort }) @IsOptional() @IsEnum(UserSort) sortBy?: UserSort;
  @ApiPropertyOptional({ enum: Direction }) @IsOptional() @IsEnum(Direction) order?: Direction;
  @ApiPropertyOptional() @IsOptional() @IsString() search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() role?: string;
}
export class OffsetQuery {
  @ApiPropertyOptional({ default: 0 }) @IsOptional() @Type(() => Number) @IsInt() offset?: number;
  @ApiPropertyOptional({ default: 50, maximum: 200 }) @IsOptional() @Type(() => Number) @IsInt() limit?: number;
}
export class FeedQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ default: 10 }) @IsOptional() @Type(() => Number) @IsInt() take?: number;
}
export class UserDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
}
export class UsersPage {
  @ApiProperty({ type: [UserDto] }) data!: UserDto[];
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty() page!: number;
}
export class FeedPage {
  @ApiProperty({ type: [UserDto] }) items!: UserDto[];
  @ApiProperty() nextCursor!: string;
  @ApiProperty() hasMore!: boolean;
}
export class PingQuery {
  @ApiPropertyOptional() @IsOptional() @IsString() verbose?: string;
}

// Stands in for @nestjs/cache-manager's CacheInterceptor (same name, same metadata keys) so no cache backend is needed.
class CacheInterceptor implements NestInterceptor {
  intercept(_c: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}
const CacheTTL = (ttl: number) => SetMetadata('cache_module:cache_ttl', ttl);
const CacheKey = (key: string) => SetMetadata('cache_module:cache_key', key);

class AdminGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
const Permissions = (...p: string[]) => SetMetadata('permissions', p);

@Controller('users')
class UsersController {
  @Get()
  @Permissions('users:read')
  @ApiOkResponse({ type: UsersPage })
  list(@Query() _q: ListUsersQuery): UsersPage {
    return { data: [], total: 0, totalPages: 0, page: 1 };
  }

  @Get('cached')
  @UseInterceptors(CacheInterceptor)
  @CacheTTL(30)
  @CacheKey('users-cached')
  @ApiOkResponse({ type: UserDto })
  cached(): UserDto {
    return { id: '1', name: 'a' };
  }

  @Get('cached-default')
  @UseInterceptors(CacheInterceptor)
  @ApiOkResponse({ type: UserDto })
  cachedDefault(): UserDto {
    return { id: '1', name: 'a' };
  }

  @Get('slow')
  @Throttle({ default: { limit: 2, ttl: 1000 } })
  @UseGuards(AdminGuard)
  @ApiOkResponse({ type: UserDto })
  slow(): UserDto {
    return { id: '1', name: 'a' };
  }
}

@Controller('logs')
class LogsController {
  @Get()
  @ApiOkResponse({ type: [UserDto] })
  list(@Query() _q: OffsetQuery): UserDto[] {
    return [];
  }
}

@Controller('feed')
class FeedController {
  @Get()
  @ApiOkResponse({ type: FeedPage })
  list(@Query() _q: FeedQuery): FeedPage {
    return { items: [], nextCursor: '', hasMore: false };
  }
}

@Controller('ping')
class PingController {
  @Get()
  @ApiOkResponse({ type: UserDto })
  ping(@Query() _q: PingQuery): UserDto {
    return { id: '1', name: 'a' };
  }
}

@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 100 }])],
  controllers: [UsersController, LogsController, FeedController, PingController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class ListingModule {}
