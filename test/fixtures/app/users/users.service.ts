import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserView } from './users.dto';

export class OutOfQuotaException extends ForbiddenException {}

@Injectable()
export class UsersRepository {
  async findById(id: string): Promise<UserView> {
    throw new NotFoundException(`User ${id} not found`);
  }
}

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  async get(id: string): Promise<UserView> {
    return this.repo.findById(id);
  }

  async create(dto: unknown): Promise<UserView> {
    void dto;
    throw new ConflictException('Email already registered');
  }

  async quota(): Promise<void> {
    throw new OutOfQuotaException('Quota exceeded for this plan');
  }
}
