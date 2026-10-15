import {
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MinLength,
} from 'class-validator';
import { deriveValidationMessages } from '../src/errors/validation-messages';

enum Role {
  Admin = 'admin',
  Member = 'member',
}

class SignupBodyDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsInt()
  age!: number;

  @IsEnum(Role)
  role!: Role;

  @Matches(/^[0-9]{11}$/)
  nationalId!: string;

  @IsOptional()
  @IsString()
  nickname?: string;

  @IsEmail({}, { groups: ['signup'] })
  groupedEmail!: string;
}

class CustomMessageDto {
  @IsString({ message: '$property is absolutely required, got $value' })
  username!: string;

  @MinLength(3, { message: 'too short' })
  code!: string;
}

describe('deriveValidationMessages', () => {
  it('derives one message per validator from the DTOs own decorators', () => {
    const messages = deriveValidationMessages(SignupBodyDto);
    expect(messages).toContain('name should not be empty');
    expect(messages).toContain('name must be a string');
    expect(messages).toContain('email must be an email');
    expect(messages).toContain('password must be longer than or equal to 8 characters');
    expect(messages).toContain('age must be an integer number');
    expect(messages).toContain('role must be one of the following values: admin, member');
    expect(messages).toContain('nationalId must match /^[0-9]{11}$/ regular expression');
  });

  it('keeps @IsOptional properties only for their value validators', () => {
    const messages = deriveValidationMessages(SignupBodyDto);
    // @IsOptional() itself never fails — but a PROVIDED non-string nickname
    // still fails @IsString(), exactly like the real pipe behaves.
    expect(messages).toContain('nickname must be a string');
    // Grouped validators never run under a global (groupless) pipe.
    expect(messages.some((m) => m.startsWith('groupedEmail'))).toBe(false);
  });

  it('honors custom string messages with token substitution', () => {
    const messages = deriveValidationMessages(CustomMessageDto);
    expect(messages).toContain('username is absolutely required, got <username>');
    expect(messages).toContain('too short');
  });

  it('returns nothing for a class with no validators', () => {
    class Empty {}
    expect(deriveValidationMessages(Empty)).toEqual([]);
  });
});
