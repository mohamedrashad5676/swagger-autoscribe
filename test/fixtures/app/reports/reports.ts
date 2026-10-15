import { CallHandler, Controller, ExecutionContext, Get, Injectable, NestInterceptor, SetMetadata, UseInterceptors } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';

export const SERIALIZE_KEY = 'serialize_dto';
export const Serialize = (dto: Function) => SetMetadata(SERIALIZE_KEY, dto);

export class PublicUserDto {
  id!: string;
  displayName!: string;
}

export interface ApiResponse<T> {
  success: boolean;
  result: T;
}

@Injectable()
export class EnvelopeInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(_ctx: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T>> {
    return next.handle().pipe(map((result) => ({ success: true, result })));
  }
}

@Injectable()
export class WrapInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(map((data) => ({ data, generatedAt: 'now' })));
  }
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(tap(() => undefined));
  }
}

class Mapper {
  toDto(x: { id: string; first: string }): { id: string; fullName: string } {
    return { id: x.id, fullName: x.first };
  }
}

class StatsService {
  async stats() {
    return { count: 1, labels: ['a'] };
  }
}

@Controller('reports')
@UseInterceptors(LoggingInterceptor)
export class ReportsController {
  private readonly svc = new StatsService();
  private readonly mapper = new Mapper();

  @Get('generic')
  @UseInterceptors(EnvelopeInterceptor)
  generic() {
    return this.svc.stats(); // no return type: inferred from the service
  }

  @Get('wrapped')
  @UseInterceptors(WrapInterceptor)
  wrapped(): { total: number } {
    return { total: 1 };
  }

  @Get('both')
  @UseInterceptors(WrapInterceptor, EnvelopeInterceptor)
  both(): { n: number } {
    return { n: 1 };
  }

  @Get('plain')
  plain(): { n: number } {
    return { n: 1 };
  }

  @Get('mapped')
  mapped() {
    return this.mapper.toDto({ id: '1', first: 'A' }); // mapper method, no annotation
  }

  @Get('serialized')
  @Serialize(PublicUserDto)
  serialized(): any {
    return {};
  }

  @Get('serialized-list')
  @Serialize(PublicUserDto)
  serializedList(): PublicUserDto[] {
    return [];
  }
}
