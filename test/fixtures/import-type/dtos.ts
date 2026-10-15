import { IsInt, IsOptional, IsString, IsUUID } from 'class-validator';
export class ItBody {
  @IsString() name!: string;
}
export class ItResponse {
  @IsString() id!: string;
}
export interface ItIface {
  id: string;
  total: number;
}
export class ItQuery {
  @IsOptional() @IsInt() page?: number;
  @IsOptional() @IsString() search?: string;
}
export class ItParams {
  @IsUUID() id!: string;
}
