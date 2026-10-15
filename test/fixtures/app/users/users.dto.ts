import { PartialType } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Matches, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum Role {
  Admin = 'admin',
  Member = 'member',
}

export class AddressDto {
  @IsString()
  city!: string;

  @IsOptional()
  @IsString()
  zip?: string;
}

export class CreateUserDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsInt()
  age!: number;

  @IsEnum(Role)
  role!: Role;

  @Matches(/^\d{6}$/)
  otp!: string;

  @ValidateNested()
  @Type(() => AddressDto)
  address!: AddressDto;

  @IsOptional()
  nickname?: string | null;

  tags!: string[];

  settings!: Record<string, string>;

  isActive!: boolean;

  paid!: boolean;

  createdAt!: Date;
}

// mapped-type mixin — every property comes from a MAPPED type (no valueDeclaration)
export class UpdateUserDto extends PartialType(CreateUserDto) {}

export interface UserView {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: Date;
  deletedAt: Date | null;
  address?: { city: string; zip?: string };
  badges: Array<{ code: string; level: 1 | 2 | 3 }>;
}

export interface PagedUsers {
  items: UserView[];
  total: number;
}

export class CircularCategoryDto {
  name!: string;
  children!: CircularCategoryDto[];
}
