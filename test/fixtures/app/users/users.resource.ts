import { UserView } from './users.dto';

export class UserResource {
  transform(user: any): UserView {
    return user;
  }
}

export class UserListResource {
  transform(user: any): UserView {
    return user;
  }
}
