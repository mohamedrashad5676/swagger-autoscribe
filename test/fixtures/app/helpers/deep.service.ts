import { Controller, Get, Injectable } from '@nestjs/common';
import { UserRow, mapUser, ping, toDto } from './mappers';

@Injectable()
export class DeepService {
  private readonly row: UserRow = { id: '1', first: 'A', last: 'B', age: 20 };

  // `Promise<any>` + untyped repository: only the mapper call reveals the shape
  async one(): Promise<any> {
    const raw: any = this.row;
    return mapUser(raw);
  }

  async many(): Promise<any> {
    const rows: any = [this.row];
    return rows.map((r: UserRow) => toDto(r));
  }

  async wrapped(): Promise<any> {
    return { user: mapUser(this.row), meta: { page: 1 } };
  }

  async branch(flag: boolean): Promise<any> {
    return flag ? toDto(this.row) : { error: 'nope' };
  }

  async loop(): Promise<any> {
    return ping(1);
  }

  async hopeless(): Promise<any> {
    const x: any = JSON.parse('{}');
    return x;
  }
}

@Controller('deep')
export class DeepController {
  constructor(private readonly svc: DeepService) {}

  @Get('one') one() { return this.svc.one(); }
  @Get('many') many() { return this.svc.many(); }
  @Get('wrapped') wrapped(): Promise<any> { return this.svc.wrapped(); }
  @Get('branch') branch() { return this.svc.branch(true); }
  @Get('loop') loop() { return this.svc.loop(); }
  @Get('hopeless') hopeless() { return this.svc.hopeless(); }
  @Get('direct') direct(): any { return mapUser({ id: '1', first: 'a', last: 'b', age: 1 }); }
}
