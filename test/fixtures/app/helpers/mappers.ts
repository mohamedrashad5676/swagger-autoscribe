export interface UserRow {
  id: string;
  first: string;
  last: string;
  age: number;
}

// inferred, typed
export function toDto(u: UserRow) {
  return { id: u.id, fullName: `${u.first} ${u.last}`, adult: u.age >= 18 };
}

// declared `any`, delegates to another helper (2 levels)
export function mapUser(u: UserRow): any {
  return decorate(u);
}

function decorate(u: UserRow) {
  const base = toDto(u);
  return { ...base, tags: ['x'] };
}

// mutual recursion with no types: must terminate
export function ping(x: any): any {
  return pong(x);
}
export function pong(x: any): any {
  return ping(x);
}
