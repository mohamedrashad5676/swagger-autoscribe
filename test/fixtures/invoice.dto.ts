import { IsString } from 'class-validator';

export type TaxType = 'PERCENTAGE' | 'FIXED';

export class CreateInvoiceTaxNestedDto {
  @IsString()
  taxType!: TaxType;
  value!: number;
}
export class CreateInvoiceItemNestedDto {
  description!: string;
  quantity!: number;
}
export class CreateInvoicesDto {
  taxes!: CreateInvoiceTaxNestedDto[];
  items!: CreateInvoiceItemNestedDto[];
}
export class EntitlementValuesDto { numericValue?: number; periodStart?: Date }
export class SettingValueDto { key!: string }
export class UsageValuesDto { numericValue?: number }
export class MembersDto { entitlements!: EntitlementValuesDto[]; settings!: SettingValueDto[] }
export class UpdateUserAccountsDto { members!: MembersDto[]; entitlements!: EntitlementValuesDto[]; usages!: UsageValuesDto[]; settings!: SettingValueDto[] }
