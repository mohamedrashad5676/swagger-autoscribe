import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'required_permissions';
export const RequirePermissions = (...p: string[]) => SetMetadata(PERMISSIONS_KEY, p);

export const RESOURCE_KEY = 'resource_class';
export const Resource = (cls: Function) => SetMetadata(RESOURCE_KEY, cls);

export class QueryOptions {
  page?: number;
  limit?: number;
  search?: string;
}
